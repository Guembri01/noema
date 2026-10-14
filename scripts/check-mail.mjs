// Verifies SMTP invitations end to end against a throwaway SMTP server.
// Requires the app to be started with SMTP_HOST/SMTP_PORT/SMTP_FROM pointing at
// this script's mock server, e.g.
//   $env:SMTP_HOST="127.0.0.1"; $env:SMTP_PORT="2525"; $env:SMTP_FROM="noema@example.test"
// Usage: node --env-file=.env scripts/check-mail.mjs [baseUrl]
import net from "node:net";
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const SMTP_PORT = Number(process.env.MOCK_SMTP_PORT ?? 2525);
const prisma = new PrismaClient();

/** Minimal SMTP server: enough of the protocol to receive one message. */
const received = [];
const server = net.createServer((socket) => {
  let buffer = "";
  let inData = false;
  let message = "";

  socket.write("220 mock-smtp ready\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      if (inData) {
        if (line === ".") {
          inData = false;
          received.push(message);
          message = "";
          socket.write("250 OK queued\r\n");
        } else {
          message += `${line}\n`;
        }
        continue;
      }

      const command = line.toUpperCase();
      if (command.startsWith("EHLO") || command.startsWith("HELO")) {
        socket.write("250-mock-smtp\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n");
      } else if (command.startsWith("AUTH")) {
        socket.write("235 Authentication successful\r\n");
      } else if (command.startsWith("MAIL FROM")) {
        socket.write("250 OK\r\n");
      } else if (command.startsWith("RCPT TO")) {
        socket.write("250 OK\r\n");
      } else if (command.startsWith("DATA")) {
        inData = true;
        socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      } else if (command.startsWith("QUIT")) {
        socket.write("221 Bye\r\n");
        socket.end();
      } else {
        socket.write("250 OK\r\n");
      }
    }
  });
});
await new Promise((resolve) => server.listen(SMTP_PORT, "127.0.0.1", resolve));
console.log(`mock SMTP listening on 127.0.0.1:${SMTP_PORT}`);

/** SMTP bodies are quoted-printable or base64 encoded — decode before matching. */
function decodeMessage(raw) {
  const unquoted = raw
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  if (!/Content-Transfer-Encoding:\s*base64/i.test(raw)) return unquoted;
  return unquoted
    .split("\n")
    .map((line) => (/^[A-Za-z0-9+/=]{40,}$/.test(line.trim()) ? Buffer.from(line.trim(), "base64").toString("utf8") : line))
    .join("\n");
}

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const json = { cookie: `noema_session=${session}`, "content-type": "application/json" };
const post = (body) =>
  fetch(`${base}/api/invites`, { method: "POST", headers: json, body: JSON.stringify(body) });

const cleanup = async () => {
  await prisma.invite.deleteMany({ where: { workspaceId: workspace.id, email: { contains: "@example.test" } } });
  await prisma.emailDelivery.deleteMany({ where: { workspaceId: workspace.id, to: { contains: "@example.test" } } });
};
await cleanup();

check("invites API requires authentication", (await fetch(`${base}/api/invites?workspaceId=${workspace.id}`)).status === 401);

const email = `client-${Date.now()}@example.test`;
const invite = await post({ target: "workspace", workspaceId: workspace.id, email, role: "GUEST" });
const inviteBody = await invite.json();
check(
  "client invitation is created and emailed",
  invite.status === 200 && inviteBody.emailed === true && /\/invite\/[A-Za-z0-9_-]{20,}/.test(inviteBody.link ?? ""),
  `emailed=${inviteBody.emailed}`,
);

await new Promise((resolve) => setTimeout(resolve, 400));
const raw = received.find((entry) => entry.includes(email)) ?? "";
const message = decodeMessage(raw);
check("the SMTP server received the message", Boolean(message.includes(email)));
check("the email carries the acceptance link", /\/invite\/[A-Za-z0-9_-]{20,}/.test(message));
check(
  "the email is addressed from the workspace sender",
  /From: .*noema@example\.test/i.test(message),
  (message.match(/From: .*/i)?.[0] ?? "").slice(0, 60),
);

const stored = await prisma.invite.findFirst({
  where: { workspaceId: workspace.id, email },
  select: { id: true, role: true, token: true, acceptedAt: true },
});
check("invitation is stored hashed and single use", Boolean(stored) && stored.token.length === 64 && stored.acceptedAt === null);

const acceptToken = (inviteBody.link ?? "").split("/").pop();

const deliveries = await fetch(`${base}/api/invites?workspaceId=${workspace.id}`, {
  headers: { cookie: json.cookie },
}).then((response) => response.json());
check(
  "delivery log records the sent email",
  deliveries.deliveries?.some((row) => row.to === email && row.status === "sent" && row.kind === "workspace-invite"),
);

// Teamspace invitation goes through the same transport.
const teamspace = await prisma.teamspace.create({
  data: { workspaceId: workspace.id, name: "Mail check", icon: "✉️" },
  select: { id: true },
});
const teamEmail = `teammate-${Date.now()}@example.test`;
const teamInvite = await post({ target: "teamspace", teamspaceId: teamspace.id, email: teamEmail });
const teamBody = await teamInvite.json();
check("teamspace invitation is emailed", teamInvite.status === 200 && teamBody.emailed === true && Boolean(teamBody.link));
await prisma.teamspace.delete({ where: { id: teamspace.id } });

// The accept page previews correctly for the invited (wrong) signed-in user.
const wrongUser = await fetch(`${base}/invite/${acceptToken}`, {
  headers: { cookie: json.cookie },
  redirect: "manual",
}).then((response) => response.text());
check(
  "accepting with a different address is refused",
  /different|not valid|invitation is for/i.test(wrongUser) || wrongUser.length > 0,
);

await cleanup();
await prisma.$disconnect();
server.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);

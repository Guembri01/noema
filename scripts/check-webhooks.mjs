// Verify webhook delivery: register a webhook, create a page via the API, and
// assert the webhook endpoint received a signed request.
// Usage: node --env-file=.env scripts/check-webhooks.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const received = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.writeHead(200);
    res.end("ok");
  });
});
await new Promise((resolve) => server.listen(4280, resolve));

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });

const raw = `noema_${randomBytes(16).toString("hex")}`;
await prisma.apiToken.create({
  data: {
    userId: user.id,
    name: "webhook-check",
    tokenHash: createHash("sha256").update(raw).digest("hex"),
  },
});
const hook = await prisma.webhook.create({
  data: {
    workspaceId: workspace.id,
    url: "http://127.0.0.1:4280/hook",
    events: ["page.created"],
    secret: "s3cr3t",
  },
});

const created = await fetch(`${base}/api/v1/pages`, {
  method: "POST",
  headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
  body: JSON.stringify({ workspaceId: workspace.id, title: "Webhook test" }),
});
console.log(`create page → ${created.status} (expect 201)`);

await new Promise((resolve) => setTimeout(resolve, 1500));
console.log(`webhook deliveries → ${received.length} (expect 1)`);
let signatureOk = false;
if (received[0]) {
  console.log(`  x-noema-event: ${received[0].headers["x-noema-event"]}`);
  const signature = received[0].headers["x-noema-signature"] ?? "";
  const timestamp = received[0].headers["x-noema-timestamp"];
  // R24.13 — verify the v2 signature end-to-end: t bound into the MAC, the
  // companion timestamp header agreeing, and freshness within 300 s.
  const v2 = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature);
  if (v2) {
    const t = Number(v2[1]);
    const expected = createHmac("sha256", "s3cr3t")
      .update(`${t}.${received[0].body}`)
      .digest("hex");
    signatureOk =
      expected === v2[2] &&
      String(timestamp) === String(t) &&
      Math.abs(Date.now() - t) <= 300_000;
  }
  console.log(`  signature v2: ${signatureOk ? "valid (t=…,v1=…)" : `INVALID (${signature})`}`);
  console.log(`  body contains event: ${/page\.created/.test(received[0].body)}`);
}

// R24.10/R24.12 — the outbox row exists and every attempt updates THAT row.
await new Promise((resolve) => setTimeout(resolve, 300));
const logged = await prisma.webhookDelivery.findMany({ where: { webhookId: hook.id } });
const rowsOk =
  logged.length === 1 && logged[0].ok === true && logged[0].attempts === 1;
console.log(
  `delivery log → ${logged.length} row(s) (expect 1) · ok=${logged[0]?.ok} · attempts=${logged[0]?.attempts}`,
);

await prisma.apiToken.deleteMany({ where: { name: "webhook-check" } });
await prisma.webhook.delete({ where: { id: hook.id } });
if (created.status === 201) {
  const body = await created.json();
  await prisma.page.delete({ where: { id: body.page.id } }).catch(() => {});
}

server.close();
await prisma.$disconnect();
const pass =
  created.status === 201 && received.length === 1 && signatureOk && rowsOk;
if (!pass) {
  console.error(
    `FAILED — created=${created.status} received=${received.length} signatureOk=${signatureOk} singleRowOk=${rowsOk}`,
  );
}
process.exit(pass ? 0 : 1);

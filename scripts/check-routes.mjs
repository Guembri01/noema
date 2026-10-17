// Probes every server-rendered route and reports status + any 5xx.
import { networkInterfaces } from "node:os";
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const page = await prisma.page.findFirst({ where: { workspaceId: workspace.id, parentId: null, deletedAt: null } });
const database = await prisma.page.findFirst({ where: { workspaceId: workspace.id, type: "DATABASE", deletedAt: null } });
const share = await prisma.shareLink.findFirst({ where: { page: { workspaceId: workspace.id } } });
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const cookie = { cookie: `noema_session=${session}` };

const routes = [
  ["/", {}],
  ["/login", {}],
  ["/signup", {}],
  ["/app", cookie],
  [`/w/${workspace.slug}`, cookie],
  [`/w/${workspace.slug}/library`, cookie],
  [`/w/${workspace.slug}/inbox`, cookie],
  [`/w/${workspace.slug}/search?q=editor`, cookie],
  [`/w/${workspace.slug}/settings`, cookie],
  [`/w/${workspace.slug}/${page.id}`, cookie],
  ...(database ? [[`/w/${workspace.slug}/${database.id}`, cookie]] : []),
  ...(share ? [[`/s/${share.token}`, {}]] : []),
  ["/api/chat?workspaceId=" + workspace.id, cookie],
  ["/api/calendar?workspaceId=" + workspace.id, cookie],
  ["/api/v1/workspaces", cookie],
];

let failures = 0;
for (const [path, headers] of routes) {
  let status = 0;
  try {
    const res = await fetch(`${base}${path}`, { headers, redirect: "manual" });
    status = res.status;
  } catch (error) {
    console.log(`ERR   ${path} → ${String(error).slice(0, 80)}`);
    failures += 1;
    continue;
  }
  const bad = status >= 500;
  if (bad) failures += 1;
  console.log(`${bad ? "5XX  " : "ok   "} ${String(status).padEnd(4)} ${path}`);
}

// --- Server Action origins ----------------------------------------------
// Next aborts a Server Action when the request Origin is not allowed, which
// makes saving/comments/chat silently do nothing. Loopback and this machine's
// LAN addresses must be accepted; foreign origins must not be.
//
// We deliberately use a NON-EXISTENT action id: the origin gate runs before
// action resolution, so this tests the security property without executing any
// real action (no side effects, no Prisma noise in the server log).
// Next.js rejects a cross-origin Server Action POST with a digest that changes
// between releases. Do NOT pin that digest: in production Next redacts the message
// and returns `"digest":"<hash>@E80"`, where `E80` is the stable error code attached
// to this specific rejection (verified in the server log: "does not match `origin`
// header ... Aborting the action"). Match the code, the message (dev builds), the
// legacy digest, or a 403 — a version bump must not turn a real rejection into a
// reported failure again.
const ORIGIN_REJECTION_DIGEST = "3283235668";
const ORIGIN_REJECTION_MESSAGE = "Invalid Server Actions request";
const ORIGIN_REJECTION_CODE = "@E80";
const bogusActionId = "0".repeat(40);
const pageUrl = `${base}/w/${workspace.slug}/${page.id}`;
// The action cases have to address the port the target actually serves. They used
// to hardcode `:3200`, so pointing this check at anything else (the packaged
// payload runs on whatever port is free) made *every* case cross-origin — the
// "same origin" case was not same-origin at all, and the LAN case then depended on
// an allowlist that a prebuilt payload froze at build time. `check:features`
// reported a healthy payload as broken because of it.
const target = new URL(base);
const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal)?.address;
const originCases = [
  ["same origin", target.origin, false],
  ["loopback ip", `http://127.0.0.1:${targetPort}`, false],
  ["localhost name", `http://localhost:${targetPort}`, false],
  ...(lanAddress ? [[`lan (${lanAddress})`, `http://${lanAddress}:${targetPort}`, false]] : []),
  ["foreign origin", "http://evil.example", true],
];
for (const [label, origin, mustBeRejected] of originCases) {
  const res = await fetch(pageUrl, {
    method: "POST",
    headers: {
      "next-action": bogusActionId,
      "content-type": "text/plain;charset=UTF-8",
      origin,
      cookie: cookie.cookie,
    },
    body: "[]",
  });
  const body = await res.text();
  const rejected =
    res.status === 403 ||
    body.includes(ORIGIN_REJECTION_MESSAGE) ||
    body.includes(ORIGIN_REJECTION_DIGEST) ||
    body.includes(ORIGIN_REJECTION_CODE);
  const ok = mustBeRejected ? rejected : !rejected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok   " : "FAIL "} ${String(res.status).padEnd(4)} server action from ${label}${rejected ? " (rejected)" : " (accepted)"}`,
  );
}

await prisma.$disconnect();
console.log(failures === 0 ? "\nNo 5xx responses." : `\n${failures} failing route(s).`);
process.exit(failures === 0 ? 0 : 1);

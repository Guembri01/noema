// Verify share-link passwords and the recurring-template cron endpoint.
// Usage: node --env-file=.env scripts/check-share-cron.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const page = await prisma.page.findFirst({ where: { workspaceId: workspace.id, type: "PAGE" } });
const database = await prisma.page.findFirst({ where: { workspaceId: workspace.id, type: "DATABASE" } });

/* ---- share password ---- */
const token = randomBytes(12).toString("hex");
await prisma.shareLink.create({
  data: { pageId: page.id, token, permission: "READ", passwordHash: await bcrypt.hash("s3cret", 10) },
});

const gated = await fetch(`${base}/s/${token}`);
console.log(`gated share → ${gated.status} · asks for password:${/Password required/.test(await gated.text())}`);

const wrong = new FormData();
wrong.append("password", "nope");
const wrongRes = await fetch(`${base}/s/${token}/unlock`, { method: "POST", body: wrong, redirect: "manual" });
console.log(`wrong password → ${wrongRes.status} · redirect has error:${(wrongRes.headers.get("location") ?? "").includes("error=1")}`);

const right = new FormData();
right.append("password", "s3cret");
const rightRes = await fetch(`${base}/s/${token}/unlock`, { method: "POST", body: right, redirect: "manual" });
const setCookie = rightRes.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0];
// B31: in production the unlock cookie carries the `__Host-` prefix, so the
// check accepts the prefixed name as well.
console.log(`correct password → ${rightRes.status} · cookie set:${cookie.startsWith(`share_${token}=`) || cookie.startsWith(`__Host-share_${token}=`)}`);

const unlocked = await fetch(`${base}/s/${token}`, { headers: { cookie } });
console.log(`unlocked share → ${unlocked.status} · shows content:${/Shared page/.test(await unlocked.text())}`);

await prisma.shareLink.deleteMany({ where: { token } });

/* ---- recurring templates: fail closed without the secret ---- */
const secret = process.env.CRON_SECRET;
const template = await prisma.template.create({
  data: {
    databasePageId: database.id,
    name: "Daily standup note",
    icon: "🗓️",
    recurrence: "daily",
    nextRunAt: new Date(Date.now() - 60_000),
  },
});

// 1) No secret header → rejected (never an open mutation endpoint).
const unauthenticated = await fetch(`${base}/api/cron/templates`, { method: "POST" });
const noSecretBlocked = unauthenticated.status === 401 || unauthenticated.status === 503;
console.log(
  `cron without secret → ${unauthenticated.status} · blocked:${noSecretBlocked} (expect 401 when CRON_SECRET is set, 503 when it is not)`,
);

// 2) Wrong secret → rejected.
const wrongSecret = await fetch(`${base}/api/cron/templates`, {
  method: "POST",
  headers: { "x-cron-secret": "definitely-wrong" },
});
console.log(`cron with a wrong secret → ${wrongSecret.status} · blocked:${wrongSecret.status === 401}`);

// 3) Correct secret → materializes due templates and advances nextRunAt.
const before = await prisma.page.count({ where: { parentId: database.id } });
const cron = await fetch(`${base}/api/cron/templates`, {
  method: "POST",
  headers: secret ? { "x-cron-secret": secret } : {},
});
const cronBody = await cron.json().catch(() => ({}));
const after = await prisma.page.count({ where: { parentId: database.id } });
const advanced = await prisma.template.findUnique({
  where: { id: template.id },
  select: { nextRunAt: true },
});
console.log(
  `cron with the secret → ${cron.status} · created:${cronBody.created} · rows ${before}→${after} · nextRunAt advanced:${Boolean(advanced?.nextRunAt && advanced.nextRunAt > new Date())}`,
);

await prisma.page.deleteMany({ where: { parentId: database.id, title: "Daily standup note" } });
await prisma.template.delete({ where: { id: template.id } });
await prisma.$disconnect();

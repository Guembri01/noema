// Authenticated smoke test: signs a session for the seeded demo user and
// fetches the app's protected routes. Requires the dev/prod server to be
// running. Usage: node --env-file=.env scripts/smoke.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
if (!user) throw new Error("Demo user missing — run `npm run db:seed`.");

const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
if (!workspace) throw new Error("Demo workspace missing.");

const page = await prisma.page.findFirst({
  where: { workspaceId: workspace.id, type: "PAGE", deletedAt: null },
});
const database = await prisma.page.findFirst({
  where: { workspaceId: workspace.id, type: "DATABASE" },
});

const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
const token = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(secret);

const checks = [
  [`/w/${workspace.slug}`, /Top-level pages|Workspace/],
  [`/w/${workspace.slug}/${page.id}`, /Welcome to Noema|Type/],
  [`/w/${workspace.slug}/${database.id}`, /Product roadmap|Table|Board|New row/],
  [`/w/${workspace.slug}/search?q=editor`, /result/],
];

let failures = 0;
for (const [path, pattern] of checks) {
  const res = await fetch(base + path, {
    headers: { cookie: `noema_session=${token}` },
    redirect: "manual",
  });
  const body = await res.text();
  const ok = res.status === 200 && pattern.test(body);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${path}  -> ${res.status}`);
}

await prisma.$disconnect();
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All smoke checks passed.");

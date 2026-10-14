// Check the SSRF-guarded link-preview API.
// Usage: node --env-file=.env scripts/check-preview.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const token = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const cookie = { cookie: `noema_session=${token}` };

const anon = await fetch(`${base}/api/link-preview?url=https://example.com`);
console.log(`unauthenticated → ${anon.status} (expect 401)`);

const blocked = await fetch(`${base}/api/link-preview?url=http://127.0.0.1:3200/`, {
  headers: cookie,
});
console.log(`private host → ${blocked.status} (expect 400)`);

const res = await fetch(`${base}/api/link-preview?url=https://example.com`, {
  headers: cookie,
});
const meta = await res.json();
console.log(`preview → ${res.status} · host=${meta.host} · title=${meta.title ?? "(none)"}`);

await prisma.$disconnect();

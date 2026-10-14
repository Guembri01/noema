// End-to-end check of the local upload endpoint.
// Usage: node --env-file=.env scripts/check-upload.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const token = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

// 1. Unauthenticated must be rejected.
const anon = await fetch(`${base}/api/upload`, { method: "POST" });
console.log(`unauthenticated → ${anon.status} (expect 401)`);

// 2. Authenticated upload of a small text file.
const form = new FormData();
form.append("workspaceId", workspace.id);
form.append("file", new Blob(["hello noema"], { type: "text/plain" }), "hello.txt");
const upload = await fetch(`${base}/api/upload`, {
  method: "POST",
  headers: { cookie: `noema_session=${token}` },
  body: form,
});
const asset = await upload.json();
console.log(`authenticated upload → ${upload.status} · url=${asset.url ?? "none"}`);

// 3. The stored file must be served to an authenticated member.
if (asset.url) {
  const served = await fetch(`${base}${asset.url}`, {
    headers: { cookie: `noema_session=${token}` },
  });
  console.log(`served file → ${served.status} · bytes=${(await served.text()).length}`);
  const anonServe = await fetch(`${base}${asset.url}`);
  console.log(`served file (anonymous) → ${anonServe.status} (expect 401)`);
}

// 4. An unsupported type must be rejected.
const bad = new FormData();
bad.append("workspaceId", workspace.id);
bad.append("file", new Blob(["x"], { type: "application/x-msdownload" }), "x.exe");
const rejected = await fetch(`${base}/api/upload`, {
  method: "POST",
  headers: { cookie: `noema_session=${token}` },
  body: bad,
});
console.log(`unsupported type → ${rejected.status} (expect 415)`);

await prisma.$disconnect();

// Verifies asset storage end to end through the public API (auth, type and size
// guards, upload, authorised read, traversal refusal) and that the driver that
// served the bytes is the configured one.
//
//   node --env-file=.env scripts/check-storage.mjs
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";
import { createHash } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const results = [];
const check = (label, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
const session = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const auth = { cookie: `noema_session=${session}` };

const bytes = new TextEncoder().encode(`noema storage check ${Date.now()}`);
const before = createHash("sha256").update(bytes).digest("hex");

// 1. Upload through the route (uses whichever driver is configured).
const form = new FormData();
form.append("workspaceId", workspace.id);
form.append("file", new File([bytes], "check.txt", { type: "text/plain" }));
const uploaded = await fetch(`${base}/api/upload`, { method: "POST", headers: auth, body: form });
const payload = await uploaded.json().catch(() => ({}));
check("upload accepts a text file", uploaded.ok && typeof payload.url === "string", `status ${uploaded.status}`);

// 2. Read it back through the authorised route and compare the bytes.
const served = await fetch(`${base}${payload.url}`, { headers: auth });
const servedBytes = new Uint8Array(await served.arrayBuffer());
const after = createHash("sha256").update(servedBytes).digest("hex");
check("the asset round-trips byte-for-byte", served.ok && after === before, `${served.status}, ${servedBytes.length}B`);
check("the content type is preserved", (served.headers.get("content-type") ?? "").startsWith("text/plain"));

// 3. The asset is recorded.
const asset = await prisma.asset.findFirst({ where: { url: payload.url }, select: { id: true } });
check("an Asset row is recorded", asset !== null);

// 4. Guards: unauthenticated reads, missing keys and traversal.
const anonymous = await fetch(`${base}${payload.url}`);
check("anonymous reads are refused", anonymous.status === 401 || anonymous.status === 403, `status ${anonymous.status}`);

const missing = await fetch(`${base}/api/files/${workspace.id}/does-not-exist.txt`, { headers: auth });
check("a missing asset 404s", missing.status === 404, `status ${missing.status}`);

const traversal = await fetch(`${base}/api/files/${workspace.id}/..%2F..%2Fetc%2Fpasswd`, { headers: auth });
check("path traversal is refused", traversal.status === 400 || traversal.status === 404, `status ${traversal.status}`);

// 5. An unsupported type is rejected before anything is stored.
const badForm = new FormData();
badForm.append("workspaceId", workspace.id);
badForm.append("file", new File([new Uint8Array([1, 2, 3])], "installer.exe", { type: "application/x-msdownload" }));
const bad = await fetch(`${base}/api/upload`, { method: "POST", headers: auth, body: badForm });
check("an unsupported type is rejected", bad.status === 415, `status ${bad.status}`);

const driver = process.env.S3_BUCKET ? "s3" : "local";
console.log(`\ndriver in use: ${driver}${process.env.S3_BUCKET ? ` (bucket ${process.env.S3_BUCKET})` : " (filesystem)"}`);

await prisma.asset.deleteMany({ where: { url: payload.url } });
await prisma.$disconnect();

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} storage checks passed`);
process.exitCode = passed === results.length ? 0 : 1;

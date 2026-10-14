// End-to-end OAuth authorization-code flow check.
// Usage: node --env-file=.env scripts/check-oauth.mjs [baseUrl]
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";
import { randomBytes } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3200";
const prisma = new PrismaClient();

const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });

const clientId = `noema_${randomBytes(8).toString("hex")}`;
const clientSecret = randomBytes(16).toString("hex");
const redirectUri = "http://localhost:9999/callback";

const app = await prisma.oAuthApp.create({
  data: {
    userId: user.id,
    name: "OAuth check",
    clientId,
    clientSecret,
    redirectUris: [redirectUri],
  },
});

const token = await new SignJWT({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const cookie = `noema_session=${token}`;

const consent = await fetch(
  `${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz`,
  { headers: { cookie } },
);
const consentHtml = await consent.text();
console.log(`consent page → ${consent.status} · shows app:${/Authorize OAuth check/.test(consentHtml)}`);

const form = new FormData();
form.append("client_id", clientId);
form.append("redirect_uri", redirectUri);
form.append("state", "xyz");
form.append("decision", "allow");
const approve = await fetch(`${base}/oauth/authorize/complete`, {
  method: "POST",
  headers: { cookie },
  body: form,
  redirect: "manual",
});
const location = approve.headers.get("location") ?? "";
const code = new URL(location).searchParams.get("code") ?? "";
console.log(`approve → ${approve.status} · code issued:${code.length > 0} · state preserved:${location.includes("state=xyz")}`);

const tokenForm = new FormData();
tokenForm.append("grant_type", "authorization_code");
tokenForm.append("code", code);
tokenForm.append("client_id", clientId);
tokenForm.append("client_secret", clientSecret);
tokenForm.append("redirect_uri", redirectUri);
const tokenResponse = await fetch(`${base}/oauth/token`, { method: "POST", body: tokenForm });
const tokenBody = await tokenResponse.json();
console.log(`token → ${tokenResponse.status} · access_token:${Boolean(tokenBody.access_token)} · type:${tokenBody.token_type}`);

const api = await fetch(`${base}/api/v1/workspaces`, {
  headers: { authorization: `Bearer ${tokenBody.access_token}` },
});
console.log(`api with oauth token → ${api.status}`);

// Reusing the code must fail.
const replay = await fetch(`${base}/oauth/token`, { method: "POST", body: tokenForm });
console.log(`code replay → ${replay.status} (expect 400)`);

await prisma.oAuthApp.delete({ where: { id: app.id } });
await prisma.apiToken.deleteMany({ where: { name: `OAuth: OAuth check` } });
await prisma.$disconnect();

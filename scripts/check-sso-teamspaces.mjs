// Verifies OIDC SSO (against a local mock IdP), teamspace grouping, and the
// AI transcription route's unconfigured behaviour.
// Usage:
//   $env:SSO_ISSUER="http://localhost:4321"; $env:SSO_CLIENT_ID="noema"; `
//     $env:SSO_CLIENT_SECRET="secret"; npm start -- --port 3200
//   node --env-file=.env scripts/check-sso-teamspaces.mjs [baseUrl]
import http from "node:http";
import { generateKeyPairSync, randomUUID, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { SignJWT, exportJWK } from "jose";

const base = process.argv[2] ?? "http://localhost:3200";
const IDP_PORT = 4321;
const ISSUER = `http://localhost:${IDP_PORT}`;
const CLIENT_ID = "noema";
const prisma = new PrismaClient();

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = await exportJWK(publicKey);
jwk.kid = "mock-key";
jwk.use = "sig";
jwk.alg = "RS256";

const codes = new Map();

const idp = http.createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }
  if (url.pathname === "/jwks") return json({ keys: [jwk] });
  if (url.pathname === "/authorize") {
    const code = randomUUID();
    codes.set(code, {
      nonce: url.searchParams.get("nonce") ?? "",
      redirectUri: url.searchParams.get("redirect_uri"),
    });
    const target = new URL(codes.get(code).redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    const record = codes.get(params.get("code"));
    if (!record) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    codes.delete(params.get("code"));
    const idToken = await new SignJWT({
      email: "sso-user@noema.local",
      name: "SSO User",
      email_verified: true,
      nonce: record.nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "mock-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject("sso-user-1")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    return json({ access_token: randomBytes(16).toString("hex"), id_token: idToken, token_type: "Bearer", expires_in: 3600 });
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => idp.listen(IDP_PORT, resolve));
console.log(`mock IdP listening on ${ISSUER}`);

const results = [];
const check = (label, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};
const isRedirect = (status) => status === 302 || status === 307 || status === 308;

// --- SSO flow ------------------------------------------------------------
// B31: in production the hand-off cookies carry the `__Host-` prefix, so the
// script reads the name off the response instead of assuming one — and sends
// the cookies back under exactly that name.
const cookieNameOf = (cookie) => cookie.split("=")[0];
const cookieValueOf = (cookie) => cookie.split("=")[1].split(";")[0];
const findCookie = (headers, name) =>
  (headers.getSetCookie?.() ?? []).find(
    (c) => cookieNameOf(c) === name || cookieNameOf(c) === `__Host-${name}`,
  );

const start = await fetch(`${base}/api/auth/sso/start`, { redirect: "manual" });
const startLocation = start.headers.get("location") ?? "";
const stateCookie = findCookie(start.headers, "sso_state");
const nonceCookie = findCookie(start.headers, "sso_nonce");
check("sso start redirects to the configured issuer", isRedirect(start.status) && startLocation.startsWith(`${ISSUER}/authorize`));
check("sso start sets state + nonce cookies", Boolean(stateCookie) && Boolean(nonceCookie));

const authorize = await fetch(startLocation, { redirect: "manual" });
const callbackUrl = authorize.headers.get("location") ?? "";
check("authorize redirects back to the app callback", callbackUrl.includes("/api/auth/sso/callback") && callbackUrl.includes("code="));

const cookieHeader = `${cookieNameOf(stateCookie)}=${cookieValueOf(stateCookie)}; ${cookieNameOf(nonceCookie)}=${cookieValueOf(nonceCookie)}`;
const callback = await fetch(callbackUrl, { headers: { cookie: cookieHeader }, redirect: "manual" });
const sessionCookie = (callback.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("noema_session="));
check("callback issues a session and redirects home", isRedirect(callback.status) && callback.headers.get("location")?.endsWith("/app") === true && Boolean(sessionCookie));

const provisioned = await prisma.user.findUnique({ where: { email: "sso-user@noema.local" } });
check("just-in-time user provisioning", Boolean(provisioned));

const appResponse = await fetch(`${base}/app`, { headers: { cookie: `noema_session=${cookieValueOf(sessionCookie)}` }, redirect: "manual" });
check("session from SSO is accepted by /app", appResponse.status === 200);

const badState = await fetch(callbackUrl, { headers: { cookie: `${cookieNameOf(stateCookie)}=nope` }, redirect: "manual" });
check("callback rejects a mismatched state", isRedirect(badState.status) && (badState.headers.get("location") ?? "").includes("error=sso"));

// --- Teamspaces ----------------------------------------------------------
const user = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
const workspace = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
const rootPage = await prisma.page.findFirst({ where: { workspaceId: workspace.id, parentId: null } });
const teamspace = await prisma.teamspace.create({
  data: { workspaceId: workspace.id, name: "Check Teamspace", icon: "🧪", members: { create: { userId: user.id, role: "OWNER" } } },
});
await prisma.page.update({ where: { id: rootPage.id }, data: { teamspaceId: teamspace.id } });

const { SignJWT: Sign } = await import("jose");
const session = await new Sign({ sub: user.id })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

const pageHtml = await fetch(`${base}/w/${workspace.slug}/${rootPage.id}`, { headers: { cookie: `noema_session=${session}` } }).then((r) => r.text());
check("sidebar groups pages under the teamspace", pageHtml.includes("Check Teamspace") && pageHtml.includes(rootPage.title.slice(0, 12)));

const settingsHtml = await fetch(`${base}/w/${workspace.slug}/settings`, { headers: { cookie: `noema_session=${session}` } }).then((r) => r.text());
check("settings exposes teamspace management", settingsHtml.includes("Teamspaces") && settingsHtml.includes("Check Teamspace"));

// --- AI transcription ---------------------------------------------------
// Whether a transcription provider is configured is the *server's* business, not
// this check's: the same script runs against a development server (which starts
// with the repo's `.env`) and against a packaged payload, which deliberately ships
// no `.env` at all. Both answers are correct — 503 with guidance when unset, 400
// when configured but the request carries no audio — and both prove the route does
// not quietly borrow the chat provider's key. Anything else (200, 401, 500) is a
// defect. Reading `AI_TRANSCRIBE_API_KEY` here instead compared this process's
// environment with the server's, which is not the same thing.
const transcribe = await fetch(`${base}/api/ai/transcribe`, { method: "POST", headers: { cookie: `noema_session=${session}` }, body: new FormData() });
console.log(`transcribe → ${transcribe.status} (400 configured · 503 unconfigured)`);
check(
  "transcribe requires its own provider (refuses without one, validates with one)",
  transcribe.status === 400 || transcribe.status === 503,
);

const transcribeAnon = await fetch(`${base}/api/ai/transcribe`, { method: "POST", body: new FormData() });
check("transcribe requires authentication", transcribeAnon.status === 401);

// --- cleanup ------------------------------------------------------------
await prisma.page.update({ where: { id: rootPage.id }, data: { teamspaceId: null } });
await prisma.teamspace.delete({ where: { id: teamspace.id } });
await prisma.user.delete({ where: { email: "sso-user@noema.local" } });
await prisma.$disconnect();
idp.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);

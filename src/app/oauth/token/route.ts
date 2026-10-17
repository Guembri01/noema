import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { hashApiToken, hashOAuthSecret, oauthSecretMatches } from "@/lib/api-auth";
import { rateLimit } from "@/lib/api-guard";
import { bodyReadError, readFormDataBody } from "@/lib/body-limit";
import { verifyChallenge } from "@/lib/oauth-pkce";

export const runtime = "nodejs";

/**
 * The scopes a token minted here carries.
 *
 * The OAuth flow negotiates no scopes yet: the consent screen offers no
 * picker, the app row stores no scopes and the authorization code carries
 * none — so there is nothing the token endpoint could read back to honour a
 * narrower grant. The list is therefore fixed and explicit rather than empty:
 * every read and write scope of the catalogue, minus `admin:workspace`, which
 * this endpoint never advertised (its response said `scope: "read write"`).
 * A token minted here is exactly as capable as the one it replaces, but the
 * grant is now recorded on the row and enforced by the API instead of being
 * implied by the absence of a check.
 */
const OAUTH_TOKEN_SCOPES: readonly string[] = [
  "read:pages",
  "write:pages",
  "read:databases",
  "write:databases",
  "read:tickets",
  "write:tickets",
  "read:comments",
  "write:comments",
  "read:files",
  "write:files",
  "read:webhooks",
  "write:webhooks",
  "read:members",
  "write:members",
];

/**
 * B22 — the budget for one token exchange. The form carries the code, the
 * client credentials and the PKCE verifier — a few hundred bytes at most.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Exchange an authorization code for an API access token. */
export async function POST(request: Request) {
  const limited = rateLimit(request, "oauth-token", 30, 60_000);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await readFormDataBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Expected multipart form data");
  }
  if (String(form.get("grant_type") ?? "") !== "authorization_code") {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  const code = String(form.get("code") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const clientSecret = String(form.get("client_secret") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const codeVerifier = String(form.get("code_verifier") ?? "");

  const app = await prisma.oAuthApp.findUnique({ where: { clientId } });
  // The stored digest is compared in constant time; a client that presents
  // anything but the original secret is refused.
  if (!app || !oauthSecretMatches(clientSecret, app.clientSecretHash)) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }

  // The authorization code is looked up by its digest, so the database never
  // holds a redeemable code.
  const record = await prisma.oAuthCode.findUnique({
    where: { codeHash: hashOAuthSecret(code) },
  });
  if (
    !record ||
    record.used ||
    record.clientId !== clientId ||
    record.redirectUri !== redirectUri ||
    record.expiresAt < new Date()
  ) {
    return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
  }

  if (record.codeChallenge) {
    const method = record.codeChallengeMethod ?? "S256";
    if (!codeVerifier || !verifyChallenge(codeVerifier, record.codeChallenge, method)) {
      return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
    }
  }

  // RFC 6749 §4.1.2: an authorization code is single-use. Consume it with a
  // conditional update so the read above and the write cannot race: two
  // concurrent exchanges both see `used = false`, but only the first
  // `UPDATE ... WHERE used = false` matches a row (`count === 1`). The loser
  // gets no token.
  const consumed = await prisma.oAuthCode.updateMany({
    where: { id: record.id, used: false },
    data: { used: true },
  });
  if (consumed.count !== 1) {
    return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
  }

  const accessToken = `noema_${randomToken(24)}`;
  await prisma.apiToken.create({
    data: {
      userId: record.userId,
      name: `OAuth: ${app.name}`,
      tokenHash: hashApiToken(accessToken),
      scopes: [...OAUTH_TOKEN_SCOPES],
    },
  });

  return NextResponse.json({
    access_token: accessToken,
    token_type: "Bearer",
    scope: OAUTH_TOKEN_SCOPES.join(" "),
  });
}

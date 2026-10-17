import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { hashApiToken } from "@/lib/api-auth";
import { rateLimit } from "@/lib/api-guard";
import { bodyReadError, readFormDataBody } from "@/lib/body-limit";
import { verifyChallenge } from "@/lib/oauth-pkce";

export const runtime = "nodejs";

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
  if (!app || app.clientSecret !== clientSecret) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }

  const record = await prisma.oAuthCode.findUnique({ where: { code } });
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

  await prisma.oAuthCode.update({ where: { id: record.id }, data: { used: true } });

  const accessToken = `noema_${randomToken(24)}`;
  await prisma.apiToken.create({
    data: {
      userId: record.userId,
      name: `OAuth: ${app.name}`,
      tokenHash: hashApiToken(accessToken),
    },
  });

  return NextResponse.json({
    access_token: accessToken,
    token_type: "Bearer",
    scope: "read write",
  });
}

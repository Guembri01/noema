import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { hashApiToken } from "@/lib/api-auth";
import { rateLimit } from "@/lib/api-guard";
import { verifyChallenge } from "@/lib/oauth-pkce";

export const runtime = "nodejs";

/** Exchange an authorization code for an API access token. */
export async function POST(request: Request) {
  const limited = rateLimit(request, "oauth-token", 30, 60_000);
  if (limited) return limited;

  const form = await request.formData();
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
    },
  });

  return NextResponse.json({
    access_token: accessToken,
    token_type: "Bearer",
    scope: "read write",
  });
}

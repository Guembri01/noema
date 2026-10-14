import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { randomToken } from "@/lib/slug";

export const runtime = "nodejs";

/** OIDC callback: exchange the code, verify the id_token, sign the user in. */
export async function GET(request: Request) {
  const issuer = process.env.SSO_ISSUER;
  const clientId = process.env.SSO_CLIENT_ID;
  const clientSecret = process.env.SSO_CLIENT_SECRET;
  const origin = new URL(request.url).origin;
  if (!issuer || !clientId || !clientSecret) {
    return NextResponse.json({ error: "SSO is not configured." }, { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const store = await cookies();
  const expectedState = store.get("sso_state")?.value;
  const nonce = store.get("sso_nonce")?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(`${origin}/login?error=sso`);
  }

  const redirectUri =
    process.env.SSO_REDIRECT_URI ?? `${origin}/api/auth/sso/callback`;
  const discovery = await fetch(
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  )
    .then((response) => response.json())
    .catch(() => null);
  if (!discovery?.token_endpoint || !discovery?.jwks_uri) {
    return NextResponse.redirect(`${origin}/login?error=sso`);
  }

  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  }).catch(() => null);
  if (!tokenResponse?.ok) {
    return NextResponse.redirect(`${origin}/login?error=sso`);
  }
  const tokens = (await tokenResponse.json()) as { id_token?: string };
  if (!tokens.id_token) return NextResponse.redirect(`${origin}/login?error=sso`);

  let payload: Record<string, unknown>;
  try {
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const verified = await jwtVerify(tokens.id_token, jwks, {
      issuer,
      audience: clientId,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return NextResponse.redirect(`${origin}/login?error=sso`);
  }
  if (nonce && payload.nonce && payload.nonce !== nonce) {
    return NextResponse.redirect(`${origin}/login?error=sso`);
  }

  const email =
    typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  if (!email) return NextResponse.redirect(`${origin}/login?error=sso`);
  const name =
    (typeof payload.name === "string" && payload.name) ||
    (typeof payload.preferred_username === "string" && payload.preferred_username) ||
    email.split("@")[0];

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, name, passwordHash: `sso:${randomToken(24)}` },
    });
  }

  await createSession(user.id);
  store.delete("sso_state");
  store.delete("sso_nonce");
  return NextResponse.redirect(`${origin}/app`);
}

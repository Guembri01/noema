import { NextResponse } from "next/server";
import { randomToken } from "@/lib/slug";

export const runtime = "nodejs";

/** Begin OIDC SSO: discover the provider and redirect to its authorize URL. */
export async function GET(request: Request) {
  const issuer = process.env.SSO_ISSUER;
  const clientId = process.env.SSO_CLIENT_ID;
  if (!issuer || !clientId) {
    return NextResponse.json({ error: "SSO is not configured." }, { status: 404 });
  }

  const discovery = await fetch(
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  )
    .then((response) => response.json())
    .catch(() => null);
  if (!discovery?.authorization_endpoint) {
    return NextResponse.json({ error: "SSO discovery failed." }, { status: 502 });
  }

  const origin = new URL(request.url).origin;
  const redirectUri =
    process.env.SSO_REDIRECT_URI ?? `${origin}/api/auth/sso/callback`;
  const state = randomToken(16);
  const nonce = randomToken(16);

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);

  const response = NextResponse.redirect(url.toString());
  response.cookies.set("sso_state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  response.cookies.set("sso_nonce", nonce, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return response;
}

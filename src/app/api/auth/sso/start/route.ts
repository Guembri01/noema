import { NextResponse } from "next/server";
import {
  DEFAULT_OIDC_SCOPES,
  enabledStrategies,
  startLogin,
  type AuthEnv,
  type AuthStrategy,
} from "@/lib/auth-strategies";
import {
  cookieName,
  secureCookies,
  SSO_NONCE_COOKIE,
  SSO_STATE_COOKIE,
} from "@/lib/cookie-security";

export const runtime = "nodejs";

/** Default same-origin landing path for the env-level SSO connection. */
const DEFAULT_SSO_RETURN_TO = "/app";

/** The discovery-document fields the OIDC strategy needs to begin a login. */
type DiscoveryDocument = {
  authorization_endpoint?: string;
};

/**
 * Whether the env-level OIDC connection (`SSO_*`) is sign-in enabled.
 *
 * `enabledStrategies` owns the deployment's strategy gating, but the env
 * connection has no registry id of its own. Projecting it onto the registry's
 * OIDC gate keeps `AUTH_STRATEGIES` authoritative — an allow-list with no OIDC
 * entry turns SSO off — while the `SSO_*` connection stays self-enabling, which
 * is exactly what the live `check:sso` suite (mock IdP on :4321) relies on.
 */
function ssoEnabled(env: AuthEnv): boolean {
  if (!env.SSO_ISSUER || !env.SSO_CLIENT_ID) return false;
  return enabledStrategies({ ...env, AUTH_GOOGLE_ENABLED: "true" }).some(
    (strategy) => strategy.kind === "oidc",
  );
}

/** Begin OIDC SSO: discover the provider and redirect to its authorize URL. */
export async function GET(request: Request) {
  const env: AuthEnv = process.env;
  const issuer = env.SSO_ISSUER;
  const clientId = env.SSO_CLIENT_ID;
  if (!issuer || !clientId || !ssoEnabled(env)) {
    return NextResponse.json({ error: "SSO is not configured." }, { status: 404 });
  }

  const discovery = (await fetch(
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  )
    .then((response) => response.json())
    .catch(() => null)) as DiscoveryDocument | null;
  if (!discovery || typeof discovery.authorization_endpoint !== "string") {
    return NextResponse.json({ error: "SSO discovery failed." }, { status: 502 });
  }

  const url = new URL(request.url);
  const redirectUri =
    env.SSO_REDIRECT_URI ?? `${url.origin}/api/auth/sso/callback`;

  // The env-level connection is a first-class OIDC strategy; `startLogin`
  // mints its state/nonce pair and builds the authorize redirect.
  const strategy: AuthStrategy = {
    id: "sso",
    label: "SSO",
    kind: "oidc",
    enabled: true,
    config: {
      authorizationUrl: discovery.authorization_endpoint,
      clientId,
      issuer,
      scopes: DEFAULT_OIDC_SCOPES,
      callbackPath: redirectUri,
    },
  };

  const requestedReturnTo = url.searchParams.get("returnTo") ?? DEFAULT_SSO_RETURN_TO;
  const { redirectUrl, state, nonce } = startLogin(strategy, {
    returnTo: requestedReturnTo,
  });

  const response = NextResponse.redirect(redirectUrl);
  // B31: the hand-off cookies are credentials — the state binds the callback
  // to this sign-in, the nonce binds the id_token to it. They therefore carry
  // `Secure` in production (and the `__Host-` prefix that goes with it), so
  // they travel neither in cleartext nor out of a sibling subdomain's reach.
  response.cookies.set(cookieName(SSO_STATE_COOKIE), state, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 600,
  });
  response.cookies.set(cookieName(SSO_NONCE_COOKIE), nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 600,
  });
  return response;
}

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { randomToken } from "@/lib/slug";
import {
  DEFAULT_OIDC_SCOPES,
  enabledStrategies,
  linkOrCreate,
  normalizeIdentity,
  validateCallback,
  type AuthEnv,
  type AuthStrategy,
  type IdentityProfile,
} from "@/lib/auth-strategies";
import {
  cookieName,
  SSO_NONCE_COOKIE,
  SSO_STATE_COOKIE,
} from "@/lib/cookie-security";

export const runtime = "nodejs";

/** Server-remembered landing path when the callback carries none. */
const DEFAULT_SSO_RETURN_TO = "/app";

/** The discovery-document fields the callback needs. */
type DiscoveryDocument = {
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
};

/**
 * Whether the env-level OIDC connection (`SSO_*`) is sign-in enabled — see
 * `sso/start/route.ts`. `enabledStrategies` remains authoritative for the
 * `AUTH_STRATEGIES` allow-list while the env connection is self-enabling.
 */
function ssoEnabled(env: AuthEnv): boolean {
  if (!env.SSO_ISSUER || !env.SSO_CLIENT_ID) return false;
  return enabledStrategies({ ...env, AUTH_GOOGLE_ENABLED: "true" }).some(
    (strategy) => strategy.kind === "oidc",
  );
}

/** Fail closed: never issue a session, always land on the login error. */
function ssoFailure(origin: string): NextResponse {
  return NextResponse.redirect(`${origin}/login?error=sso`);
}

/**
 * The address already belongs to an account that never proved it (B07): the
 * sign-in may not land there — the account may have been registered by
 * somebody else before the real owner showed up, and linking would hand it
 * (and everything it owns) to that somebody. The user gets its own message
 * instead of the generic SSO failure.
 */
function ssoEmailTaken(origin: string): NextResponse {
  return NextResponse.redirect(`${origin}/login?error=sso_email_taken`);
}

/**
 * The provider did not assert that the address in the id_token is verified.
 * Without that assertion the address is just a claim: creating a verified
 * account from it would let a provider that hands out arbitrary addresses
 * take over an unproven local account. Fail closed.
 */
function ssoEmailUnverified(origin: string): NextResponse {
  return NextResponse.redirect(`${origin}/login?error=sso_email_unverified`);
}

/** OIDC callback: exchange the code, verify the id_token, sign the user in. */
export async function GET(request: Request) {
  const env: AuthEnv = process.env;
  const issuer = env.SSO_ISSUER;
  const clientId = env.SSO_CLIENT_ID;
  const clientSecret = env.SSO_CLIENT_SECRET;
  const url = new URL(request.url);
  const origin = url.origin;
  if (!issuer || !clientId || !clientSecret || !ssoEnabled(env)) {
    return NextResponse.json({ error: "SSO is not configured." }, { status: 404 });
  }

  const store = await cookies();
  // B31: the names come from the module that owns them, so the reader and the
  // writer always agree — in production they carry the `__Host-` prefix.
  const expectedState = store.get(cookieName(SSO_STATE_COOKIE))?.value ?? "";
  const nonce = store.get(cookieName(SSO_NONCE_COOKIE))?.value ?? "";

  const discovery = (await fetch(
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  )
    .then((response) => response.json())
    .catch(() => null)) as DiscoveryDocument | null;
  if (!discovery?.token_endpoint || !discovery?.jwks_uri) {
    return ssoFailure(origin);
  }

  const redirectUri = env.SSO_REDIRECT_URI ?? `${origin}/api/auth/sso/callback`;
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

  // `validateCallback` re-checks state, demands the code and resolves a safe,
  // same-origin `returnTo`; a rejection never yields a redirect target, so a
  // tampered `returnTo` cannot become an open redirect.
  const validation = validateCallback(strategy, {
    params: {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
      returnTo: url.searchParams.get("returnTo") ?? undefined,
    },
    expected: { state: expectedState, returnTo: DEFAULT_SSO_RETURN_TO },
  });
  if (!validation.ok || !validation.code) {
    return ssoFailure(origin);
  }
  const code = validation.code;
  const returnTo = validation.returnTo ?? DEFAULT_SSO_RETURN_TO;

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
    return ssoFailure(origin);
  }
  const tokens = (await tokenResponse.json()) as { id_token?: string };
  if (!tokens.id_token) return ssoFailure(origin);

  let payload: Record<string, unknown>;
  try {
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const verified = await jwtVerify(tokens.id_token, jwks, {
      issuer,
      audience: clientId,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return ssoFailure(origin);
  }
  // OIDC binds the id_token to the request with `nonce` (the `state` check above
  // already bound the callback itself).
  if (nonce && payload.nonce && payload.nonce !== nonce) {
    return ssoFailure(origin);
  }

  // The name claim keeps the provider's `preferred_username` as a fallback so
  // `normalizeIdentity` sees the same profile the previous hand-rolled flow did.
  const profile: IdentityProfile = {
    ...payload,
    name: payload.name ?? payload.preferred_username,
  };
  const identity = normalizeIdentity(strategy, profile);

  // B07 — the address is only trustworthy when the provider says it verified
  // it. The id_token's `email_verified` claim is the only statement of that
  // here; a provider that omits it or says `false` is refused before any
  // account is looked up, created or linked. (A missing email keeps the
  // generic failure below, so the refusal does not become an enumeration
  // oracle.)
  if (identity.email && payload.email_verified !== true) {
    return ssoEmailUnverified(origin);
  }

  const existingUsers = identity.email
    ? await prisma.user.findMany({
        where: { email: identity.email },
        // `emailVerified` is what decides whether the account may be linked
        // (B07) — without it every match would look unproven.
        select: { id: true, email: true, emailVerified: true },
      })
    : [];
  const decision = linkOrCreate({
    existingUsers,
    identity,
    strategy,
    now: Date.now(),
    // The claim was checked above; the provider vouched for the address.
    emailVerified: true,
  });

  let userId: string;
  if (decision.action === "link") {
    userId = decision.userId;
  } else if (decision.action === "create") {
    const created = await prisma.user.create({
      data: {
        email: identity.email,
        name: identity.name || identity.email.split("@")[0],
        passwordHash: `sso:${randomToken(24)}`,
        // The callback only reaches this branch when the id_token asserted
        // `email_verified: true`, so the provider vouched for the address
        // (B07). The account has no local password — the sentinel above is
        // not one — so it is only reachable through this provider, and a
        // later provider sign-in may link it. The provider is the trust root
        // for the address here: an IdP that hands out unverified addresses
        // must say so, and the callback then fails closed.
        emailVerified: true,
      },
      select: { id: true },
    });
    userId = created.id;
  } else {
    // conflict (missing/contested email): never auto-link or create.
    if (decision.reason === "email_taken_unverified") {
      return ssoEmailTaken(origin);
    }
    return ssoFailure(origin);
  }

  await createSession(userId);
  store.delete(cookieName(SSO_STATE_COOKIE));
  store.delete(cookieName(SSO_NONCE_COOKIE));
  return NextResponse.redirect(`${origin}${returnTo}`);
}

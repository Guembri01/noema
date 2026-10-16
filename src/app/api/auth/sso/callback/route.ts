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
  const expectedState = store.get("sso_state")?.value ?? "";
  const nonce = store.get("sso_nonce")?.value ?? "";

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

  const existingUsers = identity.email
    ? await prisma.user.findMany({
        where: { email: identity.email },
        select: { id: true, email: true },
      })
    : [];
  const decision = linkOrCreate({
    existingUsers,
    identity,
    strategy,
    now: Date.now(),
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
      },
      select: { id: true },
    });
    userId = created.id;
  } else {
    // conflict (missing/contested email): never auto-link or create.
    return ssoFailure(origin);
  }

  await createSession(userId);
  store.delete("sso_state");
  store.delete("sso_nonce");
  return NextResponse.redirect(`${origin}${returnTo}`);
}

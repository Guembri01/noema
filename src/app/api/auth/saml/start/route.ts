import { NextResponse } from "next/server";
import { isSafeReturnTo } from "@/lib/auth-strategies";
import { createSamlClient } from "@/lib/sso/saml-client";
import { createSamlRelayState } from "@/lib/sso/saml-relay";
import { resolveSamlSettings, samlEnabled } from "@/lib/sso/saml";

export const runtime = "nodejs";

const DEFAULT_RETURN_TO = "/app";

/**
 * Begin the env-level SAML login: build a redirect AuthnRequest with
 * `@node-saml/node-saml` and carry a short-lived, signed RelayState that holds
 * the same-origin return path. No hand-off cookie is used: the IdP posts back
 * cross-site, where a `SameSite=Lax` cookie would not be sent.
 */
export async function GET(request: Request) {
  const env = process.env;
  const url = new URL(request.url);
  const settings = resolveSamlSettings(env, url.origin);
  if (!settings.ok || !samlEnabled(env)) {
    return NextResponse.json(
      { error: settings.ok ? "SAML is not enabled." : settings.reason },
      { status: 404 },
    );
  }

  const requestedReturnTo = url.searchParams.get("returnTo") ?? DEFAULT_RETURN_TO;
  const returnTo = isSafeReturnTo(requestedReturnTo)
    ? requestedReturnTo
    : DEFAULT_RETURN_TO;

  let redirectUrl: string;
  try {
    const relayState = await createSamlRelayState(returnTo);
    redirectUrl = await createSamlClient(settings.settings).getAuthorizeUrlAsync(
      relayState,
      url.origin,
      {},
    );
  } catch {
    return NextResponse.json(
      { error: "SAML could not build the sign-in request." },
      { status: 502 },
    );
  }

  return NextResponse.redirect(redirectUrl);
}

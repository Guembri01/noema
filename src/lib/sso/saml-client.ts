/**
 * Thin `@node-saml/node-saml` wrapper. The library owns every XML/SAML
 * validation decision; this module only translates the resolved env settings
 * into its options. Keep it server-only: it is imported by the route handlers
 * (and their tests), never by a client component.
 */

import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import type { SamlSettings } from "./saml";

/** Build the SP client for one deployment connection. */
export function createSamlClient(settings: SamlSettings): SAML {
  return new SAML({
    // SP identity
    issuer: settings.spEntityId,
    callbackUrl: settings.callbackUrl,
    logoutCallbackUrl: settings.logoutCallbackUrl,
    // IdP trust
    entryPoint: settings.ssoUrl,
    idpIssuer: settings.idpEntityId,
    idpCert: settings.idpCertificate,
    audience: settings.spEntityId,
    // The assertion must be signed; a signed Response wrapping it is not
    // enough on its own, so an unsigned assertion can never be accepted.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // Enterprise IdPs routinely drift a little; 120 s is the spec's window.
    acceptedClockSkewMs: 120,
    identifierFormat: settings.identifierFormat,
    // The RelayState cookie is this deployment's request binding. InResponseTo
    // validation would need a shared request-id cache; the assertion digest is
    // the replay control instead (R10.4).
    validateInResponseTo: ValidateInResponseTo.never,
    ...(settings.logoutUrl ? { logoutUrl: settings.logoutUrl } : {}),
    ...(settings.signingKey && settings.spCertificate
      ? { privateKey: settings.signingKey, publicCert: settings.spCertificate }
      : {}),
    ...(settings.decryptionKey ? { decryptionPvk: settings.decryptionKey } : {}),
  });
}

/**
 * SP metadata XML (entity id, ACS/SLO locations, and the configured signing /
 * decryption certificates). Generates no key material itself: an operator who
 * wants signed AuthnRequests supplies `AUTH_SAML_PRIVATE_KEY` + `AUTH_SAML_SP_CERT`.
 */
export function samlMetadata(settings: SamlSettings): string {
  return createSamlClient(settings).generateServiceProviderMetadata(
    settings.decryptionCertificate ?? null,
    settings.spCertificate ?? null,
  );
}

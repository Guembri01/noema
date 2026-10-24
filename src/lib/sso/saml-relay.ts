/**
 * SAML RelayState: a short-lived, HMAC-signed token carrying the same-origin
 * return path. A SAML Response arrives as a **cross-site POST**, so a
 * `SameSite=Lax` cookie is not sent; the state therefore travels in the
 * RelayState itself. The token is signed with a key derived from
 * `AUTH_SECRET` and expires after ten minutes.
 *
 * This is not XML/SAML signature code (that stays in `@node-saml/node-saml`);
 * it only proves that this deployment minted the return path.
 */

import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { resolveAuthSecret } from "../auth-secret";
import { isSafeReturnTo } from "../auth-strategies";

const PURPOSE = "noema-saml-relay";
const TTL = "10m";
const DEFAULT_RETURN_TO = "/app";

/** A purpose-separated HS256 key derived from the deployment root secret. */
function relayKey(): Uint8Array {
  return createHash("sha256")
    .update(`${resolveAuthSecret()}:${PURPOSE}`)
    .digest();
}

/** Mint the RelayState for one login, normalising an unsafe return path. */
export async function createSamlRelayState(
  returnTo: string,
  connectionId?: string,
): Promise<string> {
  const safeReturnTo = isSafeReturnTo(returnTo) ? returnTo : DEFAULT_RETURN_TO;
  return new SignJWT({
    purpose: PURPOSE,
    returnTo: safeReturnTo,
    ...(connectionId ? { connectionId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(relayKey());
}

/**
 * Verify a RelayState. Returns `null` for a missing, malformed, expired or
 * foreign token; a valid token never yields an off-origin return path.
 */
export async function readSamlRelayState(
  value: unknown,
): Promise<{ returnTo: string; connectionId?: string } | null> {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const { payload } = await jwtVerify(value, relayKey(), {
      algorithms: ["HS256"],
    });
    if (payload.purpose !== PURPOSE) return null;
    const returnTo = payload.returnTo;
    if (typeof returnTo !== "string" || !isSafeReturnTo(returnTo)) return null;
    const connectionId = payload.connectionId;
    if (
      connectionId !== undefined &&
      (typeof connectionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(connectionId))
    ) {
      return null;
    }
    return connectionId ? { returnTo, connectionId } : { returnTo };
  } catch {
    return null;
  }
}

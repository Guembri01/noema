import { randomBytes } from "node:crypto";

/**
 * WebAuthn / passkey primitives shared by the registration and assertion
 * ceremonies. Everything here is pure apart from `node:crypto`'s CSPRNG, so
 * each helper can be unit-tested without a browser or an authenticator: the
 * server generates a challenge and leans on these checks to decide whether a
 * client response is even shaped like a valid one before any crypto verify.
 *
 * The functions are deliberately conservative. Inputs arrive from untrusted
 * client JSON and from stored rows, so they normalise case, reject padding and
 * out-of-alphabet characters, and fail closed on anything ambiguous rather
 * than throwing into a request handler.
 */

/** WebAuthn §5.1.3: a challenge MUST be at least 16 bytes of entropy. */
export const MIN_CHALLENGE_BYTES = 16;

/** Default challenge size; 32 bytes comfortably clears the minimum. */
export const DEFAULT_CHALLENGE_BYTES = 32;

/** Upper bound so a malformed request cannot ask for unbounded randomness. */
export const MAX_CHALLENGE_BYTES = 64;

/** WebAuthn §5.8.1: a credential ID is at most 1023 bytes; allow the next byte. */
export const MAX_CREDENTIAL_ID_BYTES = 1024;

/** base64url without padding: RFC 4648 §5 alphabet, no `=` padding. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Canonical base64url never has a length ≡ 1 (mod 4). */
const INVALID_BASE64_LENGTH = (length: number): boolean => length % 4 === 1;

/**
 * The COSE algorithm identifiers the relying party accepts. `-7` ES256 and
 * `-8` EdDSA cover essentially every platform authenticator; the rest are
 * offered for hardware keys that prefer RSA/PSA or larger ECDSA curves.
 */
const SUPPORTED_COSE_ALGORITHMS: ReadonlySet<number> = new Set([
  -7, // ES256  ECDSA w/ SHA-256 (P-256)
  -8, // EdDSA  Ed25519
  -35, // ES384  ECDSA w/ SHA-384 (P-384)
  -36, // ES512  ECDSA w/ SHA-512 (P-521)
  -37, // PS256  RSASSA-PSS w/ SHA-256
  -38, // PS384  RSASSA-PSS w/ SHA-384
  -39, // PS512  RSASSA-PSS w/ SHA-512
  -257, // RS256 RSASSA-PKCS1-v1_5 w/ SHA-256
  -258, // RS384
  -259, // RS512
]);

/** A hostname-shaped RP ID: dot-separated labels, no leading/trailing hyphen. */
const RP_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Hosts for which an `http:` origin is still an acceptable WebAuthn context. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Generate a fresh, unpredictable challenge encoded as base64url. The default
 * is {@link DEFAULT_CHALLENGE_BYTES}; `bytes` must be an integer within
 * {@link MIN_CHALLENGE_BYTES}..{@link MAX_CHALLENGE_BYTES}.
 *
 * @throws {RangeError} when `bytes` is not an integer in range.
 */
export function generateChallenge(options: { bytes?: number } = {}): string {
  const bytes = options.bytes ?? DEFAULT_CHALLENGE_BYTES;
  if (
    !Number.isInteger(bytes) ||
    bytes < MIN_CHALLENGE_BYTES ||
    bytes > MAX_CHALLENGE_BYTES
  ) {
    throw new RangeError(
      `challenge must be an integer between ${MIN_CHALLENGE_BYTES} and ${MAX_CHALLENGE_BYTES} bytes, received ${bytes}`,
    );
  }
  return randomBytes(bytes).toString("base64url");
}

/**
 * Whether `challenge` is a canonical base64url string carrying at least
 * {@link MIN_CHALLENGE_BYTES} decoded bytes. Rejects padding, whitespace and
 * out-of-alphabet characters, and requires the encoding to round-trip so a
 * mutated least-significant group (non-zero pad bits) is not accepted.
 */
export function isValidChallenge(challenge: unknown): boolean {
  if (typeof challenge !== "string") return false;
  if (!BASE64URL_PATTERN.test(challenge)) return false;
  if (INVALID_BASE64_LENGTH(challenge.length)) return false;

  const bytes = Buffer.from(challenge, "base64url");
  if (bytes.length < MIN_CHALLENGE_BYTES) return false;
  return bytes.toString("base64url") === challenge;
}

/** The decoded form of a credential ID, with a canonical base64url encoding. */
export interface ParsedCredentialId {
  /** Raw credential ID bytes as sent by the authenticator. */
  readonly bytes: Buffer;
  /** Canonical, unpadded base64url encoding of {@link bytes}. */
  readonly base64url: string;
}

/**
 * Decode a credential ID carried as base64url (or padded standard base64) into
 * its raw bytes. Both alphabets are accepted and rewritten to canonical
 * base64url, so a legacy row stored as `base64` still verifies. Blank,
 * malformed or oversized (> {@link MAX_CREDENTIAL_ID_BYTES} bytes) inputs
 * return `null`.
 */
export function parseCredentialId(input: unknown): ParsedCredentialId | null {
  if (typeof input !== "string") return null;

  const normalized = input
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  if (normalized.length === 0) return null;
  if (!BASE64URL_PATTERN.test(normalized)) return null;
  if (INVALID_BASE64_LENGTH(normalized.length)) return null;

  const bytes = Buffer.from(normalized, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_ID_BYTES) return null;

  return { bytes, base64url: bytes.toString("base64url") };
}

/** Whether `coseAlg` is a COSE algorithm identifier this RP will register. */
export function isSupportedAlgorithm(coseAlg: unknown): boolean {
  if (typeof coseAlg !== "number" || !Number.isInteger(coseAlg)) return false;
  return SUPPORTED_COSE_ALGORITHMS.has(coseAlg);
}

/**
 * Validate a signature counter step. Authenticators that implement a counter
 * must report a strictly greater value on every assertion; an equal or lower
 * value suggests a cloned credential. A counter of `0` on either side means
 * the authenticator does not implement one, so the comparison is skipped
 * rather than treated as a clone. Negative or non-integer counters fail closed.
 */
export function checkSignCount(prev: unknown, next: unknown): boolean {
  if (typeof prev !== "number" || typeof next !== "number") return false;
  if (!Number.isInteger(prev) || !Number.isInteger(next)) return false;
  if (prev < 0 || next < 0) return false;
  if (prev === 0 || next === 0) return true;
  return next > prev;
}

/** Lowercase a candidate RP ID, drop a trailing dot and validate its shape. */
function normalizeRpId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  if (!RP_ID_PATTERN.test(host)) return null;
  return host;
}

/**
 * Whether `rpId` is allow-listed. Comparison is exact (after lowercasing and
 * stripping a trailing dot), so `login.example.com` is NOT satisfied by a
 * listed `example.com` — the caller must list every acceptable RP ID. A blank
 * `rpId` or a non-array/empty allow-list fails closed.
 */
export function isValidRpId(rpId: unknown, rpIds: unknown): boolean {
  const host = normalizeRpId(rpId);
  if (host === null) return false;
  if (!Array.isArray(rpIds)) return false;
  return rpIds.some((candidate) => normalizeRpId(candidate) === host);
}

/**
 * Derive the RP ID implied by an origin. Returns the lowercased hostname for
 * `https:` origins and for `http:` origins only on loopback hosts (the sole
 * insecure context WebAuthn permits). Any other scheme, or an unparseable
 * origin, yields `null`. The full host is returned (a valid RP ID may equal or
 * be a registrable suffix of the origin's effective domain).
 */
export function rpIdFromOrigin(origin: unknown): string | null {
  if (typeof origin !== "string") return null;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return null;
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(host)) return null;

  return host;
}

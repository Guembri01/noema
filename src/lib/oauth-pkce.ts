import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * RFC 7636 Proof Key for Code Exchange (PKCE) helpers.
 *
 * Pure apart from `node:crypto`, so every branch is unit-testable with the
 * published reference vectors. Lengths and the verifier charset follow
 * RFC 7636 §4.1; `S256` is the required transformation, `plain` is provided
 * only for legacy clients that cannot compute SHA-256.
 */

/** RFC 7636 §4.1 unreserved charset: ALPHA / DIGIT / "-" / "." / "_" / "~". */
const VERIFIER_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Default verifier length; RFC 7636 allows 43..128 characters. */
export const DEFAULT_VERIFIER_LENGTH = 64;

/** RFC 4648 §5 base64url without padding, over a byte buffer. */
export function base64UrlEncode(input: Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Inverse of {@link base64UrlEncode}; accepts input with or without padding. */
export function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Generate a high-entropy `code_verifier` using the RFC 7636 unreserved
 * charset. Throws when `length` is not an integer in the 43..128 range.
 */
export function generateCodeVerifier(length: number = DEFAULT_VERIFIER_LENGTH): string {
  if (!Number.isInteger(length) || length < 43 || length > 128) {
    throw new RangeError(
      `code_verifier length must be an integer between 43 and 128, received ${length}`,
    );
  }
  let verifier = "";
  for (let index = 0; index < length; index += 1) {
    verifier += VERIFIER_CHARSET[randomInt(VERIFIER_CHARSET.length)];
  }
  return verifier;
}

/** True when `verifier` is a syntactically valid RFC 7636 `code_verifier`. */
export function isValidVerifier(verifier: string): boolean {
  return typeof verifier === "string" && VERIFIER_PATTERN.test(verifier);
}

/** `code_challenge` for the `S256` method: base64url(sha256(verifier)). */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** `code_challenge` for the `plain` method: the verifier itself. */
export function codeChallengePlain(verifier: string): string {
  return verifier;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a `code_verifier` against a stored `code_challenge`. The method is
 * matched case-insensitively; malformed verifiers and unknown methods fail
 * closed. Comparison is constant-time for equal-length inputs.
 */
export function verifyChallenge(verifier: string, challenge: string, method: string): boolean {
  if (!isValidVerifier(verifier) || typeof challenge !== "string" || challenge.length === 0) {
    return false;
  }
  const normalized = typeof method === "string" ? method.toUpperCase() : "";
  const computed =
    normalized === "S256"
      ? codeChallengeS256(verifier)
      : normalized === "PLAIN"
        ? codeChallengePlain(verifier)
        : null;
  if (computed === null) return false;
  return timingSafeStringEqual(computed, challenge);
}

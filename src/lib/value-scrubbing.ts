/**
 * The repository's one list of credential-shaped *values* (B121).
 *
 * Two modules scrub credential-shaped substrings out of free text: the error
 * reporter (`src/lib/error-reporting.ts`) and the error tracker
 * (`src/lib/error-tracking.ts`). Each used to carry its own copy of the same
 * nine patterns, so a change to one list did not reach the other — the same
 * drift B35 closed for the secret-shaped *names*.
 *
 * This module owns the patterns and the marker. What each consumer keeps is
 * genuinely its own:
 *
 * - The **names** of secret-shaped fields are a different list (B35).
 * - The error reporter scrubs values inside a walked payload; the error
 *   tracker scrubs values inside a message and additionally masks email
 *   addresses and file-system paths, which are its own concern.
 *
 * The patterns are pure data and the scrub is a plain `String.replace` over
 * them, so the behaviour of every consumer stays exactly what it was.
 */

/** Marker that replaces a credential-shaped value. */
export const REDACTED = "[redacted]";

/**
 * Credential-shaped substrings removed from string VALUES. Ordered so that
 * scheme redactions run before the opaque-key rules; each replacement is
 * idempotent (it cannot re-match itself).
 */
export const VALUE_SCRUBBERS: readonly {
  readonly pattern: RegExp;
  readonly replace: string;
}[] = [
  // `Authorization: Bearer <token>` / `Basic <base64>`.
  { pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1${REDACTED}` },
  { pattern: /(\bBasic\s+)[A-Za-z0-9+/=]{8,}/gi, replace: `$1${REDACTED}` },
  // A JWT: three base64url segments, the first starting with `eyJ`.
  {
    pattern: /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: REDACTED,
  },
  // Common vendor key shapes.
  { pattern: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/gi, replace: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}/g, replace: REDACTED },
  { pattern: /\bxox[abpor]-[A-Za-z0-9-]{8,}/gi, replace: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  // Credential-bearing query parameters, preserving the parameter name.
  {
    pattern: /([?&](?:token|access_token|api_key|apikey|password|secret)=)[^&\s]+/gi,
    replace: `$1${REDACTED}`,
  },
];

/**
 * Remove credential-shaped substrings from a bare string value. The patterns
 * are applied in order, exactly as before, so the result is unchanged for
 * every consumer.
 */
export function scrubSecretValues(value: string): string {
  let out = value;
  for (const { pattern, replace } of VALUE_SCRUBBERS) {
    out = out.replace(pattern, replace);
  }
  return out;
}

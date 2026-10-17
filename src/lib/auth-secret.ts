/**
 * B55 — the one place that decides whether `AUTH_SECRET` is usable.
 *
 * `AUTH_SECRET` is the root secret of a deployment: it signs the session
 * cookie (HS256, `src/lib/auth.ts`) and derives the envelope key for every
 * stored provider key and 2FA seed (`src/lib/secrets.ts`). A value that
 * *ships with the repository* is therefore a public key — everybody who can
 * read the repository can mint a valid session cookie for any user id.
 *
 * The placeholder in `.env.example` (`replace-me-with-a-32-byte-hex-secret`)
 * is 35 characters long, so the old "at least 16 characters" check accepted
 * it verbatim. The rule now lives here, once, and every reader of
 * `AUTH_SECRET` goes through it:
 *
 *   - the value must be at least {@link MIN_AUTH_SECRET_LENGTH} characters,
 *   - it must not be a placeholder this repository ships
 *     ({@link SHIPPED_AUTH_SECRET_PLACEHOLDERS}),
 *   - it must not be a well-known weak value ({@link WEAK_AUTH_SECRETS}).
 *
 * The comparison is case-insensitive and ignores surrounding whitespace and
 * separators, so `Replace-Me-With-A-32-Byte-Hex-Secret` and
 * `  replace_me_with_a_32_byte_hex_secret  ` are refused as well — a denylist
 * that only matched the exact literal would be one copy/paste away from being
 * bypassed.
 *
 * The check fails CLOSED: a missing, too short, placeholder or weak value is
 * an error, exactly like a missing secret — never a fallback, never a guess.
 */

/**
 * Minimum length (in characters) of a usable `AUTH_SECRET`.
 *
 * 32 characters is the floor the review spec names; it is also the length of
 * the example the operator documentation ships
 * (`src/lib/self-hosting.ts`), so an operator who copies the documented
 * *shape* is not pushed below the bar by the length rule alone — the shipped
 * example is refused by name instead. The value the documentation asks for
 * is 64 hex characters (32 bytes), and `generateSecret({ bytes: 32 })`
 * produces 43 base64url characters, both comfortably above the floor.
 */
export const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * Values this repository ships. Copying one of them into `.env` is the
 * mistake this rule exists to stop, so every literal is denied by name.
 */
export const SHIPPED_AUTH_SECRET_PLACEHOLDERS: readonly string[] = [
  "replace-me-with-a-32-byte-hex-secret", // .env.example
  "0123456789abcdef0123456789abcdef", // src/lib/self-hosting.ts (AUTH_SECRET example)
  "sk-example-0000000000000000", // src/lib/self-hosting.ts (AI_API_KEY example)
  "sso-client-secret-value", // src/lib/self-hosting.ts (SSO_CLIENT_SECRET example)
  "smtp-password-value", // src/lib/self-hosting.ts (SMTP_PASSWORD example)
  "cron-secret-value", // src/lib/self-hosting.ts (CRON_SECRET example)
];

/**
 * Well-known weak values. Most of them are shorter than the floor above and
 * are therefore already refused by it; they are listed anyway so the reason a
 * value is refused is explicit and the list can grow.
 */
export const WEAK_AUTH_SECRETS: readonly string[] = [
  "changeme",
  "change-me",
  "your-secret-here",
  "example",
  "secret",
  "password",
  "placeholder",
  "replace-me",
  "todo",
  "tbd",
  "xxx",
];

/** Why a candidate value is not usable as `AUTH_SECRET`. */
export type AuthSecretProblem =
  | "missing"
  | "too-short"
  | "placeholder"
  | "weak";

/**
 * The comparison form of a value: trimmed, lowercased and without
 * separators. `Replace-Me-With-A-32-Byte-Hex-Secret` and
 * `replace_me_with_a_32_byte_hex_secret` fold to the same string, so one
 * denylist entry covers every spelling of a placeholder.
 */
function canonical(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

const CANONICAL_PLACEHOLDERS: ReadonlySet<string> = new Set(
  SHIPPED_AUTH_SECRET_PLACEHOLDERS.map(canonical),
);

const CANONICAL_WEAK: ReadonlySet<string> = new Set(
  WEAK_AUTH_SECRETS.map(canonical),
);

/**
 * The reason a value is not usable, or `null` when it is.
 *
 * Never returns the value itself — the answer is a category, so the caller
 * can log it without leaking the secret.
 */
export function authSecretProblem(
  value: string | null | undefined,
): AuthSecretProblem | null {
  if (typeof value !== "string") return "missing";
  const trimmed = value.trim();
  if (trimmed === "") return "missing";
  const folded = canonical(trimmed);
  if (CANONICAL_PLACEHOLDERS.has(folded)) return "placeholder";
  if (CANONICAL_WEAK.has(folded)) return "weak";
  if (trimmed.length < MIN_AUTH_SECRET_LENGTH) return "too-short";
  return null;
}

/** The generator the operator documentation points at. */
const GENERATOR_HINT =
  'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

/**
 * The error message for a rejected value. It names the *reason* but never the
 * value — a secret must not end up in a log line.
 */
export function authSecretErrorMessage(problem: AuthSecretProblem): string {
  switch (problem) {
    case "missing":
      return "AUTH_SECRET is required. Set a strong value in .env (see .env.example).";
    case "too-short":
      return `AUTH_SECRET is required to be at least ${MIN_AUTH_SECRET_LENGTH} characters long. Set a strong value in .env (see .env.example).`;
    case "placeholder":
      return `AUTH_SECRET is required to be a secret of your own — the placeholder that ships with this repository is public. ${GENERATOR_HINT}`;
    case "weak":
      return `AUTH_SECRET is required to be a secret of your own — this is a well-known weak value. ${GENERATOR_HINT}`;
  }
}

/**
 * Check a candidate value and return the usable secret (the trimmed value).
 *
 * Throws when the value is missing, too short, a shipped placeholder or a
 * well-known weak value. The trimmed value is returned so a padded
 * `AUTH_SECRET` cannot become a second, different key.
 */
export function assertAuthSecret(value: string | null | undefined): string {
  const problem = authSecretProblem(value);
  if (problem) throw new Error(authSecretErrorMessage(problem));
  return (value as string).trim();
}

/**
 * Read `AUTH_SECRET` from the environment and return it, or throw.
 *
 * Every reader of `AUTH_SECRET` in the app goes through this function, so
 * the rule exists exactly once.
 */
export function resolveAuthSecret(): string {
  return assertAuthSecret(process.env.AUTH_SECRET);
}

/**
 * The repository's one list of secret-shaped field names (B35).
 *
 * Several modules redact secret-shaped values: the observability logger
 * (`src/lib/observability.ts`), the error reporter (`src/lib/error-reporting.ts`),
 * the env-secret diagnostics (`src/lib/secrets.ts`), the JSON export
 * (`src/lib/json-export.ts`) and the audit diff (`src/lib/audit-diff.ts`).
 * Each used to carry its own list of names, and they had drifted apart:
 * `apiKey`, `privateKey` and `accessKey` were masked by the error reporter
 * but printed by the logger, while `dbUrl` was masked by nobody; the export
 * kept thirteen names of the list verbatim (`passwd`, `passcode`, `cookie`,
 * `setCookie`, `sessionId`, `dbUrl`, `databaseUrl`, `connectionString`,
 * `dsn`, `auth`, `pass`, `pwd`, `signature`). One field could therefore be
 * masked on one path and printed on another.
 *
 * This module owns the names. What each consumer keeps is genuinely its own:
 *
 * - **Matching.** The logger, the error reporter, the export and the audit
 *   diff over-redact by substring (a field called `tokenCount` is masked
 *   rather than leaked); the diagnostics match whole names only, because they
 *   show masked values to an operator and must not swallow `author`.
 * - **Values.** The error reporter also scrubs credential-shaped *values* (a
 *   `Bearer ...` inside a message), the logger and the export replace the
 *   value outright, and the diagnostics mask a connection string as a
 *   connection string.
 *
 * The names below are the union of the former lists, so every name that
 * was masked before is still masked — only the drift is gone.
 */

/**
 * Secret words, matched as a substring of the normalised key (lower-cased,
 * separators stripped) — `apiKey`, `api_key` and `API KEY` all normalise to
 * `apikey`.
 *
 * Every word here is unambiguous inside a longer name: none of them is a
 * prefix of an ordinary field (`token` is a prefix of `tokenCount`, which is
 * masked on purpose, but `auth` is a prefix of `author`, which is not).
 */
export const SECRET_KEY_FRAGMENTS: readonly string[] = [
  "password",
  "passwd",
  "passphrase",
  "passcode",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "privatekey",
  "authorization",
  "cookie",
  "credential",
  "sessionid",
  "dburl",
  "databaseurl",
  "connectionstring",
];

/**
 * Names that are secret on their own, matched as a whole key. They are either
 * too short or too ambiguous to be matched inside a longer name (`auth` must
 * not mask `author`, `pass` must not mask `bypass`, `pwd` must not mask
 * `pwdReset`), or they are compound names the diagnostics match exactly
 * (`accesstoken`, `clientsecret`, …) that the substring rule already covers
 * through `token`/`secret`.
 */
export const SECRET_KEY_NAMES: readonly string[] = [
  "auth",
  "pass",
  "pwd",
  "dsn",
  "setcookie",
  "credentials",
  "signature",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "clientsecret",
];

/** Every canonical secret name: the fragments plus the whole names. */
export const SECRET_KEY_LIST: readonly string[] = [
  ...SECRET_KEY_FRAGMENTS,
  ...SECRET_KEY_NAMES,
];

/**
 * Keys whose value is a connection string (`postgresql://user:pw@host/db`).
 * The diagnostics mask such a value as a connection string: host and database
 * stay readable, the credentials do not.
 */
export const CONNECTION_STRING_KEYS: readonly string[] = [
  "databaseurl",
  "connectionstring",
  "dburl",
  "dsn",
];

/**
 * Lower-case a key and strip separators, so `api_key`, `API-KEY` and `apiKey`
 * all compare alike.
 */
export function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NAME_SET = new Set(SECRET_KEY_NAMES);
const LIST_SET = new Set(SECRET_KEY_LIST);

/**
 * Whether `key` names a secret, by the over-broad substring rule: the
 * normalised key contains one of {@link SECRET_KEY_FRAGMENTS} or is one of
 * {@link SECRET_KEY_NAMES}. `tokenCount` matches (`token`), `author` does not
 * (`auth` is a whole name only).
 */
export function isSecretKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  const normalized = normalizeSecretKey(key);
  if (normalized.length === 0) return false;
  if (NAME_SET.has(normalized)) return true;
  for (const fragment of SECRET_KEY_FRAGMENTS) {
    if (normalized.includes(fragment)) return true;
  }
  return false;
}

/**
 * Whether `key` is one of the canonical secret names, matched as a whole
 * name. The env-secret diagnostics use this rule: they show masked values to
 * an operator, so they mask `apiKey` but leave `author` alone.
 */
export function isSecretKeyName(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  return LIST_SET.has(normalizeSecretKey(key));
}

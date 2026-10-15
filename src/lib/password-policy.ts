/**
 * Password policy: pure validation and strength scoring.
 *
 * This is the single source of truth for "is this password acceptable?" on the
 * signup and change-password paths. It is deliberately dependency-free and
 * side-effect-free so every branch is unit-testable and it can run on both the
 * client (live meter) and the server (authoritative check).
 *
 * The strength score blends three signals, then applies penalties for the
 * patterns an attacker tries first:
 *
 * - length, via an entropy estimate (`length * log2(alphabet size)`);
 * - variety, because the alphabet size is the sum of the character classes the
 *   password actually uses (lower/upper/digit/symbol);
 * - penalties for denylisted passwords, a repeated unit (`"abcabcabc"`), simple
 *   ascending/descending runs and keyboard rows (`"qwerty"`, `"1234"`).
 *
 * Nothing in this module throws: malformed input degrades to a failing result
 * rather than an exception, so a bad call can never take down a request.
 */

/** Configuration of the password policy. See {@link PASSWORD_POLICY}. */
export type PasswordPolicy = {
  /** Minimum number of characters (default `8`). */
  minLength: number;
  /** Require at least one `A-Z` character. */
  requireUpper: boolean;
  /** Require at least one `a-z` character. */
  requireLower: boolean;
  /** Require at least one `0-9` character. */
  requireDigit: boolean;
  /** Require at least one non-alphanumeric character. */
  requireSymbol: boolean;
  /** Reject passwords on the built-in denylist. */
  forbidCommon: boolean;
};

/**
 * Default policy. Mirrors `signupSchema` in `src/lib/validation.ts` (8-char
 * floor) and adds composition rules; symbols stay optional by default because
 * forcing them nudges users toward predictable `Password1!` patterns.
 */
export const PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: false,
  forbidCommon: true,
};

/**
 * Hard upper bound on password length, independent of {@link PasswordPolicy}.
 * Beyond a sane maximum there is only denial-of-service value, so it is capped
 * rather than configurable.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Why a password was rejected. Returned in a stable order so a UI can render
 * the list without re-sorting: `too_short`, `too_long`, `missing_lower`,
 * `missing_upper`, `missing_digit`, `missing_symbol`, `common`. `empty` and
 * `not_a_string` short-circuit and are the only element when they appear.
 */
export type PasswordIssue =
  | "empty"
  | "not_a_string"
  | "too_short"
  | "too_long"
  | "missing_lower"
  | "missing_upper"
  | "missing_digit"
  | "missing_symbol"
  | "common";

/** Result of {@link validatePassword}. */
export type PasswordValidation = {
  ok: boolean;
  issues: PasswordIssue[];
};

/** Human labels for scores `0..4`, indexed by score. */
export const PASSWORD_STRENGTH_LABELS = [
  "very weak",
  "weak",
  "fair",
  "good",
  "strong",
] as const;

export type PasswordStrengthLabel = (typeof PASSWORD_STRENGTH_LABELS)[number];

/** Result of {@link scorePassword}. */
export type PasswordScore = {
  score: 0 | 1 | 2 | 3 | 4;
  label: PasswordStrengthLabel;
};

const LOWERCASE = /[a-z]/;
const UPPERCASE = /[A-Z]/;
const DIGIT = /[0-9]/;
const SYMBOL = /[^A-Za-z0-9]/;

/**
 * A small denylist of passwords that top every breach corpus. Kept short on
 * purpose - it catches the passwords a real signup form sees, not the whole
 * rockyou list (which belongs behind a proper breach-check service).
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd",
  "123456",
  "12345678",
  "123456789",
  "1234567890",
  "111111",
  "000000",
  "123123",
  "qwerty",
  "qwerty123",
  "qwertyuiop",
  "abc123",
  "letmein",
  "welcome",
  "admin",
  "iloveyou",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "master",
  "sunshine",
  "princess",
  "login",
  "trustno1",
  "whatever",
  "starwars",
]);

/** Character-pool sizes used by the entropy heuristic. */
const POOL_LOWER = 26;
const POOL_UPPER = 26;
const POOL_DIGIT = 10;
const POOL_SYMBOL = 32;

/** Entropy-bit thresholds for scores `0..4` (upper-exclusive except the last). */
const ENTROPY_BREAKS = [28, 40, 60, 80] as const;

/** Keyboard rows, searched forward and backward, for run detection. */
const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"];

/** Resolve a (possibly partial/invalid) policy against the defaults. */
function resolvePolicy(policy?: Partial<PasswordPolicy>): PasswordPolicy {
  const source: Partial<PasswordPolicy> = policy ?? {};
  const minLength =
    typeof source.minLength === "number" &&
    Number.isInteger(source.minLength) &&
    source.minLength >= 1
      ? source.minLength
      : PASSWORD_POLICY.minLength;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  return {
    minLength,
    requireUpper: bool(source.requireUpper, PASSWORD_POLICY.requireUpper),
    requireLower: bool(source.requireLower, PASSWORD_POLICY.requireLower),
    requireDigit: bool(source.requireDigit, PASSWORD_POLICY.requireDigit),
    requireSymbol: bool(source.requireSymbol, PASSWORD_POLICY.requireSymbol),
    forbidCommon: bool(source.forbidCommon, PASSWORD_POLICY.forbidCommon),
  };
}

/**
 * Whether `password` is a known/derivable common password. Matching is
 * case-insensitive, trims surrounding whitespace, and also collapses a value
 * to its letters-only root so `"password!!"` and `"Passw0rd"`-style suffixes
 * still hit the list.
 */
export function isCommonPassword(password: unknown): boolean {
  if (typeof password !== "string") return false;
  const normalized = password.trim().toLowerCase();
  if (!normalized) return false;
  if (COMMON_PASSWORDS.has(normalized)) return true;
  const root = normalized.replace(/[^a-z]+/g, "");
  return root.length >= 4 && COMMON_PASSWORDS.has(root);
}

/**
 * Validate `password` against `policy` (defaults to {@link PASSWORD_POLICY}).
 * Returns every failing {@link PasswordIssue} rather than the first, so a UI
 * can show the full checklist. Non-string input yields `["not_a_string"]`.
 */
export function validatePassword(
  password: unknown,
  policy?: Partial<PasswordPolicy>,
): PasswordValidation {
  if (typeof password !== "string") {
    return { ok: false, issues: ["not_a_string"] };
  }
  if (password.length === 0) {
    return { ok: false, issues: ["empty"] };
  }
  const resolved = resolvePolicy(policy);
  const issues: PasswordIssue[] = [];
  if (password.length < resolved.minLength) issues.push("too_short");
  if (password.length > MAX_PASSWORD_LENGTH) issues.push("too_long");
  if (resolved.requireLower && !LOWERCASE.test(password)) issues.push("missing_lower");
  if (resolved.requireUpper && !UPPERCASE.test(password)) issues.push("missing_upper");
  if (resolved.requireDigit && !DIGIT.test(password)) issues.push("missing_digit");
  if (resolved.requireSymbol && !SYMBOL.test(password)) issues.push("missing_symbol");
  if (resolved.forbidCommon && isCommonPassword(password)) issues.push("common");
  return { ok: issues.length === 0, issues };
}

/** Sum of the character-class pool sizes the password actually draws from. */
function poolSize(password: string): number {
  let pool = 0;
  if (LOWERCASE.test(password)) pool += POOL_LOWER;
  if (UPPERCASE.test(password)) pool += POOL_UPPER;
  if (DIGIT.test(password)) pool += POOL_DIGIT;
  if (SYMBOL.test(password)) pool += POOL_SYMBOL;
  return pool || 1;
}

/** Naive entropy estimate in bits: `length * log2(alphabet)`. */
function estimateEntropyBits(password: string): number {
  return password.length * Math.log2(poolSize(password));
}

/** Score implied by the entropy estimate alone, before penalties. */
function baseScore(bits: number): number {
  if (!Number.isFinite(bits)) return 0;
  for (let index = 0; index < ENTROPY_BREAKS.length; index += 1) {
    if (bits < ENTROPY_BREAKS[index]) return index;
  }
  return 4;
}

/** True when the password is one unit repeated, e.g. `"aaaa"` or `"abcabcabc"`. */
function isRepeatedUnit(password: string): boolean {
  const maxUnit = Math.floor(password.length / 2);
  for (let size = 1; size <= maxUnit; size += 1) {
    if (password.length % size !== 0) continue;
    const unit = password.slice(0, size);
    if (unit.repeat(password.length / size) === password) return true;
  }
  return false;
}

/** True when a run of `minRun` consecutive code points ascends or descends by 1. */
function hasSequentialRun(password: string, minRun = 4): boolean {
  if (password.length < minRun) return false;
  let run = 1;
  let direction = 0;
  for (let index = 1; index < password.length; index += 1) {
    const delta = password.charCodeAt(index) - password.charCodeAt(index - 1);
    if (delta !== 1 && delta !== -1) {
      run = 1;
      direction = 0;
      continue;
    }
    if (delta === direction) {
      run += 1;
      if (run >= minRun) return true;
    } else {
      direction = delta;
      run = 2;
    }
  }
  return false;
}

/** True when the password contains a `minRun`-long keyboard row (either direction). */
function hasKeyboardRun(password: string, minRun = 4): boolean {
  const lower = password.toLowerCase();
  if (lower.length < minRun) return false;
  return KEYBOARD_ROWS.some((row) => {
    for (let start = 0; start + minRun <= row.length; start += 1) {
      const chunk = row.slice(start, start + minRun);
      const reversed = [...chunk].reverse().join("");
      if (lower.includes(chunk) || lower.includes(reversed)) return true;
    }
    return false;
  });
}

/**
 * Score `password` from `0` (very weak) to `4` (strong). Denylisted passwords
 * and a repeated unit collapse to `0`; sequential/keyboard runs cost one point.
 * Never throws - non-strings score `0`.
 */
export function scorePassword(password: unknown): PasswordScore {
  const value = typeof password === "string" ? password : "";
  let score = baseScore(estimateEntropyBits(value));
  if (isCommonPassword(value)) {
    score = 0;
  } else if (isRepeatedUnit(value)) {
    score -= 2;
  } else if (hasSequentialRun(value) || hasKeyboardRun(value)) {
    score -= 1;
  }
  const clamped = Math.max(0, Math.min(4, Math.round(score))) as 0 | 1 | 2 | 3 | 4;
  return { score: clamped, label: PASSWORD_STRENGTH_LABELS[clamped] };
}

/** Options for {@link maskPassword}. */
export type MaskPasswordOptions = {
  /** Number of trailing characters to leave visible (default `0`). */
  reveal?: number;
  /** Replacement glyph; only its first character is used (default `"•"`). */
  mask?: string;
};

/**
 * Mask a password for display, preserving its length so a viewer can still
 * gauge it. Optionally reveals the trailing `reveal` characters (a common
 * "confirm what I just typed" affordance). Empty/non-string input -> `""`.
 */
export function maskPassword(password: unknown, options: MaskPasswordOptions = {}): string {
  if (typeof password !== "string" || password.length === 0) return "";
  const glyph =
    typeof options.mask === "string" && options.mask.length > 0 ? options.mask.slice(0, 1) : "•";
  const rawReveal = options.reveal;
  const reveal = Math.min(
    Math.max(typeof rawReveal === "number" && Number.isFinite(rawReveal) ? Math.floor(rawReveal) : 0, 0),
    password.length,
  );
  const hidden = password.length - reveal;
  return glyph.repeat(hidden) + password.slice(hidden);
}

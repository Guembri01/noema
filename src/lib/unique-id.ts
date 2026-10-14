/**
 * Unique ID property: Notion-style human-readable row ids.
 *
 * A database's Unique ID property renders each row as `PREFIX-0042` (prefix,
 * separator, zero-padded monotonic counter). This module is the pure engine
 * behind that property: formatting, parsing, and monotonic allocation over the
 * ids already present in the database. It never touches the DB or React.
 *
 * Design choices (docs/MISSING_FEATURES.md §4 "Unique ID property"):
 *
 * - Allocation is derived from the MAXIMUM id already present, not the row
 *   count, so deleting rows never reuses an id (`nextNumbers`).
 * - Parsing is deliberately strict: a matching prefix is case-insensitive, the
 *   separator must match exactly, the numeric part must be all digits, at least
 *   `zeroPad` long, and a positive integer. Anything else — a mismatched
 *   prefix, a foreign separator, letters, or trailing junk — is rejected.
 * - Unparseable stored values are ignored rather than throwing, so a single
 *   hand-edited cell can never break allocation for the whole database.
 */

/** Configuration of a Unique ID property. */
export type UniqueIdConfig = {
  /** Stable row-id prefix, e.g. `"PROJ"`. See `isValidPrefix`. */
  prefix: string;
  /** First id that can be issued (default `1`). */
  startAt?: number;
  /** Minimum number of digits (default `4`); numbers grow past it, never truncate. */
  zeroPad?: number;
  /** Text between prefix and number (default `"-"`). */
  separator?: string;
};

/**
 * Why a string could not be parsed: empty input, a prefix that does not match,
 * a separator that does not match, or a numeric part that is not a valid,
 * sufficiently-padded positive integer.
 */
export type UniqueIdParseError =
  | "empty"
  | "wrong_prefix"
  | "wrong_separator"
  | "invalid_number";

/** Result of `parseUniqueId` — the parsed number, or the first failure reason. */
export type ParsedUniqueId =
  | { ok: true; number: number }
  | { ok: false; error: UniqueIdParseError };

/** Config with every optional field resolved to its default. */
type ResolvedConfig = {
  prefix: string;
  startAt: number;
  zeroPad: number;
  separator: string;
};

const DEFAULT_START_AT = 1;
const DEFAULT_ZERO_PAD = 4;
const DEFAULT_SEPARATOR = "-";

/** A prefix is 1+ word characters (letters/digits/underscore), nothing else. */
const PREFIX_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Whether `prefix` is usable as a Unique ID prefix: a non-empty string of
 * letters, digits and underscores. Spaces, separators and other punctuation are
 * rejected so a formatted id is never ambiguous.
 */
export function isValidPrefix(prefix: unknown): boolean {
  return typeof prefix === "string" && PREFIX_PATTERN.test(prefix);
}

/** Fill in defaults; sanitise malformed optional values so callers never throw. */
function resolveConfig(config: UniqueIdConfig): ResolvedConfig {
  const prefix = typeof config?.prefix === "string" ? config.prefix : "";
  const rawStartAt = config?.startAt;
  const startAt =
    typeof rawStartAt === "number" && Number.isInteger(rawStartAt) && rawStartAt >= 1
      ? rawStartAt
      : DEFAULT_START_AT;
  const rawZeroPad = config?.zeroPad;
  const zeroPad =
    typeof rawZeroPad === "number" && Number.isInteger(rawZeroPad) && rawZeroPad >= 1
      ? rawZeroPad
      : DEFAULT_ZERO_PAD;
  const separator = typeof config?.separator === "string" ? config.separator : DEFAULT_SEPARATOR;
  return { prefix, startAt, zeroPad, separator };
}

/**
 * Render a row number as a Unique ID string, e.g. `formatUniqueId({ prefix:
 * "PROJ" }, 42) === "PROJ-0042"`.
 *
 * Zero-padding is a minimum: a number wider than `zeroPad` keeps every digit
 * (`10000` becomes `"PROJ-10000"`, never truncated).
 *
 * @throws RangeError when `value` is not a positive integer.
 */
export function formatUniqueId(config: UniqueIdConfig, value: number): string {
  const { prefix, separator, zeroPad } = resolveConfig(config);
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`Unique ID value must be a positive integer, got ${value}.`);
  }
  return `${prefix}${separator}${String(value).padStart(zeroPad, "0")}`;
}

/**
 * Parse a formatted id back to its number.
 *
 * The prefix is compared case-insensitively; the separator must match exactly;
 * the numeric remainder must be all digits, at least `zeroPad` long, and a
 * positive safe integer. Trailing junk, a foreign prefix/separator, or a
 * too-short numeric part fail with a `UniqueIdParseError`.
 */
export function parseUniqueId(formatted: string, config: UniqueIdConfig): ParsedUniqueId {
  const { prefix, separator, zeroPad } = resolveConfig(config);
  if (typeof formatted !== "string" || formatted.trim() === "") {
    return { ok: false, error: "empty" };
  }
  if (formatted.length < prefix.length) {
    return { ok: false, error: "wrong_prefix" };
  }
  if (formatted.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return { ok: false, error: "wrong_prefix" };
  }
  const afterPrefix = formatted.slice(prefix.length);
  if (!afterPrefix.startsWith(separator)) {
    return { ok: false, error: "wrong_separator" };
  }
  const digits = afterPrefix.slice(separator.length);
  if (!/^\d+$/.test(digits) || digits.length < zeroPad) {
    return { ok: false, error: "invalid_number" };
  }
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) {
    return { ok: false, error: "invalid_number" };
  }
  return { ok: true, number };
}

/**
 * The next `count` numbers after the highest id currently in `existing`.
 *
 * Deriving from the maximum (not the count) makes deletion and gaps safe: with
 * ids 1, 2 and 7 the next number is 8. Entries that do not parse are ignored,
 * never thrown on, and an empty (or all-unparseable) list starts at `startAt`.
 */
export function nextNumbers(config: UniqueIdConfig, existing: string[], count = 1): number[] {
  const { startAt } = resolveConfig(config);
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (total === 0) return [];

  const list: readonly unknown[] = Array.isArray(existing) ? existing : [];
  let max = startAt - 1;
  for (const entry of list) {
    const parsed = parseUniqueId(entry as string, config);
    if (parsed.ok && parsed.number > max) max = parsed.number;
  }

  const numbers: number[] = [];
  for (let step = 1; step <= total; step += 1) numbers.push(max + step);
  return numbers;
}

/**
 * Allocate `count` new formatted ids, strictly larger than every id already in
 * `existing` and unique within the batch. Shorthand for formatting the result
 * of `nextNumbers`.
 */
export function allocateIds(config: UniqueIdConfig, existing: string[], count = 1): string[] {
  return nextNumbers(config, existing, count).map((number) => formatUniqueId(config, number));
}

/**
 * Whether `formatted` already exists in `existing`, compared case-insensitively
 * so `"proj-0002"` and `"PROJ-0002"` are the same id.
 */
export function hasUniqueId(existing: string[], formatted: string): boolean {
  if (typeof formatted !== "string" || formatted.trim() === "") return false;
  const needle = formatted.toLowerCase();
  const list: readonly unknown[] = Array.isArray(existing) ? existing : [];
  return list.some((entry) => typeof entry === "string" && entry.toLowerCase() === needle);
}

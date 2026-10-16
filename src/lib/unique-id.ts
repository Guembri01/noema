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
 *
 * This file additionally carries the richer engine spec'd by
 * docs/specs/database-deep.md R89.25 — a `Counter = { databaseId, lastSeq }`
 * per-database allocator that hands out contiguous, immutable, monotonic
 * blocks (`nextUniqueId`, `allocate`), a config normaliser/validator
 * (`parseUniqueIdConfig`, `validateUniqueIdConfig`), seq-aware sorting
 * (`sortBySeq`), a human description (`describeUniqueId`) and a collision guard
 * (`collisionCheck`). The older formatting/allocating helpers are unchanged and
 * both `formatUniqueId(config, n)` and `formatUniqueId(n, config)` call shapes
 * are supported.
 */

/** Configuration of a Unique ID property. */
export type UniqueIdConfig = {
  /**
   * Stable row-id prefix, e.g. `"TASK"`. Optional so a caller can hold a partial
   * config; `parseUniqueIdConfig` fills in the `"ID"` default, while the raw
   * formatting helpers treat a missing prefix as `""`. See `isValidPrefix`.
   */
  prefix?: string;
  /** First id that can be issued (default `1`). */
  startAt?: number;
  /** Minimum number of digits (default `4`), clamped to `1..12`; numbers grow past it. */
  padding?: number;
  /** Legacy alias of `padding`; `padding` wins when both are present. */
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

/**
 * Result of `parseUniqueId` — on success the parsed number plus the configured
 * `prefix` and the same value as `seq` (the R89.25 spelling), or the first
 * failure reason.
 */
export type ParsedUniqueId =
  | { ok: true; number: number; prefix: string; seq: number }
  | { ok: false; error: UniqueIdParseError };

/** The high-water mark of the id sequence for one database. */
export type Counter = {
  databaseId: string;
  lastSeq: number;
};

/** A problem `validateUniqueIdConfig` can report. */
export type UniqueIdIssueCode =
  | "INVALID_PREFIX"
  | "PADDING_OUT_OF_RANGE"
  | "START_AT_OUT_OF_RANGE";

/** One problem with a Unique ID configuration. */
export type UniqueIdIssue = {
  code: UniqueIdIssueCode;
  message: string;
};

/** Options for `sortBySeq`. */
export type SortBySeqOptions = {
  /** The row key that holds the formatted id (or a raw sequence number). */
  key: string;
  /** The config used to parse the formatted ids. */
  config?: UniqueIdConfig;
};

/** The report returned by `collisionCheck`. */
export type CollisionReport = {
  ok: boolean;
  duplicates: string[];
};

/** The result of advancing a counter by one (`nextUniqueId`). */
export type NextUniqueIdResult = {
  counter: Counter;
  seq: number;
  id: string;
};

/** The result of allocating a contiguous block (`allocate`). */
export type AllocationResult = {
  /** A new counter list — the input is never mutated. */
  counters: Counter[];
  /** The updated counter for the allocated database. */
  counter: Counter;
  /** The contiguous sequence numbers handed out, in order. */
  seqs: number[];
  /** The formatted ids matching `seqs`. */
  ids: string[];
};

/** Config with every optional field resolved to its default. */
type ResolvedConfig = {
  prefix: string;
  startAt: number;
  zeroPad: number;
  separator: string;
};

const DEFAULT_PREFIX = "ID";
const DEFAULT_START_AT = 1;
const DEFAULT_PADDING = 4;
const DEFAULT_ZERO_PAD = DEFAULT_PADDING;
const DEFAULT_SEPARATOR = "-";
const MIN_PADDING = 1;
const MAX_PADDING = 12;
const MAX_PREFIX_LENGTH = 12;

/** A prefix is 1+ word characters (letters/digits/underscore), nothing else. */
const PREFIX_PATTERN = /^[A-Za-z0-9_]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `prefix` is usable as a Unique ID prefix: a non-empty string of
 * letters, digits and underscores. Spaces, separators and other punctuation are
 * rejected so a formatted id is never ambiguous.
 */
export function isValidPrefix(prefix: unknown): boolean {
  return typeof prefix === "string" && PREFIX_PATTERN.test(prefix);
}

/** A whole padding clamped to `1..12`, falling back to 4 for anything unusable. */
function clampPadding(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_ZERO_PAD;
  if (value < MIN_PADDING) return DEFAULT_ZERO_PAD;
  return Math.min(MAX_PADDING, value);
}

/** The configured start, defaulting to 1 for anything that is not an integer >= 1. */
function normalizeStartAt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_START_AT;
}

/** Fill in defaults; sanitise malformed optional values so callers never throw. */
function resolveConfig(config?: UniqueIdConfig): ResolvedConfig {
  const prefix = typeof config?.prefix === "string" ? config.prefix : "";
  const startAt = normalizeStartAt(config?.startAt);
  const zeroPad = clampPadding(config?.padding ?? config?.zeroPad);
  const separator = typeof config?.separator === "string" ? config.separator : DEFAULT_SEPARATOR;
  return { prefix, startAt, zeroPad, separator };
}

/**
 * Render a row number as a Unique ID string. Both argument orders are accepted:
 * `formatUniqueId({ prefix: "TASK" }, 42)` and `formatUniqueId(42, { prefix:
 * "TASK" })` both yield `"TASK-0042"`.
 *
 * Zero-padding is a minimum: a number wider than the padding keeps every digit
 * (`10000` becomes `"TASK-10000"`, never truncated).
 *
 * @throws RangeError when `value` is not a positive integer.
 */
export function formatUniqueId(config: UniqueIdConfig | undefined, value: number): string;
export function formatUniqueId(value: number, config?: UniqueIdConfig): string;
export function formatUniqueId(
  first: UniqueIdConfig | number | undefined,
  second?: UniqueIdConfig | number,
): string {
  const value = typeof first === "number" ? first : (second as number);
  const config: UniqueIdConfig | undefined =
    typeof first === "number" ? (second as UniqueIdConfig | undefined) : first;
  const { prefix, separator, zeroPad } = resolveConfig(config);
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`Unique ID value must be a positive integer, got ${value}.`);
  }
  return `${prefix}${separator}${String(value).padStart(zeroPad, "0")}`;
}

/**
 * Parse a formatted id back to its number.
 *
 * The prefix is compared case-insensitively (and literally — regex
 * metacharacters carry no special meaning); the separator must match exactly;
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
  return { ok: true, number, prefix, seq: number };
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

// ---------------------------------------------------------------------------
// R89.25 — config normalisation, validation, counters, sorting, collision guard
// ---------------------------------------------------------------------------

/** Read an untrusted raw value into a plain record, unwrapping `{ uniqueId }`. */
function configRecord(raw: unknown): Record<string, unknown> {
  let source: unknown = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = null;
    }
  }
  if (isRecord(source) && isRecord(source.uniqueId)) source = source.uniqueId;
  return isRecord(source) ? source : {};
}

/**
 * Coerce an untrusted raw config (object, JSON string, or `{ uniqueId }` block)
 * into the canonical shape. Missing fields default to `prefix: "ID"`,
 * `padding: 4`, `startAt: 1`; a legacy `zeroPad` is read as `padding`; an
 * out-of-range padding falls back to the default. Never throws. A `prefix` that
 * is present (even empty) is preserved so `validateUniqueIdConfig` can flag it.
 * Idempotent.
 */
export function parseUniqueIdConfig(raw: unknown): UniqueIdConfig {
  const record = configRecord(raw);
  const prefix = typeof record.prefix === "string" ? record.prefix : DEFAULT_PREFIX;
  const padding = clampPadding(record.padding ?? record.zeroPad);
  const startAt = normalizeStartAt(record.startAt);
  const separator = typeof record.separator === "string" ? record.separator : undefined;
  return separator === undefined
    ? { prefix, padding, startAt }
    : { prefix, padding, startAt, separator };
}

/**
 * Validate a Unique ID configuration, returning one structured issue per
 * problem (prefix charset/length, padding `1..12`, `startAt >= 1`). Absent
 * fields are valid — the defaults are always usable. Never throws.
 */
export function validateUniqueIdConfig(config: unknown): UniqueIdIssue[] {
  const issues: UniqueIdIssue[] = [];
  const record = configRecord(config);

  if ("prefix" in record) {
    const prefix = record.prefix;
    if (
      typeof prefix !== "string" ||
      !isValidPrefix(prefix) ||
      prefix.length > MAX_PREFIX_LENGTH
    ) {
      issues.push({
        code: "INVALID_PREFIX",
        message: `Prefix must be 1-${MAX_PREFIX_LENGTH} letters, digits or underscores.`,
      });
    }
  }

  const padding = record.padding ?? record.zeroPad;
  if (padding !== undefined) {
    if (
      typeof padding !== "number" ||
      !Number.isInteger(padding) ||
      padding < MIN_PADDING ||
      padding > MAX_PADDING
    ) {
      issues.push({
        code: "PADDING_OUT_OF_RANGE",
        message: `Padding must be an integer from ${MIN_PADDING} to ${MAX_PADDING}.`,
      });
    }
  }

  const startAt = record.startAt;
  if (startAt !== undefined) {
    if (typeof startAt !== "number" || !Number.isInteger(startAt) || startAt < 1) {
      issues.push({
        code: "START_AT_OUT_OF_RANGE",
        message: "Start must be an integer of at least 1.",
      });
    }
  }

  return issues;
}

/**
 * Advance `counter` by exactly one id. Pure and immutable: the returned
 * `counter` is a new object and the input is left untouched. The first id
 * respects `startAt`, and every subsequent id is one above the previous.
 */
export function nextUniqueId(counter: Counter, config?: UniqueIdConfig): NextUniqueIdResult {
  const { startAt } = resolveConfig(config);
  const databaseId = typeof counter?.databaseId === "string" ? counter.databaseId : "";
  const last =
    typeof counter?.lastSeq === "number" && Number.isInteger(counter.lastSeq)
      ? counter.lastSeq
      : startAt - 1;
  const seq = Math.max(last + 1, startAt);
  return {
    counter: { databaseId, lastSeq: seq },
    seq,
    id: formatUniqueId(seq, config),
  };
}

/**
 * Atomically allocate a contiguous block of `count` ids for `databaseId`.
 * Returns new counters (the input array is never mutated), the contiguous
 * sequence numbers and their formatted ids. The database's counter advances by
 * exactly `count`, so sequential/chained calls are monotonic and never reuse an
 * id; a database that has no counter yet starts at `startAt`.
 */
export function allocate(
  counters: readonly Counter[],
  databaseId: string,
  count: number,
  config?: UniqueIdConfig,
): AllocationResult {
  const { startAt } = resolveConfig(config);
  const total =
    typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const list: readonly Counter[] = Array.isArray(counters) ? counters : [];
  const existing = list.find((entry) => entry && entry.databaseId === databaseId);
  const base =
    existing && Number.isInteger(existing.lastSeq)
      ? Math.max(existing.lastSeq, startAt - 1)
      : startAt - 1;

  const seqs: number[] = [];
  for (let step = 1; step <= total; step += 1) seqs.push(base + step);

  const counter: Counter = { databaseId, lastSeq: total === 0 ? base : base + total };
  const nextCounters = list.map((entry) => ({
    databaseId: entry.databaseId,
    lastSeq: entry.databaseId === databaseId ? counter.lastSeq : entry.lastSeq,
  }));
  if (!existing) nextCounters.push(counter);

  const ids = seqs.map((seq) => formatUniqueId(seq, config));
  return { counters: nextCounters, counter, seqs, ids };
}

/** The sequence number encoded in one row, or `Infinity` when unparseable. */
function seqOfRow(row: unknown, key: string, config?: UniqueIdConfig): number {
  if (!isRecord(row)) return Number.POSITIVE_INFINITY;
  const value = row[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = parseUniqueId(value, config ?? {});
    if (parsed.ok) return parsed.seq;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Sort rows by the numeric sequence encoded in `options.key`, not by the
 * formatted string (`T-9` sorts before `T-10`). Raw integer values sort
 * numerically too. Stable for ties, keeps unparseable rows last, and never
 * mutates the input array.
 */
export function sortBySeq<T>(rows: readonly T[], options: SortBySeqOptions): T[] {
  const { key, config } = options;
  return rows
    .map((row, index) => ({ row, index, seq: seqOfRow(row, key, config) }))
    .sort((a, b) => (a.seq === b.seq ? a.index - b.index : a.seq - b.seq))
    .map((entry) => entry.row);
}

/**
 * A one-line, human-readable description of a Unique ID property, e.g.
 * `Unique ID "TASK": 4-digit sequence starting at 1 (e.g. TASK-0001)`.
 */
export function describeUniqueId(config?: UniqueIdConfig): string {
  const { prefix, padding, startAt } = parseUniqueIdConfig(config);
  const first = startAt ?? DEFAULT_START_AT;
  const digits = padding ?? DEFAULT_PADDING;
  const sample = formatUniqueId(first, { prefix, padding: digits, startAt: first });
  return `Unique ID "${prefix}": ${digits}-digit sequence starting at ${first} (e.g. ${sample})`;
}

/**
 * Guard a list of formatted ids for duplicates, compared case-insensitively
 * after trimming. Blank and non-string entries are ignored. `duplicates` lists
 * each colliding id once, in first-seen order and original casing.
 */
export function collisionCheck(values: readonly unknown[]): CollisionReport {
  const list: readonly unknown[] = Array.isArray(values) ? values : [];
  const firstSeen = new Map<string, string>();
  const flagged = new Set<string>();
  const duplicates: string[] = [];

  for (const value of list) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    const prior = firstSeen.get(key);
    if (prior === undefined) {
      firstSeen.set(key, trimmed);
      continue;
    }
    if (!flagged.has(key)) {
      flagged.add(key);
      duplicates.push(prior);
    }
  }

  return { ok: duplicates.length === 0, duplicates };
}

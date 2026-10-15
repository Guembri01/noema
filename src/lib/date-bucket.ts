/**
 * Date bucketing — pure, UTC-only grouping of dated entries into calendar
 * buckets (docs/FEATURE_MATRIX.md grouped views; the "by day/week/month"
 * family). This is the general core behind a dated group-by: it turns an ISO
 * instant into a canonical, sortable key, labels that key for display, and
 * folds a list of entries into chronologically ordered buckets.
 *
 * Public surface:
 *
 *   • `bucketKey(iso, unit)`              — instant → canonical key
 *   • `bucketLabel(key, unit)`            — key → human label
 *   • `bucketRange(key, unit)`            — key → inclusive `{ start, end }`
 *   • `groupByBucket(entries, options)`   — entries → ordered buckets
 *   • `BucketUnit` / `Bucket<T>`          — the unit + bucket types
 *
 * Design rules, matching the rest of `src/lib`:
 *
 * - **Pure UTC, deterministic.** Every boundary is computed from calendar
 *   components straight to a UTC instant (`Date.UTC`), and every label is
 *   formatted with an explicit `timeZone: "UTC"`. Neither the machine
 *   timezone nor DST can leak into a key, a range or a label, so server render
 *   and client paint stay byte-identical. Nothing here reads the wall clock.
 * - **Naive and offset datetimes resolve to UTC.** A `…Z`/`±hh:mm` suffix is
 *   honoured; a zone-less `YYYY-MM-DDTHH:MM` is read as UTC (never local), so
 *   the same input buckets the same way on every machine.
 * - **Canonical, lexicographically ordered keys.** `YYYY-MM-DD`,
 *   `YYYY-Www` (zero-padded ISO week, Monday start, ISO week-year at the
 *   Dec/Jan seam), `YYYY-MM`, `YYYY-Qn`, `YYYY` — plain string sort already
 *   yields chronological order.
 * - **Fail-safe.** Untrusted keys and ISO strings degrade to `""` (key/label)
 *   or `null` (range) rather than throwing; a bad date in a list is skipped.
 * - **Inclusive ranges.** A bucket spans `…T00:00:00.000Z` through
 *   `…T23:59:59.999Z`, so a week crossing a year boundary is still one range.
 */

/** The calendar buckets an entry can be sorted into. */
export type BucketUnit = "day" | "week" | "month" | "quarter" | "year";

/** One bucket of entries sharing a key, with its display label. */
export type Bucket<T> = {
  /** Canonical key from `bucketKey` (sorts chronologically). */
  key: string;
  /** Human label from `bucketLabel`. */
  label: string;
  /** The entries in this bucket, in input order (stable). */
  entries: T[];
};

/** Inclusive UTC bounds of a bucket, as ISO instants. */
export type BucketRange = { start: string; end: string };

const MS_PER_DAY = 86_400_000;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_KEY = /^(\d{4})-W(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const QUARTER_KEY = /^(\d{4})-Q([1-4])$/;
const YEAR_KEY = /^(\d{4})$/;

const pad2 = (value: number): string => String(value).padStart(2, "0");
const pad4 = (value: number): string => String(value).padStart(4, "0");

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Days in `month` (1–12) of `year`. */
function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Calendar-valid day, checked without constructing a `Date` (UTC-safe). */
function isValidDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/** Absolute UTC instant (ms) of a valid ISO string; `NaN` when unparseable. */
function instantOf(value: string): number {
  const iso = value.trim();
  const dateOnly = DATE_ONLY.exec(iso);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!isValidDay(year, month, day)) return Number.NaN;
    return Date.UTC(year, month - 1, day);
  }
  const match = DATE_TIME.exec(iso);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] ? Number(match[6]) : 0;
  if (!isValidDay(year, month, day) || hours > 23 || minutes > 59 || seconds > 59) {
    return Number.NaN;
  }
  const ms = match[7] ? Number(match[7].padEnd(3, "0")) : 0;
  let instant = Date.UTC(year, month - 1, day, hours, minutes, seconds, ms);
  const zone = match[8];
  if (zone && zone !== "Z" && zone !== "z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2));
    instant -= sign * offsetMinutes * 60_000;
  }
  return instant;
}

/** ISO-8601 week-year + week number of an instant (Monday start). */
function isoWeekOf(ms: number): { year: number; week: number } {
  const date = new Date(ms);
  const dayNum = date.getUTCDay() || 7; // Mon = 1 … Sun = 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // Thursday of this week
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / MS_PER_DAY + 1) / 7);
  return { year, week };
}

/** The Monday (as calendar components) starting ISO week `week` of `isoYear`. */
function isoWeekStart(
  isoYear: number,
  isoWeek: number,
): { year: number; month: number; day: number } {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4)); // Jan 4 is always in week 1
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (isoWeek - 1) * 7);
  return { year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate() };
}

/**
 * Canonical, sortable key of the bucket holding `iso` under `unit`. Pure UTC:
 * an offset/naive datetime is resolved to UTC first, so the key never depends
 * on the machine timezone. Returns `""` for an invalid instant or unit.
 */
export function bucketKey(iso: string, unit: BucketUnit): string {
  if (typeof iso !== "string") return "";
  const ms = instantOf(iso);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  switch (unit) {
    case "day":
      return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
    case "week": {
      const week = isoWeekOf(ms);
      return `${pad4(week.year)}-W${pad2(week.week)}`;
    }
    case "month":
      return `${pad4(year)}-${pad2(month)}`;
    case "quarter":
      return `${pad4(year)}-Q${Math.floor((month - 1) / 3) + 1}`;
    case "year":
      return pad4(year);
    default:
      // Unknown unit at runtime (untyped callers): fail safe, never throw.
      return "";
  }
}

/** Start components + day span of a bucket key; `null` when the key is invalid. */
type BucketStart = { year: number; month: number; day: number; spanDays: number };

function parseBucketKey(key: string, unit: BucketUnit): BucketStart | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  switch (unit) {
    case "day": {
      const match = DAY_KEY.exec(trimmed);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (!isValidDay(year, month, day)) return null;
      return { year, month, day, spanDays: 1 };
    }
    case "week": {
      const match = WEEK_KEY.exec(trimmed);
      if (!match) return null;
      const year = Number(match[1]);
      const week = Number(match[2]);
      if (week < 1 || week > 53) return null;
      const start = isoWeekStart(year, week);
      // Reject a 53rd week in a 52-week year by round-tripping the week number.
      const roundTrip = isoWeekOf(Date.UTC(start.year, start.month - 1, start.day));
      if (roundTrip.year !== year || roundTrip.week !== week) return null;
      return { ...start, spanDays: 7 };
    }
    case "month": {
      const match = MONTH_KEY.exec(trimmed);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      if (month < 1 || month > 12) return null;
      return { year, month, day: 1, spanDays: daysInMonth(year, month) };
    }
    case "quarter": {
      const match = QUARTER_KEY.exec(trimmed);
      if (!match) return null;
      const year = Number(match[1]);
      const month = (Number(match[2]) - 1) * 3 + 1;
      const spanDays =
        daysInMonth(year, month) +
        daysInMonth(year, month + 1) +
        daysInMonth(year, month + 2);
      return { year, month, day: 1, spanDays };
    }
    case "year": {
      const match = YEAR_KEY.exec(trimmed);
      if (!match) return null;
      const year = Number(match[1]);
      return { year, month: 1, day: 1, spanDays: isLeapYear(year) ? 366 : 365 };
    }
    default:
      return null;
  }
}

/** UTC instant (ms) at the start of the bucket `key` names; `0` when invalid. */
function bucketStartMs(key: string, unit: BucketUnit): number {
  const range = bucketRange(key, unit);
  return range ? Date.parse(range.start) : 0;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

/**
 * Human label for a bucket key, formatted in UTC so the machine timezone never
 * changes it: a day is `"Mar 3, 2026"`, a week `"Week of Mar 2, 2026"` (its
 * Monday), a month `"March 2026"`, a quarter `"Q1 2026"`, a year `"2026"`.
 * Returns `""` for an invalid key or unit.
 */
export function bucketLabel(key: string, unit: BucketUnit): string {
  const start = parseBucketKey(key, unit);
  if (!start) return "";
  const ms = Date.UTC(start.year, start.month - 1, start.day);
  switch (unit) {
    case "day":
      return DAY_FORMAT.format(ms);
    case "week":
      return `Week of ${DAY_FORMAT.format(ms)}`;
    case "month":
      return MONTH_FORMAT.format(ms);
    case "quarter":
      return `Q${Math.floor((start.month - 1) / 3) + 1} ${start.year}`;
    case "year":
      return String(start.year);
    default:
      return "";
  }
}

/**
 * Inclusive UTC bounds of the bucket `key` names — `start` at `00:00:00.000`
 * and `end` at `23:59:59.999` on the last day. Returns `null` for an invalid
 * key so a caller can skip it.
 */
export function bucketRange(key: string, unit: BucketUnit): BucketRange | null {
  const start = parseBucketKey(key, unit);
  if (!start) return null;
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(
    start.year,
    start.month - 1,
    start.day + start.spanDays - 1,
    23,
    59,
    59,
    999,
  );
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

/**
 * Fold `entries` into buckets by `unit`, ordered chronologically by bucket
 * start. `dateOf` supplies each entry's ISO instant; entries whose date is
 * `null`/`undefined`/invalid are skipped. Entries keep their input order within
 * a bucket, and the input array is never mutated.
 */
export function groupByBucket<T>(
  entries: readonly T[],
  options: { dateOf: (entry: T) => string | null | undefined; unit: BucketUnit },
): Bucket<T>[] {
  const { dateOf, unit } = options;
  const byKey = new Map<string, Bucket<T>>();
  for (const entry of entries) {
    const iso = dateOf(entry);
    if (iso === null || iso === undefined) continue;
    const key = bucketKey(iso, unit);
    if (key === "") continue;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { key, label: bucketLabel(key, unit), entries: [] };
      byKey.set(key, bucket);
    }
    bucket.entries.push(entry);
  }
  return [...byKey.values()].sort(
    (a, b) => bucketStartMs(a.key, unit) - bucketStartMs(b.key, unit),
  );
}

/**
 * Duration parsing and formatting — one pure home for "how long" values.
 *
 * A duration is always a signed number of milliseconds. This module knows how
 * to read one out of free text (`"2h 30m"`, `"1 day 2 hours"`) and out of an
 * ISO-8601 duration (`"PT1H30M"`, `"P1DT2H"`), how to write one back in three
 * UI shapes (`short`, `long`, `clock`), how to phrase it relative to an instant
 * ("in 2 hours" / "3 days ago") and how to add one to a date.
 *
 * PURE module: no prisma, no `node:*`, no ambient clock. `humanizeDuration`
 * measures against an instant only when it is handed one, so a property editor,
 * a ticket row and a reminder all derive identical strings. Every function is
 * fail-soft — unparseable input returns `null`, and unusable numbers render `""`
 * rather than throwing, so a bad row can never crash a render.
 *
 * Red-first unit-pinned by `src/lib/duration.test.ts`.
 */

export type DurationStyle = "short" | "long" | "clock";

export type FormatDurationOptions = {
  /** Output shape. Defaults to `"short"` (`"2h 30m"`). */
  style?: DurationStyle;
};

export type HumanizeDurationOptions = {
  /**
   * Reference instant. When supplied, the first argument is read as an
   * **absolute** instant (epoch ms) and the phrase describes `ms - now`;
   * omitted, the first argument is a signed duration offset.
   */
  now?: Date | number | string;
};

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Canonical alias table: lowercase unit token → milliseconds. `m` is a minute
 * and `mo` a month, so compact input stays unambiguous. Overridable callers can
 * merge their own tokens on top.
 */
export const DEFAULT_DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  msec: 1,
  millisecond: 1,
  milliseconds: 1,
  s: SECOND,
  sec: SECOND,
  secs: SECOND,
  second: SECOND,
  seconds: SECOND,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
  w: WEEK,
  wk: WEEK,
  week: WEEK,
  weeks: WEEK,
  mo: MONTH,
  month: MONTH,
  months: MONTH,
  y: YEAR,
  yr: YEAR,
  year: YEAR,
  years: YEAR,
};

/** `P[nW][nD][T[nH][nM][nS]]`, signed, case-insensitive, fractions allowed. */
const ISO_DURATION_RE =
  /^([+-])?P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/** Parse a `Date | number | string` into an epoch instant, or `null`. */
function toEpoch(value: Date | number | string): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Read an ISO-8601 duration. Requires at least one component and rejects a
 * dangling time designator (`"P1DT"`); the leading sign negates the total.
 */
function parseIsoDuration(text: string): number | null {
  const match = ISO_DURATION_RE.exec(text);
  if (!match) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  if (
    weeks === undefined &&
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return null;
  }
  if (/t\s*$/i.test(text) && hours === undefined && minutes === undefined && seconds === undefined) {
    return null;
  }
  let total = 0;
  if (weeks !== undefined) total += Number(weeks) * WEEK;
  if (days !== undefined) total += Number(days) * DAY;
  if (hours !== undefined) total += Number(hours) * HOUR;
  if (minutes !== undefined) total += Number(minutes) * MINUTE;
  if (seconds !== undefined) total += Number(seconds) * SECOND;
  if (!Number.isFinite(total)) return null;
  return sign === "-" ? -total : total;
}

/**
 * Read compact input. An optional leading sign negates the sum; every
 * `<number><unit>` component is added, unknown units and any leftover text (a
 * bare number, a stray word) yield `null`.
 */
function parseHumanDuration(text: string): number | null {
  let sign = 1;
  let body = text;
  if (body.startsWith("+") || body.startsWith("-")) {
    if (body.startsWith("-")) sign = -1;
    body = body.slice(1).trim();
  }
  if (body === "") return null;

  // Declared per call: a module-level `g` regex would leak `lastIndex` between
  // calls on the early-return paths below.
  const componentRe = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
  let total = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = componentRe.exec(body)) !== null) {
    const value = Number(match[1]);
    const factor = DEFAULT_DURATION_UNITS[match[2].toLowerCase()];
    if (factor === undefined || !Number.isFinite(value)) return null;
    total += value * factor;
    count += 1;
  }
  if (count === 0 || !Number.isFinite(total)) return null;
  if (body.replace(componentRe, " ").replace(/[\s,]+/g, "") !== "") return null;
  return sign * total;
}

/**
 * Parse a duration into milliseconds, or `null` when it cannot be understood.
 * An ISO-8601 duration (`P…`, sign and case insensitive) is detected by its
 * `P` prefix; everything else is read as compact `<number><unit>` input.
 */
export function parseDuration(input: string): number | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (text === "") return null;
  return /^[+-]?p/i.test(text) ? parseIsoDuration(text) : parseHumanDuration(text);
}

/** Descending size table shared by `short`/`long` output. */
const FORMAT_UNITS: readonly (readonly [number, string, string, string])[] = [
  [WEEK, "w", "week", "weeks"],
  [DAY, "d", "day", "days"],
  [HOUR, "h", "hour", "hours"],
  [MINUTE, "m", "minute", "minutes"],
  [SECOND, "s", "second", "seconds"],
];

/** Unit table used to bucket a delta into one whole humanised unit. */
const HUMAN_UNITS: readonly (readonly [number, string, string])[] = [
  [YEAR, "year", "years"],
  [MONTH, "month", "months"],
  [WEEK, "week", "weeks"],
  [DAY, "day", "days"],
  [HOUR, "hour", "hours"],
  [MINUTE, "minute", "minutes"],
  [SECOND, "second", "seconds"],
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `HH:MM:SS` (hours grow past 99 rather than wrapping), sign preserved. */
function formatClock(ms: number): string {
  const negative = ms < 0;
  const totalSeconds = Math.floor(Math.abs(ms) / SECOND);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${negative ? "-" : ""}${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** `short`/`long` output: every non-zero unit, largest first. */
function formatUnits(ms: number, style: "short" | "long"): string {
  const negative = ms < 0;
  const abs = Math.round(Math.abs(ms));
  if (abs === 0) return style === "long" ? "0 seconds" : "0s";
  if (abs < SECOND) return style === "long" ? `${abs} milliseconds` : `${abs}ms`;

  let remainder = abs;
  const parts: string[] = [];
  for (const [size, short, singular, plural] of FORMAT_UNITS) {
    const value = Math.floor(remainder / size);
    if (value > 0) {
      parts.push(
        style === "long" ? `${value} ${value === 1 ? singular : plural}` : `${value}${short}`,
      );
      remainder -= value * size;
    }
  }
  return `${negative ? "-" : ""}${parts.join(" ")}`;
}

/**
 * Render a duration in milliseconds.
 *   • `short` — `"2h 30m"` (default), sub-second as `"500ms"`, zero as `"0s"`.
 *   • `long`  — `"2 hours 30 minutes"`, pluralised.
 *   • `clock` — `"02:30:00"`.
 * Non-finite input renders `""` and a negative duration keeps its sign.
 */
export function formatDuration(ms: number, options: FormatDurationOptions = {}): string {
  if (!Number.isFinite(ms)) return "";
  const style = options.style ?? "short";
  return style === "clock" ? formatClock(ms) : formatUnits(ms, style);
}

/**
 * Human phrase for a duration: a positive offset reads `"in 2 hours"`, a
 * negative one `"3 days ago"`, and anything under half a second reads `"now"`.
 * With `{ now }` the first argument is instead an absolute instant to compare
 * against that reference. Non-finite input renders `""`.
 */
export function humanizeDuration(durationMs: number): string;
export function humanizeDuration(
  instantMs: number,
  options: { now: Date | number | string },
): string;
export function humanizeDuration(ms: number, options: HumanizeDurationOptions = {}): string {
  if (!Number.isFinite(ms)) return "";
  let delta = ms;
  if (options.now !== undefined) {
    const nowMs = toEpoch(options.now);
    if (nowMs === null) return "";
    delta = ms - nowMs;
  }
  const abs = Math.abs(delta);
  let value = 0;
  let singular = "second";
  let plural = "seconds";
  for (const [size, one, many] of HUMAN_UNITS) {
    if (abs >= size) {
      value = Math.round(abs / size);
      singular = one;
      plural = many;
      break;
    }
  }
  if (value === 0) return "now";
  const noun = value === 1 ? singular : plural;
  return delta < 0 ? `${value} ${noun} ago` : `in ${value} ${noun}`;
}

/**
 * `date` plus `ms` milliseconds as a fresh `Date`. `date` may be a `Date`,
 * epoch millis or a parseable string; the input is never mutated. An
 * unparseable date or a non-finite offset yields an invalid `Date` (`NaN`
 * time) so the caller can detect it rather than receiving a wrong instant.
 */
export function addDuration(date: Date | number | string, ms: number): Date {
  const base = toEpoch(date);
  if (base === null || !Number.isFinite(ms)) return new Date(Number.NaN);
  return new Date(base + ms);
}

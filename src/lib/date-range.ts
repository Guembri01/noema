/**
 * Date range property + time zones (docs/MISSING_FEATURES.md §4 "Date range",
 * "Date time zone" — planned: store as UTC + zone).
 *
 * A `DateValue` is an ISO `start`, an optional inclusive `end`, an `allDay`
 * flag and an optional IANA `timeZone`. Everything here is pure and
 * deterministic: date-only bounds are parsed from their calendar components
 * straight to a UTC instant (never local `new Date(str)`, which would shift the
 * day in negative offsets), and every timestamp is formatted with an explicit
 * `timeZone: "UTC"` so neither the machine timezone nor DST can leak into the
 * output. That keeps server render and client paint byte-identical.
 *
 * Boundaries are inclusive and "touching" counts as overlap. A date-only bound
 * spans its whole UTC day (start = 00:00, end = 23:59:59.999), so a range that
 * ends on a day still contains an instant later that day.
 */

/** A start date/datetime, an optional inclusive end, an all-day flag and zone. */
export type DateValue = {
  start: string;
  end?: string;
  allDay?: boolean;
  timeZone?: string;
};

export type DateRangeStyle = "long" | "short";

export type ParseDateOptions = { swap?: boolean };

export type ParseDateResult =
  | { ok: true; value: DateValue }
  | { ok: false; error: string };

type RawDateValue = {
  start?: unknown;
  end?: unknown;
  allDay?: unknown;
  timeZone?: unknown;
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

const MS_PER_DAY = 86_400_000;

const isLeapYear = (year: number) =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Calendar-valid day, checked without constructing a Date (UTC-safe). */
function calendarDayValid(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

/** Build a UTC instant from calendar components, immune to the year 0–99 quirk. */
function utcFromParts(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  ms = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hours, minutes, seconds, ms);
  return date.getTime();
}

const isDateOnly = (value: string): boolean => DATE_ONLY.test(value);

/** Strict ISO 8601 date or datetime with optional `Z`/offset; no local parsing. */
function isIsoDate(value: string): boolean {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    return calendarDayValid(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  }
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  if (!calendarDayValid(Number(match[1]), Number(match[2]), Number(match[3]))) return false;
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] ? Number(match[6]) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return false;
  const zone = match[8];
  if (zone && zone !== "Z" && zone !== "z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(-2));
    if (offsetHours > 14 || offsetMinutes > 59) return false;
  }
  return true;
}

/** Absolute instant (ms) of any valid ISO string; a naive datetime reads as UTC. */
function parseInstant(value: string): number {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    return utcFromParts(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  }
  const match = DATE_TIME.exec(value);
  if (!match) return Number.NaN;
  const fraction = match[7] ? Number(match[7].padEnd(3, "0")) : 0;
  const base = utcFromParts(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    match[6] ? Number(match[6]) : 0,
    fraction,
  );
  const zone = match[8];
  if (!zone || zone === "Z" || zone === "z") return base;
  const sign = zone[0] === "-" ? -1 : 1;
  const offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2));
  return base - sign * offsetMinutes * 60_000;
}

/** Inclusive start boundary: a date-only string begins at UTC midnight. */
function startInstant(value: string): number {
  return parseInstant(value);
}

/** Inclusive end boundary: a date-only string covers its whole UTC day. */
function endInstant(value: string): number {
  const dateOnly = DATE_ONLY.exec(value);
  if (!dateOnly) return parseInstant(value);
  return utcFromParts(
    Number(dateOnly[1]),
    Number(dateOnly[2]),
    Number(dateOnly[3]),
    23,
    59,
    59,
    999,
  );
}

const rangeEnd = (range: DateValue): string => range.end ?? range.start;

/**
 * Validate + normalise a raw value into a `DateValue`.
 *
 * Accepts a bare ISO string (treated as `{ start }`) or a `DateValue`-shaped
 * object. On success `end` is always present — missing/empty `end` is defaulted
 * to `start`. A reversed range is swapped when `{ swap: true }`, otherwise
 * rejected. `allDay` defaults to true when both bounds are date-only. An
 * invalid bound or time zone is returned as `{ ok: false, error }`.
 */
export function parseDateValue(raw: unknown, options: ParseDateOptions = {}): ParseDateResult {
  let candidate: RawDateValue;
  if (typeof raw === "string") {
    candidate = { start: raw };
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    candidate = raw as RawDateValue;
  } else {
    return { ok: false, error: "A date value must be an ISO date string or an object." };
  }

  const rawStart = typeof candidate.start === "string" ? candidate.start.trim() : "";
  if (rawStart === "") return { ok: false, error: "A start date is required." };
  if (!isIsoDate(rawStart)) {
    return { ok: false, error: `"${rawStart}" is not a valid ISO date.` };
  }

  let rawEnd = "";
  if (candidate.end !== undefined && candidate.end !== null) {
    if (typeof candidate.end !== "string") {
      return { ok: false, error: "The end date must be an ISO date string." };
    }
    rawEnd = candidate.end.trim();
    if (rawEnd !== "" && !isIsoDate(rawEnd)) {
      return { ok: false, error: `"${rawEnd}" is not a valid ISO date.` };
    }
  }

  let start = rawStart;
  let end = rawEnd === "" ? rawStart : rawEnd;
  if (startInstant(start) > startInstant(end)) {
    if (!options.swap) {
      return { ok: false, error: "The start date must not be after the end date." };
    }
    [start, end] = [end, start];
  }

  let timeZone: string | undefined;
  if (candidate.timeZone !== undefined && candidate.timeZone !== null && candidate.timeZone !== "") {
    if (typeof candidate.timeZone !== "string") {
      return { ok: false, error: "The time zone must be a string." };
    }
    const zone = candidate.timeZone.trim();
    if (!isValidTimeZone(zone)) {
      return { ok: false, error: `"${zone}" is not a recognised time zone.` };
    }
    timeZone = zone;
  }

  const allDay =
    typeof candidate.allDay === "boolean"
      ? candidate.allDay
      : isDateOnly(start) && isDateOnly(end);

  const value: DateValue = { start, end, allDay };
  if (timeZone !== undefined) value.timeZone = timeZone;
  return { ok: true, value };
}

/** Inclusive overlap — ranges that merely touch at a boundary still overlap. */
export function overlaps(a: DateValue, b: DateValue): boolean {
  return (
    startInstant(a.start) <= endInstant(rangeEnd(b)) &&
    startInstant(b.start) <= endInstant(rangeEnd(a))
  );
}

/** Whether an ISO instant falls inside the range, boundaries inclusive. */
export function contains(range: DateValue, instant: string): boolean {
  const at = parseInstant(instant);
  return (
    !Number.isNaN(at) &&
    at >= startInstant(range.start) &&
    at <= endInstant(rangeEnd(range))
  );
}

/**
 * Length of a range in days. All-day ranges count calendar days inclusively
 * (a single day is 1); timed ranges measure elapsed time as a fraction of a day.
 */
export function durationDays(range: DateValue): number {
  const end = rangeEnd(range);
  const allDay = range.allDay ?? (isDateOnly(range.start) && isDateOnly(end));
  if (allDay) {
    return Math.round((startInstant(end) - startInstant(range.start)) / MS_PER_DAY) + 1;
  }
  return (parseInstant(end) - parseInstant(range.start)) / MS_PER_DAY;
}

/** Whether start and end land on the same UTC calendar day. */
export function isSameDay(range: DateValue): boolean {
  const start = new Date(startInstant(range.start));
  const end = new Date(startInstant(rangeEnd(range)));
  return (
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth() &&
    start.getUTCDate() === end.getUTCDate()
  );
}

const FORMATTERS = {
  short: {
    day: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
    full: new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  },
  long: {
    day: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }),
    full: new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
  },
} as const;

/**
 * Human label for a range, formatted in UTC so the machine timezone never
 * changes it: a single day is "Mar 3, 2026"; a same-year range shares the
 * trailing year ("Mar 3 – Mar 5, 2026"); a cross-year range spells both
 * ("Dec 30, 2026 – Jan 2, 2027").
 */
export function formatDateRange(
  range: DateValue,
  options: { style?: DateRangeStyle } = {},
): string {
  const style = options.style === "long" ? "long" : "short";
  const format = FORMATTERS[style];
  const start = new Date(startInstant(range.start));
  const end = new Date(startInstant(rangeEnd(range)));
  if (isSameDay(range)) return format.full.format(start);
  if (start.getUTCFullYear() === end.getUTCFullYear()) {
    return `${format.day.format(start)} – ${format.full.format(end)}`;
  }
  return `${format.full.format(start)} – ${format.full.format(end)}`;
}

/**
 * Whether a value names a real IANA time zone. Uses `Intl.supportedValuesOf`
 * when present (which omits "UTC", handled explicitly) and otherwise falls back
 * to a syntactic check confirmed by asking ICU to accept the zone.
 */
export function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== "string") return false;
  const zone = tz.trim();
  if (zone === "") return false;
  if (zone === "UTC") return true;
  const surface = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  if (typeof surface.supportedValuesOf === "function") {
    try {
      return surface.supportedValuesOf("timeZone").includes(zone);
    } catch {
      // fall through to the ICU probe below
    }
  }
  if (!/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a copy of the range carrying `tz`. An unrecognised zone is ignored,
 * leaving the range (and any existing zone) untouched.
 */
export function withTimeZone(range: DateValue, tz: string): DateValue {
  if (!isValidTimeZone(tz)) return { ...range };
  return { ...range, timeZone: tz.trim() };
}

/** New array sorted ascending by start; stable for equal starts. */
export function sortRanges(values: DateValue[]): DateValue[] {
  return values
    .map((value, index) => ({ value, index, start: startInstant(value.start) }))
    .sort((a, b) => a.start - b.start || a.index - b.index)
    .map((entry) => entry.value);
}

/**
 * Business-hours arithmetic over an explicit UTC working calendar.
 *
 * `sla-timer.ts` measures the wall clock; this module measures the *office*
 * clock. A {@link WorkingHours} describes the weekdays a team works, the daily
 * window it is open and any full-day holidays; four pure helpers then answer the
 * questions a due-date picker asks — is this instant open, what date is N
 * working days out, when is H working hours from now, and how much working time
 * lies inside a span.
 *
 * Everything is **UTC** and the clock is always **injected**: no `Date.now()`
 * and no local-time getters, so a server render, a client paint and a test agree
 * byte for byte. Weekdays use the `getUTCDay()` numbering shared by
 * `cron-schedule.ts` and `notification-schedule.ts` (0 = Sunday .. 6 = Saturday)
 * and holidays are `YYYY-MM-DD` UTC calendar keys. The daily window is
 * half-open, `[startMinutes, endMinutes)`, on a same-day basis (`start < end`;
 * `endMinutes` may be `1440`, the next midnight).
 *
 * Malformed input degrades to the safe answer instead of throwing: a bad
 * instant or an unusable config is never business time, is left unchanged by an
 * add (an unparseable instant yields an `Invalid Date`), and contributes zero
 * minutes. The caller's `WorkingHours` is never mutated.
 *
 * Red-first unit-pinned by `src/lib/business-hours.test.ts`.
 */

/** An instant accepted from callers: epoch ms, a `Date`, or a parsable string. */
export type BusinessInstant = number | Date | string;

/** A working calendar: open weekdays, a daily window, and full-day holidays. */
export type WorkingHours = {
  /** Open weekdays, `getUTCDay` numbering (0 = Sun .. 6 = Sat). */
  days: number[];
  /** First working minute of the day, `0..1439`. */
  startMinutes: number;
  /** First non-working minute, `0..1440` (`end` excludes it; `1440` = midnight). */
  endMinutes: number;
  /** Full-day closures as `YYYY-MM-DD` UTC keys. */
  holidays?: string[];
};

/** A config reduced to lookups and validated numbers (or `null` when unusable). */
type NormalizedHours = {
  days: Set<number>;
  startMinutes: number;
  endMinutes: number;
  holidays: Set<string>;
};

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Generous bound (~100 years of days) so a forward scan can never run away. */
const MAX_SCAN_DAYS = 36_600;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Normalise an instant to epoch ms, or `null` when it cannot be parsed. */
function toEpoch(value: BusinessInstant): number | null {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** UTC midnight of the day containing `ms` (day index times the day length). */
function dayStart(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

/** `YYYY-MM-DD` UTC key of the day containing `ms`. */
function dateKey(ms: number): string {
  const date = new Date(dayStart(ms));
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** A real calendar `YYYY-MM-DD` key (rejects e.g. `2026-02-30` and `2026-13-01`). */
function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Validate and normalise a config, or `null` when it can never describe business
 * time (non-numeric / non-integer window, `start >= end`, out of range). Unknown
 * weekdays and malformed holiday keys are dropped rather than failing the whole
 * config; an empty `days` list stays valid but means "never open".
 */
function readHours(cfg: WorkingHours | null | undefined): NormalizedHours | null {
  if (!cfg || typeof cfg !== "object") return null;
  const days = new Set<number>();
  if (Array.isArray(cfg.days)) {
    for (const day of cfg.days) {
      if (typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6) days.add(day);
    }
  }
  const start = cfg.startMinutes;
  const end = cfg.endMinutes;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > 1440 ||
    start >= end
  ) {
    return null;
  }
  const holidays = new Set<string>();
  if (Array.isArray(cfg.holidays)) {
    for (const key of cfg.holidays) if (isValidDateKey(key)) holidays.add(key);
  }
  return { days, startMinutes: start, endMinutes: end, holidays };
}

/** Is the UTC day containing `ms` an open weekday that is not a holiday? */
function isWorkingDay(ms: number, hours: NormalizedHours): boolean {
  const date = new Date(dayStart(ms));
  return hours.days.has(date.getUTCDay()) && !hours.holidays.has(dateKey(ms));
}

/**
 * The next open interval at or after `fromMs` as `[open, close)`, scanning
 * forward over weekends and holidays. Returns `null` when the config is never
 * open (or nothing is found within {@link MAX_SCAN_DAYS}).
 */
function nextInterval(
  fromMs: number,
  hours: NormalizedHours,
): { open: number; close: number } | null {
  if (hours.days.size === 0) return null;
  let day = dayStart(fromMs);
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (isWorkingDay(day, hours)) {
      const open = day + hours.startMinutes * MS_PER_MINUTE;
      const close = day + hours.endMinutes * MS_PER_MINUTE;
      if (fromMs < close) return { open, close };
    }
    day += MS_PER_DAY;
  }
  return null;
}

/**
 * Is the instant an open working day (ignoring the time within it)? Weekends,
 * listed holidays, unparseable dates and configs with no open weekday all answer
 * `false`.
 */
export function isBusinessDay(date: BusinessInstant, cfg: WorkingHours): boolean {
  const ms = toEpoch(date);
  if (ms === null) return false;
  const hours = readHours(cfg);
  if (!hours || hours.days.size === 0) return false;
  return isWorkingDay(ms, hours);
}

/**
 * Is the instant inside the daily working window of an open day? The window is
 * half-open `[startMinutes, endMinutes)` UTC, so the start minute is business
 * time and the end minute is not. Unparseable dates and unusable configs are
 * never business time.
 */
export function isBusinessTime(date: BusinessInstant, cfg: WorkingHours): boolean {
  const ms = toEpoch(date);
  if (ms === null) return false;
  const hours = readHours(cfg);
  if (!hours || hours.days.size === 0) return false;
  if (!isWorkingDay(ms, hours)) return false;
  const minute = (ms - dayStart(ms)) / MS_PER_MINUTE;
  return minute >= hours.startMinutes && minute < hours.endMinutes;
}

/**
 * The instant `n` working days after `date`, keeping the time of day.
 *
 * Only whole days are counted, and the starting day is never counted — so
 * `n = 0` is the identity, and Friday + 1 business day is Monday whether it is
 * asked on Friday or on the intervening Saturday. Weekends and holidays are
 * skipped in both directions. An unparseable `date` or a non-integer `n` yields
 * an `Invalid Date`; a config with no open weekday leaves the instant unchanged.
 */
export function addBusinessDays(date: BusinessInstant, n: number, cfg: WorkingHours): Date {
  const ms = toEpoch(date);
  if (ms === null || !Number.isInteger(n)) return new Date(Number.NaN);
  if (n === 0) return new Date(ms);
  const hours = readHours(cfg);
  if (!hours || hours.days.size === 0) return new Date(ms);

  const step = n > 0 ? 1 : -1;
  const limit = Math.min(MAX_SCAN_DAYS, Math.abs(n) * 7 + 7);
  let remaining = Math.abs(n);
  let cursor = dayStart(ms);
  for (let scanned = 0; remaining > 0 && scanned < limit; scanned++) {
    cursor += step * MS_PER_DAY;
    if (isWorkingDay(cursor, hours)) remaining--;
  }
  if (remaining > 0) return new Date(ms); // no open day found; leave it untouched
  return new Date(cursor + (ms - dayStart(ms)));
}

/**
 * The instant `hours` working hours after `date`.
 *
 * Time is consumed only while inside an open interval; an instant outside
 * business hours is first rolled forward to the next opening without consuming
 * anything, and each day's window is drained before the next day begins. So
 * Friday 16:00 + 2h is Monday 10:00 and a weekend start opens on Monday.
 * `hours` may be fractional. Zero or negative hours (and an unusable config)
 * return the instant unchanged; an unparseable `date` yields an `Invalid Date`.
 */
export function addBusinessHours(date: BusinessInstant, hours: number, cfg: WorkingHours): Date {
  const ms = toEpoch(date);
  if (ms === null) return new Date(Number.NaN);
  if (!Number.isFinite(hours) || hours <= 0) return new Date(ms);
  const normalized = readHours(cfg);
  if (!normalized || normalized.days.size === 0) return new Date(ms);

  let remaining = hours * MS_PER_HOUR;
  let cursor = ms;
  while (remaining > 0) {
    const interval = nextInterval(cursor, normalized);
    if (!interval) return new Date(ms); // no open interval reachable
    const from = Math.max(cursor, interval.open);
    const available = interval.close - from;
    if (remaining <= available) return new Date(from + remaining);
    remaining -= available;
    cursor = interval.close;
  }
  return new Date(cursor);
}

/**
 * Working minutes inside the half-open span `[a, b)`.
 *
 * Every open interval is intersected with the span and the overlaps summed;
 * weekends, holidays and time between windows contribute nothing. An empty or
 * reversed span (`b <= a`), an unparseable bound or an unusable config is `0`.
 * Sub-minute bounds are measured exactly, so the result may be fractional.
 */
export function businessMinutesBetween(
  a: BusinessInstant,
  b: BusinessInstant,
  cfg: WorkingHours,
): number {
  const startMs = toEpoch(a);
  const endMs = toEpoch(b);
  if (startMs === null || endMs === null || endMs <= startMs) return 0;
  const hours = readHours(cfg);
  if (!hours || hours.days.size === 0) return 0;

  const lastDay = dayStart(endMs);
  let total = 0;
  let day = dayStart(startMs);
  for (let scanned = 0; day <= lastDay && scanned < MAX_SCAN_DAYS; scanned++) {
    if (isWorkingDay(day, hours)) {
      const open = Math.max(startMs, day + hours.startMinutes * MS_PER_MINUTE);
      const close = Math.min(endMs, day + hours.endMinutes * MS_PER_MINUTE);
      if (close > open) total += close - open;
    }
    day += MS_PER_DAY;
  }
  return total / MS_PER_MINUTE;
}

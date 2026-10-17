export type TemplateRecurrence = "daily" | "weekly" | "monthly";

/**
 * Next occurrence for a recurrence, pinned to the schedule's wall clock (D4).
 *
 * - `from` is the point the schedule advances *from* — the stored `nextRunAt`
 *   in the cron route, never "now", so execution jitter cannot drift the
 *   schedule (a 09:00 schedule stays 09:00 however late the tick fires).
 * - `anchor` is the schedule's own wall-clock time: its time-of-day pins
 *   daily/weekly runs; its day-of-month pins monthly runs with a **last-day
 *   clamp** — Jan 31 → Feb 28/29 → Mar 31: the day-of-month is remembered,
 *   never incremented, so a 31st schedule never skips February (the shipped
 *   `setMonth(+1)` from Jan 31 landed on Mar 3). Defaults to `from` for
 *   callers without a stored anchor.
 */
export function nextRunFor(
  recurrence: TemplateRecurrence,
  from: Date = new Date(),
  anchor: Date = from,
): Date {
  const next = new Date(from);
  if (recurrence === "daily") {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === "weekly") {
    next.setDate(next.getDate() + 7);
  } else {
    // Monthly: remember the anchor day-of-month, clamped to the target
    // month's last day. setDate(1) first — rolling the month from Jan 31
    // directly would overflow to Mar 3 and skip February entirely.
    const dayOfMonth = anchor.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(dayOfMonth, lastDay));
  }
  next.setHours(
    anchor.getHours(),
    anchor.getMinutes(),
    anchor.getSeconds(),
    anchor.getMilliseconds(),
  );
  return next;
}

// ---------------------------------------------------------------------------
// Generalized rules engine — recurring tickets (docs/MISSING_FEATURES.md §20)
// and scheduled row creation (§3). One rule type drives both:
// `nextOccurrences(rule, from, count)` lists the next N fire times from a
// start + cadence (the cron materializer's question), `matches(rule, date)`
// answers "should this calendar day fire?" for UI/preview paths.
//
// Semantics pinned by src/lib/recurrence.test.ts:
// - `start` is the schedule epoch (RFC 5545 `DTSTART`-ish): interval math
//   counts from it, a bare weekly anchors its weekday to it, a bare monthly
//   anchors its day-of-month to it, and nothing fires before it. Date-only
//   ISO strings are taken literally (`"2026-01-07"` = Jan 7 local, never UTC
//   midnight, which would land on Jan 6 in negative offsets). A missing or
//   invalid `start` falls back to 1970-01-01 local — and `matches` uses the
//   same epoch, so the two helpers can never disagree.
// - All stepping rebuilds dates from **local calendar components**, never
//   `+ 86_400_000`, so wall clocks are DST-safe: a 09:00 rule stays 09:00
//   across spring-forward/fall-back. Node rolls a nonexistent wall clock
//   forward by the gap (02:30 in 02:00→03:00 → 03:30) and picks the first
//   (DST) pass of an ambiguous one; both are deterministic and asserted.
// - The wall clock is fixed for the whole list — taken from `hour`/`minute`
//   when the rule sets them, otherwise from `from` — so a gap-rolled
//   occurrence (03:30) never drags the following day off its 02:30 slot.
// - Monthly days clamp per month but remember the *raw* day (D4 parity):
//   Jan 31 → Feb 28 → Mar 31, never Feb 28 → Mar 28.
//
// `nextRunFor` above keeps its legacy anchor semantics for the shipped
// template cron; new callers with interval/ByDay/monthday needs use this.
// ---------------------------------------------------------------------------

/** Weekdays for `RecurrenceRule.byDay`, lowercase. */
export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

/**
 * A JSON-serializable recurrence rule (safe for `Automation.triggerConfig`
 * and `Template.config` columns alike).
 *
 * - `interval` — every N days/weeks/months; defaults to 1, hostile values
 *   (0, negatives, 2.7) normalize to a positive integer.
 * - `byDay` — weekly: which weekdays fire inside each aligned week
 *   (e.g. `["mon","wed","fri"]`); defaults to the epoch's weekday.
 * - `byMonthDay` — monthly: day(s) of month 1-31, clamped to each month's
 *   last day; defaults to the epoch's day-of-month.
 * - `hour`/`minute` — pin the wall clock (minute defaults to 0 when hour is
 *   set, out-of-range clamps); without `hour` occurrences inherit `from`'s
 *   wall clock and `matches` is day-level.
 * - `start` — schedule epoch; `Date` or ISO string.
 */
export interface RecurrenceRule {
  freq: TemplateRecurrence;
  interval?: number;
  byDay?: Weekday[];
  byMonthDay?: number | number[];
  hour?: number;
  minute?: number;
  start?: Date | string;
}

const DAY_MS = 86_400_000;
const DATE_ONLY_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_NAMES: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_INDEX: Record<Weekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** Wall clock an occurrence is built at. */
interface Clock {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const clampInt = (value: number, lo: number, hi: number): number =>
  Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.floor(value))) : lo;

function normalizeInterval(interval: number | undefined): number {
  return typeof interval === "number" && Number.isFinite(interval) && interval >= 1
    ? Math.floor(interval)
    : 1;
}

/**
 * Schedule epoch: its **local** calendar date drives interval alignment, the
 * default weekly weekday and the default monthly day-of-month.
 */
function epochOf(rule: RecurrenceRule): Date {
  const { start } = rule;
  const fallback = new Date(1970, 0, 1);
  if (start === undefined) return fallback;
  if (start instanceof Date) {
    return Number.isFinite(start.getTime()) ? start : fallback;
  }
  const parts = DATE_ONLY_ISO.exec(start);
  const parsed = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(start);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

/** Day number of `date`'s **local** calendar date (1970-01-01 → 0). */
const dayIndex = (date: Date): number =>
  Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);

/** Monday-based week number; week 0 contains 1970-01-01 (a Thursday). */
const weekIndex = (date: Date): number => Math.floor((dayIndex(date) + 3) / 7);

const monthIndex = (date: Date): number => date.getFullYear() * 12 + date.getMonth();

const weekdayOf = (date: Date): Weekday => WEEKDAY_NAMES[date.getDay()];

/** Weekday → offset inside a Monday-based week (Mon 0 … Sun 6). */
const offsetInWeek = (weekday: Weekday): number => (WEEKDAY_INDEX[weekday] + 6) % 7;

const lastDayOfMonth = (month: number): number =>
  new Date(Math.floor(month / 12), (month % 12) + 1, 0).getDate();

/** Build a local calendar date (day index since 1970-01-01) at `clock`. */
function atDayIndex(index: number, clock: Clock): Date {
  const utc = new Date(index * DAY_MS);
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    clock.hour,
    clock.minute,
    clock.second,
    clock.millisecond,
  );
}

/** Build a local month/day at `clock` (day already clamped to the month). */
function atMonthDay(month: number, dayOfMonth: number, clock: Clock): Date {
  return new Date(
    Math.floor(month / 12),
    month % 12,
    dayOfMonth,
    clock.hour,
    clock.minute,
    clock.second,
    clock.millisecond,
  );
}

/** Raw monthly days (1-31), defaulting to the epoch day, sorted + unique. */
function rawMonthDays(rule: RecurrenceRule, epoch: Date): number[] {
  const spec = rule.byMonthDay;
  const values = spec === undefined ? [] : Array.isArray(spec) ? spec : [spec];
  const valid = values
    .filter((day) => Number.isFinite(day) && Math.floor(day) >= 1 && Math.floor(day) <= 31)
    .map((day) => Math.floor(day));
  const days = valid.length > 0 ? valid : [epoch.getDate()];
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Clamp raw days to a specific month's last day (Jan 31 → Feb 28), unique. */
function monthDaysFor(month: number, raw: number[]): number[] {
  const last = lastDayOfMonth(month);
  return [...new Set(raw.map((day) => Math.min(day, last)))].sort((a, b) => a - b);
}

/** Allowed weekdays as Monday-based offsets, sorted; default: epoch weekday. */
function weekOffsets(rule: RecurrenceRule, epoch: Date): number[] {
  const valid = (rule.byDay ?? []).filter((weekday) => weekday in WEEKDAY_INDEX);
  const list = valid.length > 0 ? valid : [weekdayOf(epoch)];
  return [...new Set(list.map(offsetInWeek))].sort((a, b) => a - b);
}

/** The rule's pinned clock, or `null` when the rule leaves time to `from`. */
function ruleClock(rule: RecurrenceRule): { hour: number; minute: number } | null {
  if (rule.hour === undefined) return null;
  return {
    hour: clampInt(rule.hour, 0, 23),
    minute: rule.minute === undefined ? 0 : clampInt(rule.minute, 0, 59),
  };
}

function clockOf(rule: RecurrenceRule, from: Date): Clock {
  const pinned = ruleClock(rule);
  if (pinned) return { ...pinned, second: 0, millisecond: 0 };
  return {
    hour: from.getHours(),
    minute: from.getMinutes(),
    second: from.getSeconds(),
    millisecond: from.getMilliseconds(),
  };
}

function dayMatches(rule: RecurrenceRule, epoch: Date, date: Date): boolean {
  const interval = normalizeInterval(rule.interval);
  if (rule.freq === "daily") {
    return (dayIndex(date) - dayIndex(epoch)) % interval === 0;
  }
  if (rule.freq === "weekly") {
    if ((weekIndex(date) - weekIndex(epoch)) % interval !== 0) return false;
    return weekOffsets(rule, epoch).includes(offsetInWeek(weekdayOf(date)));
  }
  if ((monthIndex(date) - monthIndex(epoch)) % interval !== 0) return false;
  return monthDaysFor(monthIndex(date), rawMonthDays(rule, epoch)).includes(date.getDate());
}

/**
 * Does `date` fall on the rule's schedule? Compares the **local calendar
 * day** against the rule (same epoch/interval/ByDay/clamp math as
 * `nextOccurrences`, so every produced occurrence matches); when the rule
 * sets `hour`, the minute-level wall clock must match too. Days before
 * `start` and invalid dates never match.
 */
export function matches(rule: RecurrenceRule, date: Date): boolean {
  const epoch = epochOf(rule);
  if (!Number.isFinite(date.getTime()) || dayIndex(date) < dayIndex(epoch)) return false;
  if (!dayMatches(rule, epoch, date)) return false;
  const pinned = ruleClock(rule);
  if (!pinned) return true;
  return date.getHours() === pinned.hour && date.getMinutes() === pinned.minute;
}

function nextDaily(epoch: Date, interval: number, after: Date, clock: Clock): Date {
  const epochIdx = dayIndex(epoch);
  const steps = Math.max(0, Math.ceil((dayIndex(after) - epochIdx) / interval));
  const idx = epochIdx + steps * interval;
  const candidate = atDayIndex(idx, clock);
  // Same-day candidate at or before `after` → the next aligned day is
  // guaranteed strictly later (a later calendar day outranks any wall clock).
  return candidate.getTime() > after.getTime() ? candidate : atDayIndex(idx + interval, clock);
}

function nextWeekly(
  rule: RecurrenceRule,
  epoch: Date,
  interval: number,
  after: Date,
  clock: Clock,
): Date {
  const epochWeek = weekIndex(epoch);
  const epochIdx = dayIndex(epoch);
  const offsets = weekOffsets(rule, epoch);
  const steps = Math.max(0, Math.ceil((weekIndex(after) - epochWeek) / interval));
  const weeks = [epochWeek + steps * interval, epochWeek + (steps + 1) * interval];
  for (const week of weeks) {
    const monday = week * 7 - 3;
    for (const offset of offsets) {
      const candidate = atDayIndex(monday + offset, clock);
      if (candidate.getTime() > after.getTime() && dayIndex(candidate) >= epochIdx) {
        return candidate;
      }
    }
  }
  // Phase 2's first day is provably past both `after` and the epoch.
  return atDayIndex(weeks[1] * 7 - 3 + offsets[0], clock);
}

function nextMonthly(
  rule: RecurrenceRule,
  epoch: Date,
  interval: number,
  after: Date,
  clock: Clock,
): Date {
  const epochMonth = monthIndex(epoch);
  const epochIdx = dayIndex(epoch);
  const raw = rawMonthDays(rule, epoch);
  const steps = Math.max(0, Math.ceil((monthIndex(after) - epochMonth) / interval));
  const months = [epochMonth + steps * interval, epochMonth + (steps + 1) * interval];
  for (const month of months) {
    for (const dayOfMonth of monthDaysFor(month, raw)) {
      const candidate = atMonthDay(month, dayOfMonth, clock);
      if (candidate.getTime() > after.getTime() && dayIndex(candidate) >= epochIdx) {
        return candidate;
      }
    }
  }
  // Phase 2's first day is provably past both `after` and the epoch.
  const fallbackMonth = months[1];
  return atMonthDay(fallbackMonth, monthDaysFor(fallbackMonth, raw)[0], clock);
}

function nextAfter(rule: RecurrenceRule, epoch: Date, after: Date, clock: Clock): Date {
  const interval = normalizeInterval(rule.interval);
  if (rule.freq === "daily") return nextDaily(epoch, interval, after, clock);
  if (rule.freq === "weekly") return nextWeekly(rule, epoch, interval, after, clock);
  return nextMonthly(rule, epoch, interval, after, clock);
}

/**
 * The next `count` fire times strictly after `from`, ascending.
 *
 * Used by scheduled row creation ("given a start + cadence, list the next N
 * fire times"): each occurrence is computed from the previous cursor but at
 * the *fixed* wall clock from `rule.hour`/`minute` (else `from`'s), so DST
 * gaps and month-end clamps never drift the series. `count` ≤ 0 returns `[]`;
 * every returned instant is `> from` (a fire landing exactly on `from` is
 * skipped) and `≥ start` when the rule carries one.
 */
export function nextOccurrences(rule: RecurrenceRule, from: Date, count: number): Date[] {
  const occurrences: Date[] = [];
  const wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const epoch = epochOf(rule);
  const clock = clockOf(rule, from);
  let cursor = from;
  for (let i = 0; i < wanted; i += 1) {
    const next = nextAfter(rule, epoch, cursor, clock);
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}

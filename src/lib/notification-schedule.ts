/**
 * Notification quiet hours / do-not-disturb (the delivery-window half of
 * docs/specs/notifications.md "Notification preferences"; the per-user
 * alert gate sits in `notification-prefs.ts`, the inbox in
 * `notification-inbox.ts`).
 *
 * PURE module: no prisma, no `node:*` imports, no ambient clock. Every function
 * is handed the instant it measures against, so a settings UI, a digest
 * scheduler and a cron endpoint can all share one deterministic decision.
 *
 * Time is modelled with an **explicit** `timezoneOffsetMinutes` rather than the
 * machine's local timezone: the schedule's local clock is `UTC + offset`, with
 * `+120` meaning UTC+2 (east positive). The offset is added to the instant, then
 * the shifted value is read back with the `getUTC*` accessors - so neither the
 * host timezone nor DST can leak into a decision. `days` uses the same numbering
 * as `getUTCDay()` (0 = Sunday .. 6 = Saturday) and names the days on which the
 * quiet window **begins**; a window that wraps past midnight keeps running into
 * the next morning even when that morning's day is not listed.
 *
 * Windows are half-open, `[start, end)`, so `endMinutes` is the first
 * deliverable minute. A window with `startMinutes === endMinutes` has no
 * duration; a whole day is `00:00-24:00` (`endMinutes` may be `1440`).
 *
 * Failures preserve delivery: an unrecognised or malformed schedule, an empty
 * day list, or an unparseable date all answer "not quiet" (and `nextDeliveryTime`
 * returns the instant unchanged) - quiet hours can only ever narrow delivery,
 * never silently swallow a notification. Mirrors the fail-open direction of the
 * scheduler rather than the fail-closed one of `notification-prefs.ts`.
 *
 * Red-first unit-pinned by `src/lib/notification-schedule.test.ts`.
 */

/** A recurring quiet window on selected weekdays, pinned to an offset. */
export type QuietSchedule = {
  /** Weekdays the window **begins** on, `getUTCDay` numbering (0 = Sun .. 6 = Sat). */
  days: number[];
  /** First quiet minute of the day, `0..1439`. */
  startMinutes: number;
  /** First deliverable minute, `0..1440` (`end` excludes it; 1440 = next midnight). */
  endMinutes: number;
  /** Minutes added to UTC to get the schedule-local clock; east positive (`+120` = UTC+2). */
  timezoneOffsetMinutes: number;
};

/** Result of `validateSchedule`: the normalized schedule or a reason it failed. */
export type ScheduleValidation =
  | { ok: true; value: QuietSchedule }
  | { ok: false; error: string };

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const MIN_MINUTE = 0;
const MAX_START_MINUTE = 1439;
const MAX_END_MINUTE = 1440;
const MIN_OFFSET_MINUTES = -720; // UTC-12:00
const MAX_OFFSET_MINUTES = 840; // UTC+14:00

/** Integer in `[min, max]`, narrowing to `number` for the caller. */
function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Non-null, non-array object - the only input shape trusted as a record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sorted, de-duplicated copy of a valid weekday list, or null when malformed. */
function readDays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const days = new Set<number>();
  for (const entry of value) {
    if (!isIntInRange(entry, 0, 6)) return null;
    days.add(entry);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Validate and normalize a raw schedule (e.g. JSON straight off a row or a
 * settings form) into a complete `QuietSchedule`. Days are sorted and
 * de-duplicated; unknown fields are dropped. Rejects a non-object, malformed
 * days, out-of-range minutes or offset, and a zero-duration window.
 */
export function validateSchedule(input: unknown): ScheduleValidation {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "A quiet schedule must be an object." };
  }
  const days = readDays(input.days);
  if (!days) {
    return { ok: false, error: "`days` must be an array of weekdays (0-6)." };
  }
  const startMinutes = input.startMinutes;
  if (!isIntInRange(startMinutes, MIN_MINUTE, MAX_START_MINUTE)) {
    return { ok: false, error: "`startMinutes` must be a minute of the day (0-1439)." };
  }
  const endMinutes = input.endMinutes;
  if (!isIntInRange(endMinutes, MIN_MINUTE, MAX_END_MINUTE)) {
    return { ok: false, error: "`endMinutes` must be a minute of the day (0-1440)." };
  }
  if (startMinutes === endMinutes) {
    return { ok: false, error: "A quiet window must have a non-zero duration." };
  }
  const timezoneOffsetMinutes = input.timezoneOffsetMinutes;
  if (!isIntInRange(timezoneOffsetMinutes, MIN_OFFSET_MINUTES, MAX_OFFSET_MINUTES)) {
    return {
      ok: false,
      error: "`timezoneOffsetMinutes` must be between -720 and 840.",
    };
  }
  return { ok: true, value: { days, startMinutes, endMinutes, timezoneOffsetMinutes } };
}

/** The normalized schedule, or null when the input is not a valid one. */
function readSchedule(input: unknown): QuietSchedule | null {
  const result = validateSchedule(input);
  return result.ok ? result.value : null;
}

/** The instant shifted into the schedule's local clock (still read as UTC). */
function toLocal(date: Date, timezoneOffsetMinutes: number): Date {
  return new Date(date.getTime() + timezoneOffsetMinutes * MS_PER_MINUTE);
}

/** Midnight of the local day containing `local`, as a shifted millisecond stamp. */
function localMidnight(local: Date): number {
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

/**
 * Is `date` inside the quiet window? A same-day window (`start < end`) is quiet
 * on a selected day between the two minutes; a wrapping window (`start > end`)
 * is quiet from `start` on a selected day through (but not including) `end` the
 * following morning. Invalid schedules and unparseable dates are never quiet.
 */
export function isWithinQuietHours(
  date: Date | number | string,
  schedule: QuietSchedule,
): boolean {
  const at = new Date(date);
  if (Number.isNaN(at.getTime())) return false; // fail open
  const s = readSchedule(schedule);
  if (!s || s.days.length === 0) return false; // fail open

  const local = toLocal(at, s.timezoneOffsetMinutes);
  const day = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const days = new Set(s.days);

  if (s.startMinutes < s.endMinutes) {
    return days.has(day) && minute >= s.startMinutes && minute < s.endMinutes;
  }
  // Wrapping: the evening run on a selected day, plus the tail on the day after.
  const previousDay = (day + 6) % 7;
  if (days.has(day) && minute >= s.startMinutes) return true;
  if (days.has(previousDay) && minute < s.endMinutes) return true;
  return false;
}

/**
 * The first instant at or after `date` that is **outside** quiet hours - the
 * point at which a held notification may be delivered. When `date` is already
 * deliverable it is returned unchanged; otherwise the window's `end` is the
 * answer (today for a same-day window or an overnight tail, tomorrow for an
 * evening start). Invalid schedules and unparseable dates return `date`.
 */
export function nextDeliveryTime(
  date: Date | number | string,
  schedule: QuietSchedule,
): Date {
  const at = new Date(date);
  if (Number.isNaN(at.getTime())) return at;
  const s = readSchedule(schedule);
  if (!s || s.days.length === 0) return at;
  if (!isWithinQuietHours(at, schedule)) return at;

  const local = toLocal(at, s.timezoneOffsetMinutes);
  const day = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const days = new Set(s.days);
  const midday = localMidnight(local);
  const startsToday = days.has(day) && minute >= s.startMinutes;

  let endLocalMs: number;
  if (s.startMinutes < s.endMinutes) {
    endLocalMs = midday + s.endMinutes * MS_PER_MINUTE; // same-day window
  } else if (startsToday) {
    endLocalMs = midday + MS_PER_DAY + s.endMinutes * MS_PER_MINUTE; // overnight tail
  } else {
    endLocalMs = midday + s.endMinutes * MS_PER_MINUTE; // morning tail, ends today
  }
  return new Date(endLocalMs - s.timezoneOffsetMinutes * MS_PER_MINUTE);
}

/**
 * Merge a user's quiet windows from every source (user default, workspace
 * override, page exception) into a canonical list. Schedules that share an
 * offset and window are folded into one by unioning their days; genuinely
 * different windows stay separate because a `QuietSchedule` models a single
 * window. Output is sorted by offset, then start, then end, and days are sorted
 * and de-duplicated. Invalid and day-less schedules are dropped (they would
 * never mute anything). The input is never mutated.
 */
export function mergeSchedules(schedules: readonly QuietSchedule[]): QuietSchedule[] {
  type Group = {
    days: Set<number>;
    startMinutes: number;
    endMinutes: number;
    timezoneOffsetMinutes: number;
  };
  const groups = new Map<string, Group>();
  for (const raw of schedules) {
    const s = readSchedule(raw);
    if (!s || s.days.length === 0) continue;
    const key = `${s.timezoneOffsetMinutes}:${s.startMinutes}:${s.endMinutes}`;
    const group = groups.get(key);
    if (group) {
      for (const day of s.days) group.days.add(day);
    } else {
      groups.set(key, {
        days: new Set(s.days),
        startMinutes: s.startMinutes,
        endMinutes: s.endMinutes,
        timezoneOffsetMinutes: s.timezoneOffsetMinutes,
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      days: [...group.days].sort((a, b) => a - b),
      startMinutes: group.startMinutes,
      endMinutes: group.endMinutes,
      timezoneOffsetMinutes: group.timezoneOffsetMinutes,
    }))
    .sort(
      (a, b) =>
        a.timezoneOffsetMinutes - b.timezoneOffsetMinutes ||
        a.startMinutes - b.startMinutes ||
        a.endMinutes - b.endMinutes,
    );
}

/**
 * The Noema authoring-window policy.
 *
 * The project timeline follows a fixed rhythm: work lands only on the four
 * overnight windows that start on Wednesday, Thursday, Friday and Saturday
 * evening, in the `Europe/Paris` timezone:
 *
 * ```
 * Wed 19:00 → Thu 06:00
 * Thu 19:00 → Fri 06:00
 * Fri 19:00 → Sat 06:00
 * Sat 19:00 → Sun 06:00
 * ```
 *
 * A window is half-open: `19:00:00` is inside it and `06:00:00` is *outside*
 * it, so the last allowed instant of a night is `05:59:59`. Monday and Tuesday
 * have no window at all.
 *
 * The timezone offset is derived from the platform ICU data through
 * `Intl.DateTimeFormat`, never hardcoded, so the two yearly transitions
 * (last Sunday of March and last Sunday of October) are handled by the
 * database rather than by this module. Both transitions fall inside a Saturday
 * night window, which is exactly why the rule is expressed as "hour of the
 * Paris wall clock" and not as a UTC range.
 *
 * Every function is total and pure: an invalid instant yields the documented
 * sentinel (`null` / `false`) rather than an exception, because callers run on
 * render paths and in commit hooks.
 */

/** The single timezone the policy is defined in. */
export const POLICY_TIMEZONE = "Europe/Paris";

/** The hour a window opens, in the policy timezone. */
export const WINDOW_START_HOUR = 19;

/** The hour a window closes, in the policy timezone (exclusive). */
export const WINDOW_END_HOUR = 6;

/** Weekday short names as `en-GB` emits them for the policy timezone. */
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** The four days a window can begin on. */
export const WINDOW_START_DAYS: readonly Weekday[] = ["Wed", "Thu", "Fri", "Sat"];

/** A calendar instant as read on the Paris wall clock. */
export type ParisStamp = {
  /** `YYYY-MM-DD` on the Paris wall clock. */
  dateKey: string;
  weekday: Weekday;
  /** 0–23, with midnight normalised to `0` (ICU reports it as `24` in some runtimes). */
  hour: number;
  minute: number;
  second: number;
  /** Minutes east of UTC in force at this instant (`+120` in summer, `+60` in winter). */
  offsetMinutes: number;
};

const STAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: POLICY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hour12: false,
});

const toDate = (value: Date | string | number): Date | null => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Read an instant on the Paris wall clock.
 *
 * Returns `null` for anything `Date` cannot represent. The offset is computed
 * by subtracting the instant from the same fields re-interpreted as UTC, which
 * is exact because the offset is always a whole number of minutes.
 */
export function parisStamp(value: Date | string | number): ParisStamp | null {
  const date = toDate(value);
  if (!date) return null;
  const parts = Object.fromEntries(
    STAMP_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const weekday = parts.weekday as Weekday;
  if (!WEEKDAYS.includes(weekday)) return null;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday,
    hour,
    minute,
    second,
    offsetMinutes: Math.round((asUtc - date.getTime()) / 60_000),
  };
}

/** Minutes east of UTC in force in the policy timezone at this instant. */
export function policyOffsetMinutes(value: Date | string | number): number {
  return parisStamp(value)?.offsetMinutes ?? Number.NaN;
}

/**
 * Decide a wall-clock stamp against the four windows.
 *
 * `Wed` is allowed only at or after the opening hour; `Thu`/`Fri`/`Sat` are
 * allowed in the small hours (the tail of the previous night) *and* after the
 * opening hour; `Sun` is allowed only in the small hours; `Mon`/`Tue` never.
 */
export function isAllowedStamp(stamp: Pick<ParisStamp, "weekday" | "hour">): boolean {
  switch (stamp.weekday) {
    case "Wed":
      return stamp.hour >= WINDOW_START_HOUR;
    case "Thu":
    case "Fri":
    case "Sat":
      return stamp.hour < WINDOW_END_HOUR || stamp.hour >= WINDOW_START_HOUR;
    case "Sun":
      return stamp.hour < WINDOW_END_HOUR;
    default:
      return false;
  }
}

/** Whether an instant falls inside one of the four windows. */
export function isAllowedInstant(value: Date | string | number): boolean {
  const stamp = parisStamp(value);
  return stamp ? isAllowedStamp(stamp) : false;
}

/** A human-readable reason, for logs, hooks and CI failures. */
export function describeVerdict(value: Date | string | number): string {
  const stamp = parisStamp(value);
  if (!stamp) return "invalid instant";
  const clock = `${String(stamp.hour).padStart(2, "0")}:${String(stamp.minute).padStart(2, "0")}`;
  const label = `${stamp.weekday} ${stamp.dateKey} ${clock} (${POLICY_TIMEZONE})`;
  return isAllowedStamp(stamp) ? `${label} is inside a window` : `${label} is outside every window`;
}

/**
 * Weekday of a bare `YYYY-MM-DD` date key, judged on that calendar day.
 *
 * Date-only values carry no clock, so the only question the policy can ask is
 * whether the day is one a window may touch (Wed–Sat). Midnight is used as the
 * probe so the answer never depends on the host's timezone.
 */
export function weekdayOfDateKey(dateKey: string): Weekday | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Probe at 12:00 UTC (Paris afternoon, same calendar day) and confirm the
  // fields survived the round trip, so overflow like `2026-02-30` is rejected
  // instead of silently becoming 2 March.
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return parisStamp(probe)?.weekday ?? null;
}

/** Whether a bare `YYYY-MM-DD` date key lands on a window-bearing day. */
export function isAllowedDateKey(dateKey: string): boolean {
  const weekday = weekdayOfDateKey(dateKey);
  return weekday !== null && WINDOW_START_DAYS.includes(weekday);
}

/** `+02:00` / `+01:00`, the way git writes an offset. */
export function formatPolicyOffset(value: Date | string | number): string {
  const minutes = policyOffsetMinutes(value);
  if (!Number.isFinite(minutes)) return "";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Render the policy as the four windows, for docs and CLI output. */
export function describeWindows(): string[] {
  return [
    "Wed 19:00 → Thu 06:00",
    "Thu 19:00 → Fri 06:00",
    "Fri 19:00 → Sat 06:00",
    "Sat 19:00 → Sun 06:00",
  ];
}

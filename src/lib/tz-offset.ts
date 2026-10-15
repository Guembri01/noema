/**
 * Time-zone offsets.
 *
 * A pure, dependency-free layer over `Intl.DateTimeFormat`: it answers "how far
 * ahead of UTC is this zone at this instant?" and the follow-up questions a
 * scheduling UI asks — how the offset reads (`+05:30`), whether a given instant
 * falls in daylight saving, and whether two zones currently agree.
 *
 * Everything is derived from the platform ICU data via `formatToParts`, so it
 * uses the same zone database the rest of the app formats with. The functions
 * are total and never throw: an unrecognised zone, an invalid instant or a
 * non-finite number yields the documented sentinel (`NaN`, `""`, `false`)
 * rather than an exception, because callers run on render paths.
 *
 * Tests pass fixed instants so neither the machine timezone nor the host's
 * "current" instant can leak into a result.
 */

/** Shape of the calendar fields `formatToParts` emits for an offset probe. */
type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const MS_PER_MINUTE = 60_000;

/**
 * A spread of widely used IANA zones across every inhabited latitude band and
 * common offset (whole, half and three-quarter hours). Suitable as the default
 * choices in a time-zone picker.
 */
export const COMMON_TIMEZONES: readonly string[] = [
  "UTC",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Atlantic/Azores",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Athens",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Pacific/Chatham",
];

const toDate = (value: Date | number | string): Date =>
  value instanceof Date ? value : new Date(value);

/** UTC millisecond value immune to `Date.UTC`'s year 0–99 quirk. */
function utcFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (year >= 0 && year <= 99) {
    const date = new Date(ms);
    date.setUTCFullYear(year);
    return date.getTime();
  }
  return ms;
}

/**
 * Wall-clock fields the zone shows at `date`, as plain numbers. Throws only if
 * ICU rejects the zone, which {@link offsetMinutes} catches.
 */
function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const fields: Partial<ZonedParts> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    fields[part.type as keyof ZonedParts] = Number(part.value);
  }

  return {
    year: fields.year ?? 0,
    month: fields.month ?? 1,
    day: fields.day ?? 1,
    // Some engines render midnight as "24" even under `h23`; normalise it.
    hour: (fields.hour ?? 0) % 24,
    minute: fields.minute ?? 0,
    second: fields.second ?? 0,
  };
}

/**
 * Offset of `timeZone` at `at`, in minutes east of UTC (east positive).
 *
 * `330` is `+05:30` (`Asia/Kolkata`); `-300` is `-05:00` (`America/New_York` in
 * winter). Returns `NaN` for an unknown zone or an invalid instant.
 */
export function offsetMinutes(
  timeZone: string,
  at: Date | number | string,
): number {
  const date = toDate(at);
  if (Number.isNaN(date.getTime())) return Number.NaN;

  let parts: ZonedParts;
  try {
    parts = zonedParts(date, timeZone);
  } catch {
    return Number.NaN;
  }

  const asUtc = utcFromParts(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  // Wall clock read as if it were UTC, minus the true instant. Rounding absorbs
  // the sub-minute remainder of `date` (zones are whole minutes in practice).
  return Math.round((asUtc - date.getTime()) / MS_PER_MINUTE);
}

/**
 * Render an offset as `+02:00` / `-05:30`. Zero is `+00:00`. A non-finite
 * number yields `""`.
 */
export function formatOffset(minutes: number): string {
  if (!Number.isFinite(minutes)) return "";
  const rounded = Math.round(minutes);
  const sign = rounded < 0 ? "-" : "+";
  const absolute = Math.abs(rounded);
  const hours = Math.floor(absolute / 60);
  const mins = absolute % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${sign}${pad(hours)}:${pad(mins)}`;
}

/**
 * Whether `at` falls in daylight saving in `timeZone`.
 *
 * The zone's standard offset is taken as the smallest offset it shows across the
 * year of `at` (sampled on the first of each month); every real DST rule moves
 * the clock *forward*, so a larger current offset means summer time. Zones that
 * never shift, unknown zones and invalid instants all return `false`.
 */
export function isDaylightSaving(
  timeZone: string,
  at: Date | number | string,
): boolean {
  const date = toDate(at);
  if (Number.isNaN(date.getTime())) return false;

  // A single invalid sample means the zone is unusable for every sample.
  const january = offsetMinutes(timeZone, utcFromParts(date.getUTCFullYear(), 1, 1, 12, 0, 0));
  if (Number.isNaN(january)) return false;

  let standard = january;
  for (let month = 2; month <= 12; month += 1) {
    const sample = offsetMinutes(
      timeZone,
      utcFromParts(date.getUTCFullYear(), month, 1, 12, 0, 0),
    );
    if (sample < standard) standard = sample;
  }

  const current = offsetMinutes(timeZone, date);
  return current > standard;
}

/**
 * Whether `a` and `b` are at the same offset at `at`. `false` if either zone is
 * unknown or `at` is invalid.
 */
export function sameOffset(
  a: string,
  b: string,
  at: Date | number | string,
): boolean {
  const offsetA = offsetMinutes(a, at);
  const offsetB = offsetMinutes(b, at);
  if (Number.isNaN(offsetA) || Number.isNaN(offsetB)) return false;
  return offsetA === offsetB;
}

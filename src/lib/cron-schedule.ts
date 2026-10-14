/**
 * Cron expression utilities: a pure, deterministic parser, matcher, scheduler
 * and describer for standard 5-field cron expressions.
 *
 *     minute  hour  day-of-month  month  day-of-week
 *
 * Supported syntax in every field: `*`, a single value, a list (`1,2,3`), a
 * range (`9-17`) and a step applied to `*` or a range (a slash plus a number
 * such as every 15 minutes, or `8-10` with a step of 2). Ranges are inclusive
 * and values are expanded, de-duplicated and sorted ascending.
 * Field bounds: minute 0-59, hour 0-23, day-of-month 1-31, month 1-12,
 * day-of-week 0-6 (0 = Sunday, matching `getUTCDay`). Named aliases (`MON`,
 * `JAN`) and the `7 = Sunday` shorthand are intentionally not accepted.
 *
 * Everything is **UTC** and the clock is always **injected** — `nextRuns`
 * receives the instant it advances from and the module never calls `Date.now()`
 * — so a preview UI, a scheduler tick and a test all agree byte for byte.
 *
 * Day-of-month / day-of-week follow Vixie cron: when **both** are restricted
 * (neither written as a literal `*`) a day matches if **either** does; when one
 * is `*` the other must match. A literal `*` is tracked separately from an
 * equivalent range (`1-31`) precisely so this rule stays faithful.
 *
 * `parseCron` and `describeCron` throw on a malformed expression;
 * `isValidCron`, `matchesCron` and `nextRuns` are defensive — they return
 * `false` / `[]` rather than throwing, so a bad stored expression can never
 * crash a render or a scheduler tick.
 *
 * Red-first unit-pinned by `src/lib/cron-schedule.test.ts`.
 */

/** The expanded fields of a parsed expression, plus the wildcard flags. */
export interface CronFields {
  /** Minutes, `0-59`, sorted ascending and de-duplicated. */
  minute: number[];
  /** Hours, `0-23`, sorted ascending and de-duplicated. */
  hour: number[];
  /** Days of month, `1-31`, sorted ascending and de-duplicated. */
  dayOfMonth: number[];
  /** Months, `1-12`, sorted ascending and de-duplicated. */
  month: number[];
  /** Days of week, `0-6` (0 = Sunday), sorted ascending and de-duplicated. */
  dayOfWeek: number[];
  /** The day-of-month field was written as a literal `*` (Vixie OR/AND rule). */
  domWildcard: boolean;
  /** The day-of-week field was written as a literal `*` (Vixie OR/AND rule). */
  dowWildcard: boolean;
}

interface FieldBounds {
  min: number;
  max: number;
  label: string;
}

const BOUNDS = {
  minute: { min: 0, max: 59, label: "minute" },
  hour: { min: 0, max: 23, label: "hour" },
  dayOfMonth: { min: 1, max: 31, label: "day of month" },
  month: { min: 1, max: 12, label: "month" },
  dayOfWeek: { min: 0, max: 6, label: "day of week" },
} as const satisfies Record<string, FieldBounds>;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * How many days `nextRuns` will scan before giving up. Covers the longest real
 * gap (Feb 29 across a non-leap century: 2096 → 2104) with room to spare, so a
 * satisfiable expression always yields its runs while an impossible one
 * (`0 0 31 2 *`) terminates and returns what it found.
 */
const MAX_SCAN_DAYS = 4000;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const pad2 = (value: number): string => String(value).padStart(2, "0");

const sameValues = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function fail(bounds: FieldBounds, detail: string): never {
  throw new Error(`Invalid cron ${bounds.label} field: ${detail} (expected ${bounds.min}-${bounds.max}).`);
}

/** A whole number inside the field's bounds. */
function readNumber(text: string, bounds: FieldBounds): number {
  if (!/^\d+$/.test(text)) fail(bounds, `"${text}" is not a number`);
  const value = Number(text);
  if (value < bounds.min || value > bounds.max) fail(bounds, `${value} is out of range`);
  return value;
}

/** Expand one field into sorted, de-duplicated values. */
function expandField(raw: string, bounds: FieldBounds): { values: number[]; wildcard: boolean } {
  if (raw.length === 0) fail(bounds, "empty field");
  const values = new Set<number>();
  for (const term of raw.split(",")) {
    if (term.length === 0) fail(bounds, `empty term in "${raw}"`);

    const slash = term.indexOf("/");
    let step = 1;
    let body = term;
    if (slash !== -1) {
      const stepText = term.slice(slash + 1);
      body = term.slice(0, slash);
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) fail(bounds, `bad step "${stepText}"`);
      step = Number(stepText);
    }

    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = bounds.min;
      hi = bounds.max;
    } else if (body.includes("-")) {
      const [start, end, ...rest] = body.split("-");
      if (rest.length > 0 || start === "" || end === "") fail(bounds, `bad range "${body}"`);
      lo = readNumber(start, bounds);
      hi = readNumber(end, bounds);
      if (lo > hi) fail(bounds, `range "${body}" is reversed`);
    } else {
      if (slash !== -1) fail(bounds, `step needs "*" or a range, got "${term}"`);
      lo = readNumber(body, bounds);
      hi = lo;
    }

    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard: raw === "*" };
}

/**
 * Parse a 5-field expression into expanded, sorted fields. Throws an `Error`
 * naming the offending field for a wrong field count, an out-of-range value, a
 * reversed range or a malformed step.
 */
export function parseCron(expr: string): CronFields {
  if (typeof expr !== "string") {
    throw new Error("Invalid cron expression: expected a string.");
  }
  const parts = expr.trim().split(/\s+/);
  if (expr.trim() === "" || parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expr}": expected 5 fields (minute hour day-of-month month day-of-week).`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const min = expandField(minute, BOUNDS.minute);
  const hr = expandField(hour, BOUNDS.hour);
  const dom = expandField(dayOfMonth, BOUNDS.dayOfMonth);
  const mo = expandField(month, BOUNDS.month);
  const dow = expandField(dayOfWeek, BOUNDS.dayOfWeek);
  return {
    minute: min.values,
    hour: hr.values,
    dayOfMonth: dom.values,
    month: mo.values,
    dayOfWeek: dow.values,
    domWildcard: dom.wildcard,
    dowWildcard: dow.wildcard,
  };
}

/** True when `expr` parses; any non-string or malformed input is `false`. */
export function isValidCron(expr: unknown): boolean {
  if (typeof expr !== "string") return false;
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/** Does the day (dom/dow under the Vixie rule) of `date` match? Month excluded. */
function matchesDay(fields: CronFields, date: Date): boolean {
  const domMatch = fields.domWildcard || fields.dayOfMonth.includes(date.getUTCDate());
  const dowMatch = fields.dowWildcard || fields.dayOfWeek.includes(date.getUTCDay());
  if (fields.domWildcard || fields.dowWildcard) return domMatch && dowMatch;
  return domMatch || dowMatch;
}

/**
 * Does `date` match the expression? Seconds and milliseconds are ignored, so
 * any instant in a matching UTC minute matches. An invalid expression or an
 * unparseable date answers `false`.
 */
export function matchesCron(expr: string, date: Date): boolean {
  let fields: CronFields;
  try {
    fields = parseCron(expr);
  } catch {
    return false;
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  return (
    fields.month.includes(date.getUTCMonth() + 1) &&
    fields.hour.includes(date.getUTCHours()) &&
    fields.minute.includes(date.getUTCMinutes()) &&
    matchesDay(fields, date)
  );
}

/**
 * The next `count` run instants strictly after `fromDate`, as whole minutes in
 * UTC. An instant exactly equal to `fromDate` is not a run (the schedule
 * advances *past* it), nor is any earlier one on the same day. Impossible
 * expressions, invalid input and a non-positive `count` return `[]`.
 */
export function nextRuns(expr: string, fromDate: Date, count: number): Date[] {
  let fields: CronFields;
  try {
    fields = parseCron(expr);
  } catch {
    return [];
  }
  if (!(fromDate instanceof Date) || Number.isNaN(fromDate.getTime())) return [];
  const wanted = Math.floor(count);
  if (!Number.isFinite(wanted) || wanted <= 0) return [];

  const from = fromDate.getTime();
  const startOfDay = Date.UTC(
    fromDate.getUTCFullYear(),
    fromDate.getUTCMonth(),
    fromDate.getUTCDate(),
  );
  const runs: Date[] = [];
  for (let day = 0; day < MAX_SCAN_DAYS && runs.length < wanted; day += 1) {
    const dayStart = startOfDay + day * DAY_MS;
    const probe = new Date(dayStart);
    if (!fields.month.includes(probe.getUTCMonth() + 1)) continue;
    if (!matchesDay(fields, probe)) continue;
    for (const hour of fields.hour) {
      for (const minute of fields.minute) {
        const at = dayStart + (hour * 60 + minute) * MINUTE_MS;
        if (at <= from) continue;
        runs.push(new Date(at));
        if (runs.length >= wanted) break;
      }
      if (runs.length >= wanted) break;
    }
  }
  return runs;
}

/**
 * A short human summary of an expression, e.g. `0 9 * * 1-5` →
 * "Every weekday at 09:00". Throws on a malformed expression (call
 * `isValidCron` first if the input is untrusted).
 */
export function describeCron(expr: string): string {
  const fields = parseCron(expr);
  const rawMinute = expr.trim().split(/\s+/)[0];

  const minuteEvery = fields.minute.length === 60;
  const hourEvery = fields.hour.length === 24;
  const hours = fields.hour.join(", ");
  const step = /^\*\/(\d+)$/.exec(rawMinute);

  let time: string;
  if (step && !minuteEvery) {
    const every = `every ${Number(step[1])} minutes`;
    time = hourEvery ? every : `${every} of hours ${hours}`;
  } else if (minuteEvery && hourEvery) {
    time = "every minute";
  } else if (minuteEvery) {
    time = `every minute of hours ${hours}`;
  } else if (hourEvery) {
    time =
      fields.minute.length === 1 && fields.minute[0] === 0
        ? "every hour"
        : `every hour at minute ${fields.minute.join(", ")}`;
  } else if (fields.minute.length === 1) {
    time = `at ${fields.hour.map((h) => `${pad2(h)}:${pad2(fields.minute[0])}`).join(" and ")}`;
  } else {
    time = `at minutes ${fields.minute.join(", ")} of hours ${hours}`;
  }

  const domEvery = fields.dayOfMonth.length === 31;
  const dowEvery = fields.dayOfWeek.length === 7;
  const dowNames = fields.dayOfWeek.map((d) => DAY_NAMES[d]).join(", ");
  let day: string;
  if (domEvery && dowEvery) {
    day = "every day";
  } else if (dowEvery) {
    day = `monthly on ${fields.dayOfMonth.length === 1 ? "day" : "days"} ${fields.dayOfMonth.join(", ")}`;
  } else if (domEvery) {
    if (sameValues(fields.dayOfWeek, [1, 2, 3, 4, 5])) day = "every weekday";
    else if (sameValues(fields.dayOfWeek, [0, 6])) day = "every weekend";
    else day = `every ${dowNames}`;
  } else {
    day = `on day ${fields.dayOfMonth.join(", ")} or ${dowNames}`;
  }

  const month =
    fields.month.length === 12 ? "" : ` in ${fields.month.map((m) => MONTH_NAMES[m - 1]).join(", ")}`;

  const head = `${day}${month}`;
  const sentence = day === "every day" && month === "" && time.startsWith("every")
    ? time
    : `${head} ${time}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

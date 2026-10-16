import { type Weekday } from "./recurrence";

/**
 * Pure scheduling engine for recurring tickets (§20) and schedule-triggered
 * automations (§13, docs/specs/automations.md R27.15): a tracker's "New →
 * Recurring ticket" shortcut is exactly a rule with a cadence and a
 * `create_ticket` action, so the cadence itself is decided here — no database,
 * no clock, no I/O.
 *
 * This is the generalized sibling of `src/lib/recurrence.ts`. It reuses that
 * module's `Weekday` vocabulary (read-only import) but deliberately does **not**
 * delegate to `nextOccurrences`, because ticket schedules need two things the
 * older engine does not offer:
 *
 *  - an injected time zone. Every evaluation takes `tzOffsetMinutes` (minutes
 *    **east** of UTC, e.g. `120` for UTC+2), and an occurrence instant is the
 *    local midnight of the scheduled calendar day. Nothing reads the host
 *    machine's zone, so results are byte-identical on every machine and DST is
 *    the caller's explicit concern rather than silent drift.
 *  - *skipping* invalid days instead of clamping them. `recurrence.ts` turns
 *    "monthly on the 31st" into Jan 31 → Feb 28; a ticket schedule on the 31st
 *    fires Jan 31 → Mar 31 and simply has no February occurrence.
 *
 * Everything is deterministic given its arguments: the same rule, window and
 * offset always produce the same instants, so `materializeTickets` drafts can
 * be written inside a transaction without double-creating rows (`ticketKey`
 * is the `(templateId, occurrence)` idempotency key the caller persists).
 */

/** Cadence vocabulary accepted by `parseRule`. */
export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

/**
 * A normalized recurrence rule (the output of `parseRule`, safe to persist in
 * JSON columns such as `Automation.triggerConfig`).
 *
 * - `interval` — every N days/weeks/months/years, always 1..365.
 * - `byWeekday` — weekly: which weekdays fire (e.g. `["tue", "thu"]`);
 *   defaults to the anchor's weekday.
 * - `byMonthDay` — monthly/yearly: day(s) of month 1..31; a day that does not
 *   exist in a month is skipped (never clamped); defaults to the anchor's day.
 * - `count` / `until` — the series stops after `count` occurrences (counted
 *   from the anchor) or after the last occurrence not later than `until`.
 * - `start` — the series anchor (an RFC 5545 `DTSTART`-ish instant); when
 *   absent the evaluation's `from` is the anchor, so a one-shot preview works
 *   without a stored start.
 */
export interface RecurrenceRule {
  freq: Frequency;
  interval: number;
  byWeekday?: Weekday[];
  byMonthDay?: number[];
  count?: number;
  until?: Date;
  start?: Date;
}

/** Accepted `interval` range; hostile values are rejected by `parseRule`. */
export const MIN_INTERVAL = 1;
export const MAX_INTERVAL = 365;

/** Occurrences returned by `occurrencesBetween` when the caller gives no limit. */
export const DEFAULT_OCCURRENCE_LIMIT = 100;

/** Absolute ceiling on a single evaluation, so a runaway window cannot hang. */
export const MAX_OCCURRENCES = 1000;

/** Raised by `parseRule` with a human-readable explanation of bad input. */
export class RecurrenceRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceRuleError";
  }
}

const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "monthly", "yearly"];
const RULE_KEYS = new Set(["freq", "interval", "byWeekday", "byMonthDay", "count", "until", "start"]);
const UNIT_NOUN: Record<Frequency, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/** Weekdays in calendar order; the type is shared with `recurrence.ts`. */
const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_INDEX: Record<Weekday, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/* ------------------------------------------------------------------ *
 * parseRule — strict validation with friendly messages.
 * ------------------------------------------------------------------ */

/** A non-null, non-array object, tolerating a JSON string in front of it. */
function coerceRecord(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new RecurrenceRuleError("Rule is not valid JSON.");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecurrenceRuleError("Rule must be an object.");
  }
  return value as Record<string, unknown>;
}

function parseInterval(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_INTERVAL ||
    value > MAX_INTERVAL
  ) {
    throw new RecurrenceRuleError(
      `"interval" must be an integer between ${MIN_INTERVAL} and ${MAX_INTERVAL}.`,
    );
  }
  return value;
}

function parseCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RecurrenceRuleError('"count" must be a positive integer.');
  }
  return value;
}

function parseDate(value: unknown, key: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (!Number.isFinite(date.getTime())) {
    throw new RecurrenceRuleError(`"${key}" must be a valid Date or ISO string.`);
  }
  return date;
}

/** Unique weekdays in Sunday-first calendar order. */
const sortWeekdays = (days: readonly Weekday[]): Weekday[] =>
  [...new Set(days)].sort((a, b) => WEEKDAY_INDEX[a] - WEEKDAY_INDEX[b]);

function parseWeekdays(value: unknown, freq: Frequency): Weekday[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (freq !== "weekly") {
    throw new RecurrenceRuleError('"byWeekday" is only valid for weekly rules.');
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) {
    throw new RecurrenceRuleError('"byWeekday" must name at least one weekday.');
  }
  const days: Weekday[] = [];
  for (const entry of list) {
    const name = typeof entry === "string" ? (entry.toLowerCase() as Weekday) : null;
    if (!name || !(name in WEEKDAY_INDEX)) {
      throw new RecurrenceRuleError(`"byWeekday" contains an unknown weekday: ${String(entry)}.`);
    }
    days.push(name);
  }
  return sortWeekdays(days);
}

function parseMonthDays(value: unknown, freq: Frequency): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (freq !== "monthly" && freq !== "yearly") {
    throw new RecurrenceRuleError('"byMonthDay" is only valid for monthly or yearly rules.');
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) {
    throw new RecurrenceRuleError('"byMonthDay" must name at least one day.');
  }
  const days: number[] = [];
  for (const entry of list) {
    if (
      typeof entry !== "number" ||
      !Number.isInteger(entry) ||
      entry < 1 ||
      entry > 31
    ) {
      throw new RecurrenceRuleError('"byMonthDay" must be day numbers between 1 and 31.');
    }
    days.push(entry);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Validate and normalize a raw rule (an object, or a JSON string of one).
 * Strict: unknown keys, unknown frequencies, frequency-inappropriate fields
 * and out-of-range numbers are rejected with a `RecurrenceRuleError` whose
 * message names the offending field.
 */
export function parseRule(raw: unknown): RecurrenceRule {
  const record = coerceRecord(raw);
  for (const key of Object.keys(record)) {
    if (!RULE_KEYS.has(key)) {
      throw new RecurrenceRuleError(`Unknown rule key "${key}".`);
    }
  }

  const freq = record.freq;
  if (typeof freq !== "string" || !FREQUENCIES.includes(freq as Frequency)) {
    throw new RecurrenceRuleError(`"freq" must be one of: ${FREQUENCIES.join(", ")}.`);
  }
  const frequency = freq as Frequency;

  const rule: RecurrenceRule = { freq: frequency, interval: parseInterval(record.interval) };
  const byWeekday = parseWeekdays(record.byWeekday, frequency);
  if (byWeekday) rule.byWeekday = byWeekday;
  const byMonthDay = parseMonthDays(record.byMonthDay, frequency);
  if (byMonthDay) rule.byMonthDay = byMonthDay;
  const count = parseCount(record.count);
  if (count !== undefined) rule.count = count;
  const until = parseDate(record.until, "until");
  if (until !== undefined) rule.until = until;
  const start = parseDate(record.start, "start");
  if (start !== undefined) rule.start = start;
  return rule;
}

/* ------------------------------------------------------------------ *
 * Calendar arithmetic, in the injected zone.
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Periods a single generator will walk before giving up (bounds pathological rules). */
const MAX_SCAN_PERIODS = 4_000;

/** A calendar date in the rule's zone. */
interface LocalDate {
  y: number;
  m: number;
  d: number;
}

/** Day number of a local calendar date (1970-01-01 → 0). */
const dayIndexOf = (y: number, m: number, d: number): number =>
  Math.floor(Date.UTC(y, m, d) / DAY_MS);

const lastDayOfMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The local calendar date on which `instant` falls in the injected zone. */
const localDateOf = (instant: Date, offset: number): LocalDate => {
  const shifted = new Date(instant.getTime() + offset * MINUTE_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
};

/** The local calendar date a day index names. */
const localDateOfDayIndex = (index: number): LocalDate => {
  const date = new Date(index * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
};

/** Local midnight of a day index, as an instant. */
const instantOfDayIndex = (index: number, offset: number): Date =>
  new Date(index * DAY_MS - offset * MINUTE_MS);

const weekdayOfLocal = (local: LocalDate): Weekday =>
  WEEKDAYS[new Date(Date.UTC(local.y, local.m, local.d)).getUTCDay()];

/** Weekday → offset inside a Monday-based week (Mon 0 … Sun 6). */
const offsetInWeek = (weekday: Weekday): number => (WEEKDAY_INDEX[weekday] + 6) % 7;

/** Monday-based week number; week 0 contains 1970-01-01 (a Thursday). */
const weekIndexOfDayIndex = (index: number): number => Math.floor((index + 3) / 7);

const validDate = (value: Date | undefined): Date | undefined =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value : undefined;

function normalizeInterval(interval: number): number {
  return Number.isFinite(interval)
    ? Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.floor(interval)))
    : 1;
}

/** Requested month days (1..31), defaulting to the anchor's day. */
function monthDaysFor(rule: RecurrenceRule, epoch: LocalDate): number[] {
  const valid = (rule.byMonthDay ?? []).filter(
    (day) => Number.isInteger(day) && day >= 1 && day <= 31,
  );
  const days = valid.length > 0 ? valid : [epoch.d];
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Requested weekdays as Monday-based offsets, defaulting to the anchor's weekday. */
function weekOffsetsFor(rule: RecurrenceRule, epoch: LocalDate): number[] {
  const valid = (rule.byWeekday ?? []).filter((day): day is Weekday => day in WEEKDAY_INDEX);
  const list = valid.length > 0 ? valid : [weekdayOfLocal(epoch)];
  return [...new Set(list.map(offsetInWeek))].sort((a, b) => a - b);
}

/**
 * Yield aligned occurrence instants ascending from the epoch.
 *
 * `floorDayIndex` lets the caller skip whole periods that can only produce
 * instants at or before the window start; it is ignored (so `count` stays
 * accurate) when `fullScan` is set — i.e. when the rule counts occurrences.
 */
function* candidateInstants(
  rule: RecurrenceRule,
  epoch: LocalDate,
  offset: number,
  floorDayIndex: number,
  fullScan: boolean,
): Generator<Date> {
  const interval = normalizeInterval(rule.interval);
  const epochDayIndex = dayIndexOf(epoch.y, epoch.m, epoch.d);
  const startDayIndex = fullScan ? epochDayIndex : Math.max(epochDayIndex, floorDayIndex);

  if (rule.freq === "daily") {
    const base = Math.max(0, Math.floor((startDayIndex - epochDayIndex) / interval));
    for (let i = 0; i < MAX_SCAN_PERIODS; i += 1) {
      yield instantOfDayIndex(epochDayIndex + (base + i) * interval, offset);
    }
    return;
  }

  if (rule.freq === "weekly") {
    const offsets = weekOffsetsFor(rule, epoch);
    const epochWeek = weekIndexOfDayIndex(epochDayIndex);
    const base = Math.max(
      0,
      Math.floor((weekIndexOfDayIndex(startDayIndex) - epochWeek) / interval),
    );
    for (let i = 0; i < MAX_SCAN_PERIODS; i += 1) {
      const monday = (epochWeek + (base + i) * interval) * 7 - 3;
      for (const weekdayOffset of offsets) {
        const index = monday + weekdayOffset;
        if (index >= epochDayIndex) yield instantOfDayIndex(index, offset);
      }
    }
    return;
  }

  if (rule.freq === "monthly") {
    const days = monthDaysFor(rule, epoch);
    const epochMonth = epoch.y * 12 + epoch.m;
    const floor = localDateOfDayIndex(startDayIndex);
    const base = Math.max(
      0,
      Math.floor((floor.y * 12 + floor.m - epochMonth) / interval),
    );
    for (let i = 0; i < MAX_SCAN_PERIODS; i += 1) {
      const month = epochMonth + (base + i) * interval;
      const y = Math.floor(month / 12);
      const m = month % 12;
      const last = lastDayOfMonth(y, m);
      for (const day of days) {
        // Skip months that have no such day (Feb 30, Apr 31 …) — never clamp.
        if (day > last) continue;
        const index = dayIndexOf(y, m, day);
        if (index >= epochDayIndex) yield instantOfDayIndex(index, offset);
      }
    }
    return;
  }

  // yearly — the anchor month, on the requested day(s), each aligned year.
  const days = monthDaysFor(rule, epoch);
  const base = Math.max(
    0,
    Math.floor((localDateOfDayIndex(startDayIndex).y - epoch.y) / interval),
  );
  for (let i = 0; i < MAX_SCAN_PERIODS; i += 1) {
    const y = epoch.y + (base + i) * interval;
    const last = lastDayOfMonth(y, epoch.m);
    for (const day of days) {
      if (day > last) continue;
      const index = dayIndexOf(y, epoch.m, day);
      if (index >= epochDayIndex) yield instantOfDayIndex(index, offset);
    }
  }
}

/** Core walk: series (epoch → count/until), then window (from, to], then limit. */
function enumerate(
  rule: RecurrenceRule,
  from: Date,
  to: Date | null,
  limit: number,
  offset: number,
): Date[] {
  const results: Date[] = [];
  if (!Number.isFinite(from.getTime())) return results;

  const fromTime = from.getTime();
  // `to === null` means "unbounded" (internal callers); a supplied date that
  // is invalid means "empty window", never an unbounded one.
  if (to !== null && !Number.isFinite(to.getTime())) return results;
  const toTime = to === null ? null : to.getTime();
  if (toTime !== null && toTime <= fromTime) return results;

  const wanted = Math.max(0, Math.min(MAX_OCCURRENCES, Math.floor(limit)));
  if (wanted === 0) return results;

  const epoch = localDateOf(validDate(rule.start) ?? from, offset);
  const fromLocal = localDateOf(from, offset);
  const floorDayIndex = dayIndexOf(fromLocal.y, fromLocal.m, fromLocal.d);
  const fullScan = rule.count !== undefined;
  const untilTime = validDate(rule.until)?.getTime() ?? Number.POSITIVE_INFINITY;
  const count = rule.count === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(rule.count));

  let seriesIndex = 0;
  for (const candidate of candidateInstants(rule, epoch, offset, floorDayIndex, fullScan)) {
    if (seriesIndex >= count) break;
    const time = candidate.getTime();
    if (time > untilTime) break;
    seriesIndex += 1;
    if (time <= fromTime) continue;
    if (toTime !== null && time > toTime) break;
    results.push(candidate);
    if (results.length >= wanted) break;
  }
  return results;
}

function resolveOffset(options: OccurrenceOptions | undefined): number {
  const value = options?.tzOffsetMinutes;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Time-zone / evaluation options shared by the occurrence helpers. */
export interface OccurrenceOptions {
  /**
   * Offset of the schedule's zone from UTC, in minutes **east** of UTC
   * (`120` for UTC+2, `-300` for EST). Defaults to `0` (UTC), so an
   * evaluation never depends on the host machine's zone.
   */
  tzOffsetMinutes?: number;
}

/** `occurrencesBetween` options: the shared offset plus a result cap. */
export interface WindowOptions extends OccurrenceOptions {
  /** Maximum occurrences to return; defaults to `DEFAULT_OCCURRENCE_LIMIT`. */
  limit?: number;
}

/**
 * The next occurrence strictly after `from`, or `null` when the rule never
 * fires again (its `count`/`until` bound is exhausted, or `from` is invalid).
 */
export function nextOccurrence(
  rule: RecurrenceRule,
  from: Date,
  options: OccurrenceOptions = {},
): Date | null {
  const [first] = enumerate(rule, from, null, 1, resolveOffset(options));
  return first ?? null;
}

/**
 * Every occurrence strictly after `from` and not after `to`, ascending.
 * `limit` caps the result; the rule's own `count`/`until` bound still applies.
 * Invalid dates or an empty/inverted window yield `[]`.
 */
export function occurrencesBetween(
  rule: RecurrenceRule,
  from: Date,
  to: Date,
  options: WindowOptions = {},
): Date[] {
  const limit = options.limit === undefined ? DEFAULT_OCCURRENCE_LIMIT : options.limit;
  if (typeof limit !== "number" || Number.isNaN(limit) || limit <= 0) return [];
  return enumerate(rule, from, to, limit, resolveOffset(options));
}

/* ------------------------------------------------------------------ *
 * describeRule — one-line human summary.
 * ------------------------------------------------------------------ */

const capitalizeWeekday = (weekday: Weekday): string =>
  weekday[0].toUpperCase() + weekday.slice(1);

function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function ordinalList(days: readonly number[]): string {
  const ordinals = [...days].sort((a, b) => a - b).map(ordinal);
  if (ordinals.length === 1) return ordinals[0];
  return `${ordinals.slice(0, -1).join(", ")} and ${ordinals[ordinals.length - 1]}`;
}

/**
 * A short summary such as `"Every 2 weeks on Tue, Thu"`, including a
 * `", 3 times"` / `", until YYYY-MM-DD"` tail when the rule is bounded.
 */
export function describeRule(rule: RecurrenceRule): string {
  const interval = normalizeInterval(rule.interval);
  const noun = UNIT_NOUN[rule.freq];
  const base = interval === 1 ? `Every ${noun}` : `Every ${interval} ${noun}s`;

  let detail = "";
  if (rule.freq === "weekly" && rule.byWeekday && rule.byWeekday.length > 0) {
    detail = ` on ${sortWeekdays(rule.byWeekday).map(capitalizeWeekday).join(", ")}`;
  } else if (
    (rule.freq === "monthly" || rule.freq === "yearly") &&
    rule.byMonthDay &&
    rule.byMonthDay.length > 0
  ) {
    detail = ` on the ${ordinalList(rule.byMonthDay)}`;
  }

  let bounds = "";
  if (typeof rule.count === "number") bounds += `, ${rule.count} times`;
  const until = validDate(rule.until);
  if (until) bounds += `, until ${until.toISOString().slice(0, 10)}`;

  return `${base}${detail}${bounds}`;
}

/* ------------------------------------------------------------------ *
 * materializeTickets / shouldSpawn — the cron-facing surface.
 * ------------------------------------------------------------------ */

/** The template a recurring rule clones; a pure projection, no database row. */
export interface TicketTemplate {
  id: string;
  title: string;
  projectId?: string | null;
  priority?: string | null;
  labels?: readonly string[] | null;
}

/** One deterministic, not-yet-persisted ticket. */
export interface TicketDraft {
  templateId: string;
  /** The scheduled instant (local midnight of the occurrence day). */
  occurrence: Date;
  /** Idempotency key — persist it to guarantee at-most-once materialization. */
  key: string;
  actorId: string;
  title: string;
  projectId: string | null;
  priority: string | null;
  labels: string[];
}

/** Inputs for `materializeTickets`. */
export interface MaterializeOptions {
  /** Exclusive lower bound of the window. */
  from: Date;
  /** Inclusive upper bound of the window. */
  to: Date;
  /** Who is credited as the ticket's creator. */
  actorId: string;
  /** See `OccurrenceOptions.tzOffsetMinutes`. */
  tzOffsetMinutes?: number;
  /** Cap on drafts produced; see `WindowOptions.limit`. */
  limit?: number;
  /** Keys already persisted, so a retry never duplicates them. */
  existing?: Iterable<string>;
}

/**
 * The stable idempotency key for one `(templateId, occurrence)` pair. Two
 * calls with the same pair — a re-run after a crash, a retried cron tick —
 * produce the same key and therefore never create two tickets.
 */
export function ticketKey(templateId: string, occurrence: Date): string {
  return `${templateId}:${occurrence.toISOString()}`;
}

/**
 * Turn a rule into deterministic ticket drafts for `(from, to]`. Pure: no I/O,
 * no clock, and the template is never mutated (labels are copied). Drafts the
 * caller already persisted (`options.existing`) are skipped by
 * `(templateId, occurrence)`, and the batch is deduped the same way.
 */
export function materializeTickets(
  rule: RecurrenceRule,
  template: TicketTemplate,
  options: MaterializeOptions,
): TicketDraft[] {
  const seen = new Set<string>();
  if (options.existing) {
    for (const key of options.existing) seen.add(key);
  }

  const occurrences = occurrencesBetween(rule, options.from, options.to, {
    limit: options.limit,
    tzOffsetMinutes: options.tzOffsetMinutes,
  });

  const drafts: TicketDraft[] = [];
  for (const occurrence of occurrences) {
    const key = ticketKey(template.id, occurrence);
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      templateId: template.id,
      occurrence,
      key,
      actorId: options.actorId,
      title: template.title,
      projectId: template.projectId ?? null,
      priority: template.priority ?? null,
      labels: template.labels ? [...template.labels] : [],
    });
  }
  return drafts;
}

/**
 * Cron gate: is the rule's next occurrence (measured from the last time it
 * spawned) due at or before `now`? `false` when nothing has spawned yet, when
 * either date is invalid, or when the series is exhausted.
 */
export function shouldSpawn(
  rule: RecurrenceRule,
  lastSpawnedAt: Date | null,
  now: Date,
): boolean {
  if (!Number.isFinite(now.getTime())) return false;
  if (!lastSpawnedAt || !Number.isFinite(lastSpawnedAt.getTime())) return false;
  const next = nextOccurrence(rule, lastSpawnedAt);
  return next !== null && next.getTime() <= now.getTime();
}

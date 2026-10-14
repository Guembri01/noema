/**
 * Date reminders (docs/FEATURE_MATRIX.md "Date reminders": notify at a chosen
 * time). A reminder is a signed offset around a date property's due instant;
 * `before` fires ahead of it, `after` trails it.
 *
 * PURE module: no prisma, no `node:*` imports, no ambient clock. Every function
 * is handed the instant it measures against (`nextReminder`'s `now`), so a
 * property editor, a scheduler and a notification worker all derive the same
 * times. Mirrors `src/lib/date-range.ts`: date-only and zone-less ISO strings
 * are read as **UTC** from their components (never local `new Date(str)`, which
 * would shift the instant in negative offsets), explicit `Z`/`±hh:mm` offsets
 * are honoured, and output is always `toISOString()` in UTC. That keeps server
 * and client byte-identical.
 *
 * Fail-soft: an unparseable due date yields no times, and a malformed offset is
 * skipped rather than thrown on - a bad row can only drop a reminder, never
 * crash a list render.
 *
 * Red-first unit-pinned by `src/lib/date-reminder.test.ts`.
 */

export type ReminderUnit = "minutes" | "hours" | "days";

export type ReminderDirection = "before" | "after";

/**
 * A relative reminder: `amount` whole units of `unit`, fired `direction` of the
 * due instant. `amount: 0` means the due instant itself (regardless of
 * direction).
 */
export type ReminderOffset = {
  amount: number;
  unit: ReminderUnit;
  direction: ReminderDirection;
};

const MS_PER_MINUTE = 60_000;

const UNIT_MS: Record<ReminderUnit, number> = {
  minutes: MS_PER_MINUTE,
  hours: 60 * MS_PER_MINUTE,
  days: 24 * 60 * MS_PER_MINUTE,
};

/** Matches a date, or a datetime with optional seconds/fraction and zone. */
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Absolute UTC instant (ms) of an ISO string, or null when invalid. A
 * date-only or zone-less value is read from its calendar components as UTC;
 * an explicit `Z`/offset is subtracted from the component-based instant.
 * Calendar overflow (e.g. Feb 30 rolling into March) is rejected.
 */
function parseInstantUtc(value: string): number | null {
  const match = ISO_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = match[4] ? Number(match[4]) : 0;
  const minutes = match[5] ? Number(match[5]) : 0;
  const seconds = match[6] ? Number(match[6]) : 0;
  const ms = match[7] ? Number(match[7].padEnd(3, "0")) : 0;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null;
  }
  let instant = Date.UTC(year, month - 1, day, hours, minutes, seconds, ms);
  if (Number.isNaN(instant)) return null;
  const check = new Date(instant);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null; // calendar overflow, e.g. 2026-02-30
  }
  const zone = match[8];
  if (zone && zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2));
    instant -= sign * offsetMinutes * MS_PER_MINUTE;
  }
  return instant;
}

const isUnit = (value: unknown): value is ReminderUnit =>
  value === "minutes" || value === "hours" || value === "days";

const isDirection = (value: unknown): value is ReminderDirection =>
  value === "before" || value === "after";

/**
 * Validate and normalise a raw reminder offset (e.g. JSON straight off a row or
 * a property editor). Requires a plain object with an integer `amount >= 0`, a
 * known `unit` and a known `direction`; unknown fields are dropped. Returns null
 * for anything malformed so callers can skip it.
 */
export function parseReminderOffset(raw: unknown): ReminderOffset | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const amount = candidate.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) return null;
  if (!isUnit(candidate.unit)) return null;
  if (!isDirection(candidate.direction)) return null;
  return { amount, unit: candidate.unit, direction: candidate.direction };
}

/**
 * Every reminder time for a due instant, as ISO strings sorted ascending. Each
 * offset is `due - delta` (before) or `due + delta` (after); equal instants
 * collapse to one entry. An unparseable due date yields `[]`; malformed offsets
 * are skipped, and the input is never mutated.
 */
export function computeReminderTimes(
  dueISO: string,
  offsets: readonly ReminderOffset[],
): string[] {
  const due = parseInstantUtc(dueISO);
  if (due === null) return [];
  const instants = new Set<number>();
  for (const raw of offsets) {
    const offset = parseReminderOffset(raw);
    if (!offset) continue;
    const delta = offset.amount * UNIT_MS[offset.unit];
    instants.add(offset.direction === "before" ? due - delta : due + delta);
  }
  return [...instants].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

/**
 * The earliest reminder **strictly after** `now` - the next one a scheduler
 * should queue - or null when none remain (all past, no offsets, or an
 * unparseable due date). `now` may be a `Date`, epoch ms or ISO string; every
 * measurement is against that injected instant, never the ambient clock.
 */
export function nextReminder(
  dueISO: string,
  offsets: readonly ReminderOffset[],
  now: Date | number | string,
): string | null {
  const nowMs =
    now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : parseInstantUtc(now);
  if (nowMs === null || Number.isNaN(nowMs)) return null;
  for (const iso of computeReminderTimes(dueISO, offsets)) {
    if (Date.parse(iso) > nowMs) return iso;
  }
  return null;
}

const UNIT_LABELS: Record<ReminderUnit, [string, string]> = {
  minutes: ["minute", "minutes"],
  hours: ["hour", "hours"],
  days: ["day", "days"],
};

/**
 * Human label for an offset: `"30 minutes before"`, `"1 hour after"`, or
 * `"at the due time"` for a zero amount. A malformed offset reads
 * `"invalid reminder"` rather than throwing.
 */
export function describeOffset(offset: ReminderOffset): string {
  const parsed = parseReminderOffset(offset);
  if (!parsed) return "invalid reminder";
  if (parsed.amount === 0) return "at the due time";
  const [singular, plural] = UNIT_LABELS[parsed.unit];
  const unit = parsed.amount === 1 ? singular : plural;
  return `${parsed.amount} ${unit} ${parsed.direction}`;
}

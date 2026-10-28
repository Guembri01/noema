/**
 * A dependency-free monthly calendar model used by the inline calendar block.
 *
 * Dates are stored as `YYYY-MM-DD` keys and months as `YYYY-MM`, both parsed in
 * UTC so a user west of Greenwich cannot see a day shift when the page is
 * rendered on the server and rehydrated in the browser.
 */

export type CalendarEvent = {
  id: string;
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  title: string;
};

export type CalendarCell = {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
};

export const CALENDAR_EVENT_LIMIT = 500;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The current month key in UTC. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
}

/** Today's date key in UTC. */
export function todayKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

/** Validate a `YYYY-MM` key. */
export function isMonthKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const [year, month] = value.split("-").map(Number);
  return year >= 1970 && year <= 9999 && month >= 1 && month <= 12;
}

/** Validate a `YYYY-MM-DD` key. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Move a month key by `delta` months, keeping the key well-formed. */
export function moveMonth(month: string, delta: number): string {
  const safe = isMonthKey(month) ? month : currentMonth();
  const [year, rawMonth] = safe.split("-").map(Number);
  const date = new Date(Date.UTC(year, rawMonth - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/**
 * Six-week grid (42 cells), Monday-first by default. Leading and trailing days
 * belong to the neighbouring month and are marked `inMonth: false`.
 */
export function monthGrid(month: string, options: { weekStartsOn?: 0 | 1; today?: Date } = {}): CalendarCell[] {
  const safe = isMonthKey(month) ? month : currentMonth();
  const weekStartsOn = options.weekStartsOn ?? 1;
  const today = options.today ? todayKey(options.today) : todayKey();
  const [year, monthNumber] = safe.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const offset = (first.getUTCDay() - weekStartsOn + 7) % 7;
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - offset);

  const cells: CalendarCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const key = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    cells.push({
      date: key,
      day: date.getUTCDate(),
      inMonth: date.getUTCMonth() === monthNumber - 1,
      isToday: key === today,
    });
  }
  return cells;
}

/** Parse the JSON string stored in the node attribute. Never throws. */
export function parseCalendarEvents(raw: unknown): CalendarEvent[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is CalendarEvent => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<CalendarEvent>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.title === "string" &&
        isDateKey(candidate.date)
      );
    })
    .slice(0, CALENDAR_EVENT_LIMIT)
    .map((entry) => ({
      id: entry.id,
      date: entry.date,
      title: entry.title.slice(0, 200),
    }));
}

/** Add one event, replacing an event with the same id. */
export function addCalendarEvent(
  events: readonly CalendarEvent[],
  event: CalendarEvent,
): CalendarEvent[] {
  return [...events.filter((entry) => entry.id !== event.id), event]
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
    .slice(0, CALENDAR_EVENT_LIMIT);
}

/** Remove one event by id. */
export function removeCalendarEvent(events: readonly CalendarEvent[], id: string): CalendarEvent[] {
  return events.filter((entry) => entry.id !== id);
}

/** Events on a day, in stable title order. */
export function eventsForDay(events: readonly CalendarEvent[], date: string): CalendarEvent[] {
  return events
    .filter((event) => event.date === date)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** A new event with a collision-resistant id. */
export function newCalendarEvent(date: string, title: string): CalendarEvent {
  const trimmed = title.trim().slice(0, 200);
  return {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    date,
    title: trimmed || "Untitled event",
  };
}

/** Monday-first weekday labels (short, locale-independent fallback). */
export const CALENDAR_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

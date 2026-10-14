/**
 * Timeline/calendar positioning + lane packing
 * (docs/MISSING_FEATURES.md §3 rows "Timeline view" and "Calendar
 * multi-day events"; spec R89.10/R89.11 date-range math).
 *
 * Pure functions over **ms epochs** — the unit for every `start`/`end`
 * number in this module. No DB, no `Date.now()`, no timezone dependence:
 * intervals use the half-open rule `[start, end)` (back-to-back events do
 * not overlap) and calendar day keys are computed in UTC with a
 * configurable day-boundary hour, so results are identical on any machine.
 *
 * This is positioning logic only; the timeline/calendar UI that consumes
 * it and the dependency-arrow layer (R89.31) are separate work.
 */

/** A viewport on the time axis. Half-open: `end` is exclusive. */
export type TimeWindow = { start: number; end: number };

/** Any half-open time interval in ms epochs. */
export type TimeSpan = { start: number; end: number };

/** An event paired with its 0..1 position inside a window. */
export type PositionedEvent<T> = { event: T; left: number; width: number };

/** One event assigned to a lane (row). */
export type LaneAssignment<T> = { event: T; lane: number };

export type LaneResult<T> = {
  assignments: LaneAssignment<T>[];
  laneCount: number;
};

/**
 * Minimum bar width as a fraction of the window. Instant (zero-length) or
 * sliver events are promoted to this width so they remain visible and
 * hoverable instead of rendering as a zero-pixel sliver.
 */
export const MIN_BAR_FRACTION = 0.01;

/** Safety cap for `daysSpanned` so a decades-long event cannot allocate forever. */
const MAX_DAYS_SPANNED = 5000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Intersect an event with the window. Events fully outside collapse to a
 * zero-length span at the near window edge (`window.start` if the event
 * ends before the window, `window.end` if it starts after).
 */
export function clampToWindow(event: TimeSpan, window: TimeWindow): TimeSpan {
  const start = Math.min(Math.max(event.start, window.start), window.end);
  const end = Math.min(Math.max(event.end, window.start), window.end);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * Position an event on a 0..1 timeline axis.
 *
 * - Fully inside → exact fraction of the window.
 * - Hanging off either edge → clipped to the window.
 * - Fully outside (or merely touching an edge) → `{ left: 0 | 1, width: 0 }`;
 *   the caller decides whether to hide zero-width bars.
 * - Instant / sliver events → promoted to `MIN_BAR_FRACTION`, nudged left
 *   if needed so `left + width <= 1`.
 * - Degenerate window (`end <= start`) → `{ left: 0, width: 0 }`.
 */
export function normalizeSpan(
  event: TimeSpan,
  window: TimeWindow,
): { left: number; width: number } {
  const duration = window.end - window.start;
  if (!Number.isFinite(duration) || duration <= 0) {
    return { left: 0, width: 0 };
  }
  const spansWindow = event.start < window.end && event.end > window.start;
  const instantInside =
    event.start === event.end &&
    event.start >= window.start &&
    event.start < window.end;
  if (!spansWindow && !instantInside) {
    return { left: event.start < window.start ? 0 : 1, width: 0 };
  }
  const clamped = clampToWindow(event, window);
  let left = (clamped.start - window.start) / duration;
  let width = (clamped.end - clamped.start) / duration;
  if (width < MIN_BAR_FRACTION) width = MIN_BAR_FRACTION;
  if (left + width > 1) left = 1 - width;
  return { left: Math.max(0, left), width };
}

/**
 * Position every event for rendering. Output preserves input order so a UI
 * can zip bars against its row list; each event keeps its generic payload.
 */
export function positionBars<T extends TimeSpan>(
  events: readonly T[],
  window: TimeWindow,
): PositionedEvent<T>[] {
  return events.map((event) => ({ event, ...normalizeSpan(event, window) }));
}

/**
 * Half-open overlap test: two intervals overlap iff each starts before the
 * other ends. Back-to-back intervals (`a.end === b.start`) do not overlap,
 * so consecutive events can share a calendar row; an instant `[t, t)`
 * overlaps exactly the intervals strictly containing `t`.
 */
export function overlaps(a: TimeSpan, b: TimeSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Collapse a set of intervals into the minimal sorted list of disjoint
 * spans, merging intervals that overlap **or touch** (`a.end === b.start`
 * is continuous coverage for a merged block). Instants contained in a span
 * are absorbed; isolated instants are kept as-is.
 */
export function mergeOverlaps(events: readonly TimeSpan[]): TimeSpan[] {
  const sorted = [...events].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  const merged: TimeSpan[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/**
 * Greedy interval-graph colouring: assign each event the lowest lane no
 * earlier event in it overlaps. Events are processed in a deterministic
 * order (start, then end, then id), so the same set always produces the
 * same lanes regardless of input order. Output is in that sorted order.
 * Lane indices are 0-based and `laneCount` is the number of used lanes.
 */
export function assignLanes<T extends TimeSpan & { id: string }>(
  events: readonly T[],
): LaneResult<T> {
  const sorted = [...events].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
  );
  const laneLast: (T | null)[] = [];
  const assignments: LaneAssignment<T>[] = [];
  for (const event of sorted) {
    let lane = laneLast.findIndex(
      (last) => last === null || !overlaps(last, event),
    );
    if (lane === -1) {
      lane = laneLast.length;
      laneLast.push(null);
    }
    laneLast[lane] = event;
    assignments.push({ event, lane });
  }
  return { assignments, laneCount: laneLast.length };
}

function assertBoundaryHour(boundaryHour: number): void {
  if (!Number.isFinite(boundaryHour) || boundaryHour < 0 || boundaryHour >= 24) {
    throw new RangeError(
      `boundaryHour must be a finite number in [0, 24), got ${boundaryHour}`,
    );
  }
}

/**
 * The UTC `YYYY-MM-DD` key of the calendar day containing `ms`, where a
 * day runs from `boundaryHour` to the next day's `boundaryHour`. With
 * boundary 4, for example, "Monday" is Mon 04:00 → Tue 04:00, so 02:00
 * Monday belongs to Sunday's key.
 */
export function dayKeyFor(ms: number, boundaryHour: number): string {
  assertBoundaryHour(boundaryHour);
  const shifted = new Date(ms - boundaryHour * MS_PER_HOUR);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Every day-key an event touches, inclusive of both endpoint days — the
 * expansion a month/week calendar grid needs to draw multi-day bars.
 * The event's `end` is exclusive per the half-open rule: an event ending
 * exactly on a day boundary does not spill into the next day. Instants span
 * exactly their own day. Throws `RangeError` for a boundary hour outside
 * [0, 24) or a span longer than the internal safety cap.
 */
export function daysSpanned(event: TimeSpan, boundaryHour: number): string[] {
  assertBoundaryHour(boundaryHour);
  const offset = boundaryHour * MS_PER_HOUR;
  const startDay = Math.floor((event.start - offset) / MS_PER_DAY);
  const lastInstant = event.end <= event.start ? event.start : event.end - 1;
  const endDay = Math.floor((lastInstant - offset) / MS_PER_DAY);
  const count = endDay - startDay + 1;
  if (count > MAX_DAYS_SPANNED) {
    throw new RangeError(
      `daysSpanned: ${count} days exceeds the safety cap of ${MAX_DAYS_SPANNED}`,
    );
  }
  const days: string[] = [];
  for (let i = 0; i < count; i++) {
    days.push(dayKeyFor(startDay * MS_PER_DAY + offset + i * MS_PER_DAY, boundaryHour));
  }
  return days;
}

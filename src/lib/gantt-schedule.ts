import { MS_PER_DAY } from "@/lib/calendar-multiday";

/**
 * Calendar-day arithmetic for the project Gantt's drag and resize.
 *
 * The Gantt is a *calendar* chart: its axis, its labels and its bar geometry are
 * all local-midnight days (`buildGanttAxis`, `percentAlong`). `@/lib/timeline-drag`
 * — the database timeline's drag maths — is UTC by contract so that its results
 * are machine-independent, which is right for a chart drawn over instants but
 * wrong here: snapping a drag to UTC midnight while the layout keeps measuring the
 * local day would land a dragged bar a day early in every timezone west of UTC.
 * So the arithmetic below stays on the calendar.
 *
 * Two consequences are deliberate and pinned by tests:
 *
 *  · days are shifted with `new Date(y, m, d + n)`, never by adding 24h, so a bar
 *    dragged across a spring-forward keeps the date the pointer was over; and
 *  · a range leaves here as the ISO instant of the local midnight it was dragged
 *    to — the exact instant the axis measured, so the round trip through
 *    `new Date(iso)` → `ganttDay` is exact in any timezone.
 *
 * Everything is DB-free, DOM-free and clock-free; callers pass the axis bounds in.
 */

/** A local-midnight instant, in epoch milliseconds. */
export type GanttDay = number;
/** An inclusive `start` / exclusive `end` range of local days. */
export type GanttDayRange = { start: GanttDay; end: GanttDay };
/** The window a drag may not leave, in local days. */
export type GanttDayBounds = { min: GanttDay; max: GanttDay };
/** Which part of a range a drag grabs. */
export type GanttDragEdge = "move" | "start" | "end";

/** The shortest a range may become — one day; never an inverted range. */
export const GANTT_MIN_DAYS = 1;
/** Pointer travel, in pixels, before a press counts as a drag rather than a click. */
export const GANTT_DRAG_THRESHOLD_PX = 3;

/** Local midnight of a date-ish value, or `null` when it is missing/unparseable. */
export function ganttDay(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * A stable whole-day number for a local day. Derived from the local Y/M/D rather
 * than from `ms / MS_PER_DAY`, so the 23- and 25-hour days either side of a DST
 * change still map to distinct, consecutive numbers (that is what the slider
 * values are expressed in).
 */
export function dayNumber(day: GanttDay): number {
  const date = new Date(day);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: GanttDay, to: GanttDay): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * Shift a local day by whole days, through the calendar rather than by adding
 * 24 hours, so a drag over a DST boundary keeps the date under the pointer. The
 * result is that day's local midnight, so a mid-day instant normalises too.
 */
export function shiftDays(day: GanttDay, days: number): GanttDay {
  if (!Number.isFinite(day)) return day;
  const step = Number.isFinite(days) ? Math.round(days) : 0;
  const date = new Date(day);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + step).getTime();
}

/** Whole days a horizontal pointer delta covers, rounded to the nearest day. */
export function daysForPixels(deltaPx: number, pxPerDay: number): number {
  if (!Number.isFinite(deltaPx) || !Number.isFinite(pxPerDay) || pxPerDay <= 0) return 0;
  return Math.round(deltaPx / pxPerDay);
}

/** Clamp into `[lo, hi]`, tolerating an inverted `hi < lo` (pins to `lo`). */
function clampValue(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/** The range's length in whole days — always at least {@link GANTT_MIN_DAYS}. */
function rangeDays(range: GanttDayRange): number {
  return Math.max(GANTT_MIN_DAYS, daysBetween(range.start, range.end));
}

/** Move a range so its start sits at `start`, keeping its length, inside bounds. */
function moveToStart(
  range: GanttDayRange,
  start: GanttDay,
  bounds: GanttDayBounds,
): GanttDayRange {
  const days = rangeDays(range);
  const pinned = clampValue(start, bounds.min, shiftDays(bounds.max, -days));
  return { start: pinned, end: shiftDays(pinned, days) };
}

/** Move a whole range by whole days, clamped to the chart bounds. */
export function moveByDays(
  range: GanttDayRange,
  days: number,
  bounds: GanttDayBounds,
): GanttDayRange {
  return moveToStart(range, shiftDays(range.start, days), bounds);
}

/** Move a whole range by a pointer delta. */
export function moveByPixels(
  range: GanttDayRange,
  deltaPx: number,
  pxPerDay: number,
  bounds: GanttDayBounds,
): GanttDayRange {
  return moveByDays(range, daysForPixels(deltaPx, pxPerDay), bounds);
}

/**
 * Put one edge on `value`, clamped so the range never inverts (the moving edge
 * stops {@link GANTT_MIN_DAYS} short of its partner) and never leaves the bounds.
 */
export function resizeEdgeTo(
  range: GanttDayRange,
  edge: Exclude<GanttDragEdge, "move">,
  value: GanttDay,
  bounds: GanttDayBounds,
): GanttDayRange {
  if (edge === "start") {
    const latest = shiftDays(range.end, -GANTT_MIN_DAYS);
    return {
      start: clampValue(value, bounds.min, Math.min(latest, range.end)),
      end: range.end,
    };
  }
  const earliest = shiftDays(range.start, GANTT_MIN_DAYS);
  return {
    start: range.start,
    end: clampValue(value, Math.max(earliest, range.start), bounds.max),
  };
}

/** Drag one edge by whole days. */
export function resizeEdgeByDays(
  range: GanttDayRange,
  edge: Exclude<GanttDragEdge, "move">,
  days: number,
  bounds: GanttDayBounds,
): GanttDayRange {
  const base = edge === "start" ? range.start : range.end;
  return resizeEdgeTo(range, edge, shiftDays(base, days), bounds);
}

/** Drag one edge by a pointer delta. */
export function resizeEdgeByPixels(
  range: GanttDayRange,
  edge: Exclude<GanttDragEdge, "move">,
  deltaPx: number,
  pxPerDay: number,
  bounds: GanttDayBounds,
): GanttDayRange {
  return resizeEdgeByDays(range, edge, daysForPixels(deltaPx, pxPerDay), bounds);
}

/** Apply a drag to one edge, or move the whole range when `edge` is `"move"`. */
export function applyDrag(
  range: GanttDayRange,
  edge: GanttDragEdge,
  deltaPx: number,
  pxPerDay: number,
  bounds: GanttDayBounds,
): GanttDayRange {
  return edge === "move"
    ? moveByPixels(range, deltaPx, pxPerDay, bounds)
    : resizeEdgeByPixels(range, edge, deltaPx, pxPerDay, bounds);
}

/**
 * Pin a whole range flush against a bound: `"min"` puts its left edge there,
 * `"max"` its right edge. The range keeps its length, so this never squeezes it.
 */
export function moveToBound(
  range: GanttDayRange,
  side: "min" | "max",
  bounds: GanttDayBounds,
): GanttDayRange {
  const start = side === "min" ? bounds.min : shiftDays(bounds.max, -rangeDays(range));
  return moveToStart(range, start, bounds);
}

/** Pin one edge flush against a bound, clamped so the range never inverts. */
export function resizeToBound(
  range: GanttDayRange,
  edge: Exclude<GanttDragEdge, "move">,
  side: "min" | "max",
  bounds: GanttDayBounds,
): GanttDayRange {
  return resizeEdgeTo(range, edge, side === "min" ? bounds.min : bounds.max, bounds);
}

/**
 * The ISO instants a dragged range writes. They are the local midnights the axis
 * measured, so the server's `new Date(iso)` stores exactly what was dragged and
 * the next render puts the bar back where it was dropped — in any timezone.
 */
export function rangeToInstants(range: GanttDayRange): { start: string; due: string } {
  return { start: new Date(range.start).toISOString(), due: new Date(range.end).toISOString() };
}

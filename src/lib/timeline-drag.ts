/**
 * Timeline / gantt drag maths.
 *
 * The pure half of "move timeline items" and "resize durations" (docs/specs
 * database-deep): given a bar's `[start, end)` epoch-ms range, a pointer delta in
 * pixels and the pixels-per-unit scale, work out the range the bar should show.
 * Everything here is DB-free, DOM-free and clock-free, so the arithmetic is
 * pinned by node tests instead of by watching the screen.
 *
 * Units are **UTC days or weeks** (matching `@/lib/calendar-multiday`): a day
 * snaps to UTC midnight and a week to the Sunday that starts it, so the result
 * is identical on any machine and clock. `start` is inclusive and `end` is
 * exclusive, exactly like `@/lib/timeline` and `timelineData`.
 *
 * Two invariants are enforced here rather than left to the caller:
 *  · a range is never shorter than {@link MIN_DURATION_MS} (dragging an edge
 *    past its partner clamps instead of producing a negative duration), and
 *  · a drag never leaves the chart's `[min, max]` date bounds.
 */

import { MS_PER_DAY } from "@/lib/calendar-multiday";

/** The snap scale a drag works on. */
export type TimelineDragUnit = "day" | "week";

/** Which edge of a range a resize grabs. */
export type DragEdge = "start" | "end";

/** A bar's inclusive-start / exclusive-end span, in epoch milliseconds. */
export type DragRange = { start: number; end: number };

/** The chart's allowed date window, in epoch milliseconds (inclusive). */
export type DragBounds = { min: number; max: number };

/** Milliseconds in one UTC day. */
export const DAY_MS = MS_PER_DAY;
/** Milliseconds in one week. */
export const WEEK_MS = MS_PER_DAY * 7;
/** The shortest a range may become — one day; never a negative duration. */
export const MIN_DURATION_MS = MS_PER_DAY;

/** Milliseconds per unit. */
export function unitMs(unit: TimelineDragUnit): number {
  return unit === "week" ? WEEK_MS : DAY_MS;
}

/**
 * Snap an epoch-ms instant down to the start of its unit: UTC midnight for a
 * `day`, the Sunday that starts the week for a `week`. A non-finite input is
 * returned unchanged so a bad delta can never poison a date.
 */
export function snapToUnit(date: number, unit: TimelineDragUnit): number {
  if (!Number.isFinite(date)) return date;
  const day = Math.floor(date / DAY_MS) * DAY_MS;
  if (unit !== "week") return day;
  const weekday = new Date(day).getUTCDay();
  return day - weekday * DAY_MS;
}

/** A pixel delta snapped to a whole number of units, in ms. */
export function snappedDeltaMs(
  deltaPx: number,
  pxPerUnit: number,
  unit: TimelineDragUnit,
): number {
  if (!Number.isFinite(deltaPx) || !Number.isFinite(pxPerUnit) || pxPerUnit <= 0) {
    return 0;
  }
  return Math.round(deltaPx / pxPerUnit) * unitMs(unit);
}

/** Clamp `value` into `[lo, hi]`, tolerating an inverted `hi < lo` (pins to lo). */
function clampValue(value: number, lo: number, hi: number): number {
  const high = Math.max(lo, hi);
  return Math.min(Math.max(value, lo), high);
}

/** Shift a range so its start sits at `start`, preserving its duration, in bounds. */
function moveToStart(range: DragRange, start: number, bounds: DragBounds): DragRange {
  const duration = Math.max(0, range.end - range.start);
  const clamped = clampValue(start, bounds.min, bounds.max - duration);
  return { start: clamped, end: clamped + duration };
}

/** Move a range by a whole number of units, clamped to the chart bounds. */
export function moveByUnits(
  range: DragRange,
  units: number,
  unit: TimelineDragUnit,
  bounds: DragBounds,
): DragRange {
  const delta = Number.isFinite(units) ? Math.round(units) * unitMs(unit) : 0;
  return moveToStart(range, snapToUnit(range.start + delta, unit), bounds);
}

/**
 * Move a range from a pointer delta: the pixels are rounded to the nearest whole
 * unit, never a partial day, so a bar lands on the scale's grid.
 */
export function moveRange(
  range: DragRange,
  deltaPx: number,
  pxPerUnit: number,
  bounds: DragBounds,
  unit: TimelineDragUnit = "day",
): DragRange {
  const delta = snappedDeltaMs(deltaPx, pxPerUnit, unit);
  return moveToStart(range, snapToUnit(range.start + delta, unit), bounds);
}

/** Move a range flush against a bound: `start` pins its left edge, `end` its right. */
export function moveToBounds(
  range: DragRange,
  edge: DragEdge,
  bounds: DragBounds,
): DragRange {
  const duration = Math.max(0, range.end - range.start);
  const start = edge === "start" ? bounds.min : bounds.max - duration;
  return moveToStart(range, start, bounds);
}

/**
 * Resize one edge to an exact `value`, clamped so the range never inverts (the
 * moving edge stops {@link MIN_DURATION_MS} short of its partner) and never
 * leaves the chart bounds.
 */
export function resizeToValue(
  range: DragRange,
  edge: DragEdge,
  value: number,
  bounds: DragBounds,
): DragRange {
  if (edge === "start") {
    const start = Math.min(
      clampValue(value, bounds.min, range.end - MIN_DURATION_MS),
      range.end,
    );
    return { start, end: range.end };
  }
  const end = Math.max(
    clampValue(value, range.start + MIN_DURATION_MS, bounds.max),
    range.start,
  );
  return { start: range.start, end };
}

/** Resize one edge from a pointer delta, snapping the new edge onto the unit grid. */
export function resizeRange(
  range: DragRange,
  edge: DragEdge,
  deltaPx: number,
  pxPerUnit: number,
  bounds: DragBounds,
  unit: TimelineDragUnit = "day",
): DragRange {
  const delta = snappedDeltaMs(deltaPx, pxPerUnit, unit);
  const base = edge === "start" ? range.start : range.end;
  return resizeToValue(range, edge, snapToUnit(base + delta, unit), bounds);
}

/** Resize one edge by a whole number of units (keyboard: one unit per arrow). */
export function resizeByUnits(
  range: DragRange,
  edge: DragEdge,
  units: number,
  unit: TimelineDragUnit,
  bounds: DragBounds,
): DragRange {
  const delta = Number.isFinite(units) ? Math.round(units) * unitMs(unit) : 0;
  const base = edge === "start" ? range.start : range.end;
  return resizeToValue(range, edge, snapToUnit(base + delta, unit), bounds);
}

/** Resize one edge flush against a bound (`min` or `max`), clamped for inversion. */
export function resizeToBounds(
  range: DragRange,
  edge: DragEdge,
  side: "min" | "max",
  bounds: DragBounds,
): DragRange {
  return resizeToValue(range, edge, side === "min" ? bounds.min : bounds.max, bounds);
}

/** The date-only `{ start, end }` a DATE cell stores, from a dragged range. */
export function rangeToDateValue(range: DragRange): { start: string; end: string } {
  return { start: isoDay(range.start), end: isoDay(range.end) };
}

/** UTC `YYYY-MM-DD` for an epoch-ms instant. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The `offsetPct`/`widthPct` a bar is laid out at, mirroring `timelineData`
 * exactly: offset clamps at 0, width floors at 2% and caps at 100% so a bar can
 * always be seen and grabbed.
 */
export function rangeToPercent(
  range: DragRange,
  fromMs: number,
  toMs: number,
): { offsetPct: number; widthPct: number } {
  const span = Math.max(1, toMs - fromMs);
  const offset = Math.max(0, range.start - fromMs);
  const width = Math.max(MIN_DURATION_MS, range.end - range.start);
  return {
    offsetPct: Math.min(100, (offset / span) * 100),
    widthPct: Math.max(2, Math.min(100, (width / span) * 100)),
  };
}

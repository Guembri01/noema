import { describe, expect, it } from "vitest";
import { MS_PER_DAY } from "@/lib/calendar-multiday";
import {
  DAY_MS,
  MIN_DURATION_MS,
  WEEK_MS,
  moveByUnits,
  moveRange,
  moveToBounds,
  rangeToDateValue,
  rangeToPercent,
  resizeByUnits,
  resizeRange,
  resizeToBounds,
  resizeToValue,
  snapToUnit,
  snappedDeltaMs,
  unitMs,
  type DragBounds,
  type DragRange,
} from "./timeline-drag";

/**
 * Pure drag maths for the timeline/gantt bars. Everything is expressed in
 * UTC day indices off a fixed Sunday (`2026-03-01`) so a day/week snap is
 * obvious and the arithmetic never depends on the machine's timezone.
 */
const BASE = Date.UTC(2026, 2, 1); // Sunday 2026-03-01
const d = (days: number): number => BASE + days * MS_PER_DAY;
const range = (start: number, end: number): DragRange => ({ start: d(start), end: d(end) });
const bounds: DragBounds = { min: d(0), max: d(40) };

describe("timeline drag units", () => {
  it("exposes day and week lengths", () => {
    expect(DAY_MS).toBe(MS_PER_DAY);
    expect(WEEK_MS).toBe(MS_PER_DAY * 7);
    expect(MIN_DURATION_MS).toBe(MS_PER_DAY);
    expect(unitMs("day")).toBe(DAY_MS);
    expect(unitMs("week")).toBe(WEEK_MS);
  });

  it("snaps to the start of the day/week", () => {
    expect(snapToUnit(d(3) + 5 * 3_600_000, "day")).toBe(d(3));
    expect(snapToUnit(d(3), "day")).toBe(d(3));
    // 2026-03-01 is a Sunday: Wednesday 2026-03-04 snaps back to it.
    expect(snapToUnit(d(3), "week")).toBe(d(0));
    expect(snapToUnit(d(10), "week")).toBe(d(7));
    expect(snapToUnit(d(0), "week")).toBe(d(0));
    // A non-finite instant is passed through untouched.
    expect(snapToUnit(Number.NaN, "day")).toBeNaN();
  });

  it("rounds a pixel delta to whole units", () => {
    expect(snappedDeltaMs(25, 10, "day")).toBe(3 * DAY_MS);
    expect(snappedDeltaMs(-30, 10, "day")).toBe(-3 * DAY_MS);
    expect(snappedDeltaMs(4, 10, "day")).toBe(0);
    expect(snappedDeltaMs(6, 10, "day")).toBe(DAY_MS);
    expect(snappedDeltaMs(20, 10, "week")).toBe(2 * WEEK_MS);
    // A broken scale never moves the bar.
    expect(snappedDeltaMs(100, 0, "day")).toBe(0);
    expect(snappedDeltaMs(Number.NaN, 10, "day")).toBe(0);
  });
});

describe("moveRange", () => {
  it("moves forward and back on the day scale, preserving duration", () => {
    expect(moveRange(range(5, 7), 25, 10, bounds)).toEqual(range(8, 10));
    expect(moveRange(range(5, 7), -30, 10, bounds)).toEqual(range(2, 4));
    // Duration is always preserved.
    const moved = moveRange(range(5, 7), 25, 10, bounds);
    expect(moved.end - moved.start).toBe(2 * DAY_MS);
  });

  it("does nothing until the pointer crosses half a unit (snapping)", () => {
    expect(moveRange(range(5, 7), 4, 10, bounds)).toEqual(range(5, 7));
    expect(moveRange(range(5, 7), 6, 10, bounds)).toEqual(range(6, 8));
  });

  it("moves on the week scale", () => {
    // One whole week on the pixel scale, then snapped back onto the week grid
    // (2026-03-06 → 2026-03-08, the Sunday that starts the moved week).
    expect(moveRange(range(5, 7), 10, 10, bounds, "week")).toEqual(range(7, 9));
  });

  it("clamps so a drag cannot leave the chart bounds", () => {
    // 2-day bar pushed past the right edge stops with its end on the bound.
    expect(moveRange(range(38, 40), 500, 10, bounds)).toEqual(range(38, 40));
    // Pushed past the left edge stops with its start on the bound.
    expect(moveRange(range(1, 3), -500, 10, bounds)).toEqual(range(0, 2));
  });
});

describe("moveByUnits / moveToBounds (keyboard)", () => {
  it("nudges one unit at a time, forwards and back", () => {
    expect(moveByUnits(range(5, 7), 1, "day", bounds)).toEqual(range(6, 8));
    expect(moveByUnits(range(5, 7), -3, "day", bounds)).toEqual(range(2, 4));
    // A week step snaps the moved start onto the Sunday week grid.
    expect(moveByUnits(range(5, 7), 1, "week", bounds)).toEqual(range(7, 9));
    // A fractional/NaN step is treated as zero, never a broken date.
    expect(moveByUnits(range(5, 7), Number.NaN, "day", bounds)).toEqual(range(5, 7));
  });

  it("jumps to a bound with Home/End", () => {
    expect(moveToBounds(range(5, 7), "start", bounds)).toEqual(range(0, 2));
    expect(moveToBounds(range(5, 7), "end", bounds)).toEqual(range(38, 40));
  });
});

describe("resizeRange", () => {
  it("resizes the start edge", () => {
    expect(resizeRange(range(10, 20), "start", 30, 10, bounds)).toEqual(range(13, 20));
    expect(resizeRange(range(10, 20), "start", -30, 10, bounds)).toEqual(range(7, 20));
  });

  it("resizes the end edge", () => {
    expect(resizeRange(range(10, 20), "end", -30, 10, bounds)).toEqual(range(10, 17));
    expect(resizeRange(range(10, 20), "end", 30, 10, bounds)).toEqual(range(10, 23));
  });

  it("clamps an inverted resize instead of producing a negative duration", () => {
    // Dragging the start far past the end stops one day short of it.
    const startPast = resizeRange(range(10, 20), "start", 1000, 10, bounds);
    expect(startPast).toEqual(range(19, 20));
    expect(startPast.end - startPast.start).toBe(MIN_DURATION_MS);
    // Dragging the end far before the start stops one day after it.
    const endBefore = resizeRange(range(10, 20), "end", -1000, 10, bounds);
    expect(endBefore).toEqual(range(10, 11));
    expect(endBefore.end).toBeGreaterThanOrEqual(endBefore.start);
  });

  it("clamps a resize to the chart bounds", () => {
    expect(resizeRange(range(1, 3), "start", -1000, 10, bounds)).toEqual(range(0, 3));
    expect(resizeRange(range(38, 40), "end", 1000, 10, bounds)).toEqual(range(38, 40));
  });
});

describe("resizeByUnits / resizeToBounds (keyboard)", () => {
  it("nudges an edge one unit at a time", () => {
    expect(resizeByUnits(range(10, 20), "start", 1, "day", bounds)).toEqual(range(11, 20));
    expect(resizeByUnits(range(10, 20), "end", -2, "day", bounds)).toEqual(range(10, 18));
    // The moved edge snaps onto the week grid (2026-03-28 → 2026-03-22).
    expect(resizeByUnits(range(10, 20), "end", 1, "week", bounds)).toEqual(range(10, 21));
  });

  it("clamps keyboard inversion", () => {
    const inverted = resizeByUnits(range(10, 11), "start", 5, "day", bounds);
    expect(inverted).toEqual(range(10, 11));
    expect(resizeToValue(range(10, 20), "end", -50, bounds)).toEqual(range(10, 11));
  });

  it("jumps an edge to a bound with Home/End", () => {
    expect(resizeToBounds(range(10, 20), "start", "min", bounds)).toEqual(range(0, 20));
    expect(resizeToBounds(range(10, 20), "start", "max", bounds)).toEqual(range(19, 20));
    expect(resizeToBounds(range(10, 20), "end", "min", bounds)).toEqual(range(10, 11));
    expect(resizeToBounds(range(10, 20), "end", "max", bounds)).toEqual(range(10, 40));
  });
});

describe("range serialisation / layout", () => {
  it("writes the date-only value a DATE cell stores", () => {
    expect(rangeToDateValue(range(8, 10))).toEqual({
      start: "2026-03-09",
      end: "2026-03-11",
    });
  });

  it("maps a range onto the same percentages timelineData uses", () => {
    const from = d(0);
    const to = d(100);
    expect(rangeToPercent(range(0, 10), from, to)).toEqual({
      offsetPct: 0,
      widthPct: 10,
    });
    const late = rangeToPercent(range(50, 60), from, to);
    expect(late.offsetPct).toBe(50);
    expect(late.widthPct).toBe(10);
    // Offset clamps at 0 and a sliver floors at 2% so it stays grabbable.
    expect(rangeToPercent({ start: d(-5), end: d(-4) }, from, to).offsetPct).toBe(0);
    expect(rangeToPercent(range(3, 3), from, to).widthPct).toBe(2);
  });
});

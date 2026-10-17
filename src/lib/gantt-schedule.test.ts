import { describe, expect, it } from "vitest";
import {
  GANTT_DRAG_THRESHOLD_PX,
  GANTT_MIN_DAYS,
  applyDrag,
  dayNumber,
  daysBetween,
  daysForPixels,
  ganttDay,
  moveByDays,
  moveByPixels,
  moveToBound,
  rangeToInstants,
  resizeEdgeByDays,
  resizeEdgeTo,
  resizeToBound,
  shiftDays,
  type GanttDayBounds,
} from "./gantt-schedule";

/**
 * The project Gantt's drag maths. Everything here is asserted in *calendar* terms
 * (local Y/M/D, whole-day differences, the ISO round trip) rather than against
 * fixed epoch numbers, so the suite pins the same behaviour on any machine and in
 * any timezone — including the 23- and 25-hour days a drag can cross.
 */

function day(iso: string): number {
  const value = ganttDay(iso);
  if (value === null) throw new Error(`unparseable test date: ${iso}`);
  return value;
}

/** The local Y/M/D of an instant, as `YYYY-MM-DD`. */
function localDate(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dateOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dateOfMonth}`;
}

describe("ganttDay", () => {
  it("truncates an instant to its local midnight", () => {
    expect(ganttDay("2026-04-05T17:42:11")).toBe(new Date(2026, 3, 5).getTime());
    expect(localDate(day("2026-04-05T23:59:59"))).toBe("2026-04-05");
  });

  it("returns null for missing or unparseable values", () => {
    expect(ganttDay(null)).toBeNull();
    expect(ganttDay(undefined)).toBeNull();
    expect(ganttDay("")).toBeNull();
    expect(ganttDay("not a date")).toBeNull();
  });

  it("is idempotent, so it can normalise a day that is already one", () => {
    expect(ganttDay(day("2026-04-05"))).toBe(day("2026-04-05"));
  });
});

describe("shiftDays", () => {
  it("walks the calendar rather than adding 24 hours", () => {
    expect(localDate(shiftDays(day("2026-01-31"), 30))).toBe("2026-03-02");
    expect(localDate(shiftDays(day("2026-12-31"), 1))).toBe("2027-01-01");
    expect(localDate(shiftDays(day("2026-01-01"), -1))).toBe("2025-12-31");
  });

  it("normalises to local midnight, so a mid-day instant still yields a day", () => {
    const nine = new Date(2026, 5, 10, 9, 30).getTime();
    expect(shiftDays(nine, 3)).toBe(new Date(2026, 5, 13).getTime());
  });

  it("rounds fractional and rejects non-finite day counts", () => {
    expect(localDate(shiftDays(day("2026-04-05"), 1.6))).toBe("2026-04-07");
    expect(shiftDays(day("2026-04-05"), Number.NaN)).toBe(day("2026-04-05"));
    expect(shiftDays(Number.NaN, 3)).toBe(Number.NaN);
  });

  it("keeps the calendar difference across a DST change", () => {
    // Asserted through `daysBetween`, which counts local calendar days: adding
    // 24h per day would drift here wherever DST is observed.
    const across = day("2026-03-27");
    expect(daysBetween(across, shiftDays(across, 5))).toBe(5);
    expect(daysBetween(day("2026-10-23"), shiftDays(day("2026-10-23"), 5))).toBe(5);
  });
});

describe("day numbers and differences", () => {
  it("counts whole calendar days, not 24-hour blocks", () => {
    expect(daysBetween(day("2026-03-01"), day("2026-04-01"))).toBe(31);
    expect(daysBetween(day("2026-04-01"), day("2026-03-01"))).toBe(-31);
    expect(daysBetween(day("2026-04-01"), day("2026-04-01"))).toBe(0);
  });

  it("numbers consecutive days consecutively", () => {
    const first = day("2026-03-27");
    expect(dayNumber(shiftDays(first, 1))).toBe(dayNumber(first) + 1);
    expect(dayNumber(shiftDays(first, 3))).toBe(dayNumber(first) + 3);
  });
});

describe("daysForPixels", () => {
  it("rounds a pointer delta to whole days", () => {
    expect(daysForPixels(63, 31.6)).toBe(2);
    expect(daysForPixels(-63, 31.6)).toBe(-2);
    expect(daysForPixels(10, 31.6)).toBe(0);
  });

  it("refuses a degenerate scale instead of dividing by zero", () => {
    expect(daysForPixels(50, 0)).toBe(0);
    expect(daysForPixels(Number.NaN, 30)).toBe(0);
    expect(daysForPixels(50, Number.NaN)).toBe(0);
  });
});

describe("moving a range", () => {
  const bounds: GanttDayBounds = { min: day("2026-04-01"), max: day("2026-04-30") };
  const range = { start: day("2026-04-10"), end: day("2026-04-15") };

  it("shifts both edges by the dragged days, keeping the length", () => {
    const moved = moveByDays(range, 4, bounds);
    expect(localDate(moved.start)).toBe("2026-04-14");
    expect(localDate(moved.end)).toBe("2026-04-19");
    expect(daysBetween(moved.start, moved.end)).toBe(5);
  });

  it("clamps to the chart bounds without squeezing the range", () => {
    const left = moveByDays(range, -90, bounds);
    expect(left.start).toBe(bounds.min);
    expect(daysBetween(left.start, left.end)).toBe(5);

    const right = moveByDays(range, 90, bounds);
    expect(right.end).toBe(bounds.max);
    expect(daysBetween(right.start, right.end)).toBe(5);
  });

  it("moves by pixels through the same path", () => {
    expect(moveByPixels(range, 158, 31.6, bounds)).toEqual(moveByDays(range, 5, bounds));
  });

  it("never inverts a zero-length range", () => {
    const point = { start: day("2026-04-10"), end: day("2026-04-10") };
    const moved = moveByDays(point, 2, bounds);
    expect(daysBetween(moved.start, moved.end)).toBe(GANTT_MIN_DAYS);
  });
});

describe("resizing one edge", () => {
  const bounds: GanttDayBounds = { min: day("2026-04-01"), max: day("2026-04-30") };
  const range = { start: day("2026-04-10"), end: day("2026-04-15") };

  it("moves only the grabbed edge", () => {
    const start = resizeEdgeByDays(range, "start", -3, bounds);
    expect(localDate(start.start)).toBe("2026-04-07");
    expect(start.end).toBe(range.end);

    const end = resizeEdgeByDays(range, "end", 3, bounds);
    expect(end.start).toBe(range.start);
    expect(localDate(end.end)).toBe("2026-04-18");
  });

  it("stops the moving edge a day short of its partner", () => {
    const squeezed = resizeEdgeByDays(range, "start", 99, bounds);
    expect(daysBetween(squeezed.start, squeezed.end)).toBe(GANTT_MIN_DAYS);

    const other = resizeEdgeByDays(range, "end", -99, bounds);
    expect(daysBetween(other.start, other.end)).toBe(GANTT_MIN_DAYS);
    expect(resizeEdgeTo(range, "start", range.end, bounds).start).toBe(
      shiftDays(range.end, -GANTT_MIN_DAYS),
    );
  });

  it("clamps the grabbed edge to the bounds", () => {
    expect(resizeEdgeByDays(range, "start", -99, bounds).start).toBe(bounds.min);
    expect(resizeEdgeByDays(range, "end", 99, bounds).end).toBe(bounds.max);
  });
});

describe("applyDrag", () => {
  const bounds: GanttDayBounds = { min: day("2026-04-01"), max: day("2026-04-30") };
  const range = { start: day("2026-04-10"), end: day("2026-04-15") };

  it("routes a move and an edge drag to the right maths", () => {
    expect(applyDrag(range, "move", 63, 31.6, bounds)).toEqual(
      moveByPixels(range, 63, 31.6, bounds),
    );
    expect(applyDrag(range, "end", 63, 31.6, bounds)).toEqual(
      resizeEdgeByDays(range, "end", 2, bounds),
    );
  });
});

describe("pinning to a bound", () => {
  const bounds: GanttDayBounds = { min: day("2026-04-01"), max: day("2026-04-30") };
  const range = { start: day("2026-04-10"), end: day("2026-04-15") };

  it("moves a whole range against either bound without shrinking it", () => {
    const left = moveToBound(range, "min", bounds);
    expect(left.start).toBe(bounds.min);
    expect(daysBetween(left.start, left.end)).toBe(5);

    const right = moveToBound(range, "max", bounds);
    expect(right.end).toBe(bounds.max);
    expect(daysBetween(right.start, right.end)).toBe(5);
  });

  it("pins one edge against either bound, still a day long", () => {
    expect(resizeToBound(range, "start", "min", bounds).start).toBe(bounds.min);
    expect(resizeToBound(range, "end", "max", bounds).end).toBe(bounds.max);
    const collapsed = resizeToBound(range, "start", "max", bounds);
    expect(daysBetween(collapsed.start, collapsed.end)).toBe(GANTT_MIN_DAYS);
  });
});

describe("rangeToInstants", () => {
  it("round-trips: the instant it writes is the local day the axis measured", () => {
    const range = { start: day("2026-04-10"), end: day("2026-04-15") };
    const instants = rangeToInstants(range);

    expect(instants.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The server stores `new Date(iso)` verbatim, so this is the invariant that
    // keeps a dropped bar where it was dropped.
    expect(ganttDay(instants.start)).toBe(range.start);
    expect(ganttDay(instants.due)).toBe(range.end);
    expect(localDate(ganttDay(instants.start) ?? 0)).toBe("2026-04-10");
  });

  it("exports the drag threshold the component shares", () => {
    expect(GANTT_DRAG_THRESHOLD_PX).toBe(3);
  });
});

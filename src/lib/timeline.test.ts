import { describe, expect, it } from "vitest";
import {
  MIN_BAR_FRACTION,
  assignLanes,
  clampToWindow,
  dayKeyFor,
  daysSpanned,
  mergeOverlaps,
  normalizeSpan,
  overlaps,
  positionBars,
  type TimeSpan as TimeEvent,
} from "@/lib/timeline";

/* All times are ms epochs. Timeline tests use small synthetic numbers
   (0..1000 window) so the arithmetic is readable; calendar tests use
   Date.UTC literals — UTC everywhere, so results are independent of the
   machine's timezone and of the current clock. */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ev(start: number, end: number): TimeEvent;
function ev(start: number, end: number, id: string): TimeEvent & { id: string };
function ev(
  start: number,
  end: number,
  id?: string,
): TimeEvent | (TimeEvent & { id: string }) {
  return id === undefined ? { start, end } : { start, end, id };
}

describe("clampToWindow", () => {
  const window = { start: 100, end: 900 };

  it("returns the event untouched when fully inside", () => {
    expect(clampToWindow({ start: 200, end: 400 }, window)).toEqual({
      start: 200,
      end: 400,
    });
  });

  it("clips an event hanging off the left edge", () => {
    expect(clampToWindow({ start: -500, end: 300 }, window)).toEqual({
      start: 100,
      end: 300,
    });
  });

  it("clips an event hanging off the right edge", () => {
    expect(clampToWindow({ start: 700, end: 5000 }, window)).toEqual({
      start: 700,
      end: 900,
    });
  });

  it("spans both edges when the event covers the window", () => {
    expect(clampToWindow({ start: -10, end: 2000 }, window)).toEqual({
      start: 100,
      end: 900,
    });
  });

  it("collapses an event fully before the window to the window start", () => {
    expect(clampToWindow({ start: -800, end: -100 }, window)).toEqual({
      start: 100,
      end: 100,
    });
  });

  it("collapses an event fully after the window to the window end", () => {
    expect(clampToWindow({ start: 1000, end: 4000 }, window)).toEqual({
      start: 900,
      end: 900,
    });
  });
});

describe("normalizeSpan", () => {
  const window = { start: 0, end: 1000 };

  it("maps a fully-inside event to 0..1 fractions", () => {
    const { left, width } = normalizeSpan({ start: 200, end: 400 }, window);
    expect(left).toBeCloseTo(0.2, 10);
    expect(width).toBeCloseTo(0.2, 10);
  });

  it("clips left-hanging events to left = 0", () => {
    const { left, width } = normalizeSpan({ start: -500, end: 200 }, window);
    expect(left).toBe(0);
    expect(width).toBeCloseTo(0.2, 10);
  });

  it("clips right-hanging events against the window edge", () => {
    const { left, width } = normalizeSpan({ start: 800, end: 1500 }, window);
    expect(left).toBeCloseTo(0.8, 10);
    expect(width).toBeCloseTo(0.2, 10);
  });

  it("gives a fully-before event zero width at left = 0", () => {
    expect(normalizeSpan({ start: -1000, end: -100 }, window)).toEqual({
      left: 0,
      width: 0,
    });
  });

  it("gives a fully-after event zero width at left = 1", () => {
    expect(normalizeSpan({ start: 2000, end: 3000 }, window)).toEqual({
      left: 1,
      width: 0,
    });
  });

  it("gives an event merely touching the window edge zero width", () => {
    expect(normalizeSpan({ start: -50, end: 0 }, window)).toEqual({
      left: 0,
      width: 0,
    });
  });

  it("gives an instant event inside the window the minimum width", () => {
    const { left, width } = normalizeSpan({ start: 250, end: 250 }, window);
    expect(left).toBeCloseTo(0.25, 10);
    expect(width).toBe(MIN_BAR_FRACTION);
  });

  it("never exceeds the window: an instant at the right edge stays inside", () => {
    const { left, width } = normalizeSpan({ start: 999, end: 999 }, window);
    expect(left + width).toBeLessThanOrEqual(1 + Number.EPSILON);
    expect(width).toBe(MIN_BAR_FRACTION);
  });

  it("treats an instant at the exact window end as outside", () => {
    expect(normalizeSpan({ start: 1000, end: 1000 }, window)).toEqual({
      left: 1,
      width: 0,
    });
  });

  it("promotes a sliver shorter than the minimum to the minimum width", () => {
    const { width } = normalizeSpan({ start: 100, end: 101 }, window);
    expect(width).toBe(MIN_BAR_FRACTION);
  });

  it("returns a zero span for a degenerate (empty) window", () => {
    expect(normalizeSpan({ start: 200, end: 400 }, { start: 5, end: 5 })).toEqual({
      left: 0,
      width: 0,
    });
    expect(normalizeSpan({ start: 200, end: 400 }, { start: 9, end: 1 })).toEqual({
      left: 0,
      width: 0,
    });
  });
});

describe("positionBars", () => {
  it("keeps input order and pairs each event with its own span", () => {
    const window = { start: 0, end: 1000 };
    const bars = positionBars(
      [
        { start: 800, end: 900, id: "late" },
        { start: -100, end: 100, id: "early" },
        { start: 300, end: 700, id: "mid" },
      ],
      window,
    );
    expect(bars.map((b) => b.event.id)).toEqual(["late", "early", "mid"]);
    expect(bars[0].left).toBeCloseTo(0.8, 10);
    expect(bars[0].width).toBeCloseTo(0.1, 10);
    expect(bars[1].left).toBe(0);
    expect(bars[1].width).toBeCloseTo(0.1, 10);
    expect(bars[2].left).toBeCloseTo(0.3, 10);
    expect(bars[2].width).toBeCloseTo(0.4, 10);
  });

  it("returns an empty list for an empty input", () => {
    expect(positionBars([], { start: 0, end: 1000 })).toEqual([]);
  });
});

describe("overlaps", () => {
  it("is false for disjoint intervals", () => {
    expect(overlaps(ev(0, 10), ev(10, 20))).toBe(false);
    expect(overlaps(ev(0, 10), ev(11, 20))).toBe(false);
  });

  it("is true for intervals sharing interior time", () => {
    expect(overlaps(ev(0, 10), ev(5, 15))).toBe(true);
    expect(overlaps(ev(5, 15), ev(0, 10))).toBe(true);
  });

  it("is true when one interval contains the other", () => {
    expect(overlaps(ev(0, 100), ev(20, 30))).toBe(true);
    expect(overlaps(ev(20, 30), ev(0, 100))).toBe(true);
  });

  it("is false for back-to-back intervals (half-open rule)", () => {
    expect(overlaps(ev(10, 20), ev(0, 10))).toBe(false);
  });

  it("an instant inside an interval overlaps it; at its edge it does not", () => {
    expect(overlaps(ev(5, 5), ev(0, 10))).toBe(true);
    expect(overlaps(ev(0, 10), ev(5, 5))).toBe(true);
    expect(overlaps(ev(0, 0), ev(0, 10))).toBe(false);
    expect(overlaps(ev(10, 10), ev(0, 10))).toBe(false);
  });
});

describe("mergeOverlaps", () => {
  it("returns an empty list for empty input", () => {
    expect(mergeOverlaps([])).toEqual([]);
  });

  it("keeps disjoint intervals separate", () => {
    expect(mergeOverlaps([ev(0, 10), ev(20, 30)])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  it("merges overlapping intervals", () => {
    expect(mergeOverlaps([ev(0, 10), ev(5, 15), ev(12, 20)])).toEqual([
      { start: 0, end: 20 },
    ]);
  });

  it("merges touching intervals (shared edge is continuous coverage)", () => {
    expect(mergeOverlaps([ev(0, 10), ev(10, 20)])).toEqual([{ start: 0, end: 20 }]);
  });

  it("absorbs fully-contained intervals", () => {
    expect(mergeOverlaps([ev(0, 100), ev(20, 30), ev(40, 50)])).toEqual([
      { start: 0, end: 100 },
    ]);
  });

  it("handles unsorted input deterministically", () => {
    expect(mergeOverlaps([ev(30, 40), ev(0, 10), ev(5, 15)])).toEqual([
      { start: 0, end: 15 },
      { start: 30, end: 40 },
    ]);
  });

  it("folds an instant into an interval that contains it", () => {
    expect(mergeOverlaps([ev(0, 10), ev(5, 5)])).toEqual([{ start: 0, end: 10 }]);
  });
});

describe("assignLanes", () => {
  it("returns no lanes for no events", () => {
    expect(assignLanes([])).toEqual({ assignments: [], laneCount: 0 });
  });

  it("puts non-overlapping events in a single lane", () => {
    const { assignments, laneCount } = assignLanes([
      ev(0, 10, "a"),
      ev(10, 20, "b"),
      ev(20, 30, "c"),
    ]);
    expect(laneCount).toBe(1);
    expect(assignments.map((x) => x.lane)).toEqual([0, 0, 0]);
    expect(assignments.map((x) => x.event.id)).toEqual(["a", "b", "c"]);
  });

  it("stacks fully-overlapping events into separate lanes", () => {
    const { assignments, laneCount } = assignLanes([
      ev(0, 30, "a"),
      ev(0, 30, "b"),
      ev(0, 30, "c"),
    ]);
    expect(laneCount).toBe(3);
    expect(assignments.map((x) => x.lane)).toEqual([0, 1, 2]);
  });

  it("reuses lanes after a chain overlap ends (disjoint sets)", () => {
    const { assignments, laneCount } = assignLanes([
      ev(0, 10, "a"),
      ev(5, 15, "b"),
      ev(100, 110, "c"),
    ]);
    expect(laneCount).toBe(2);
    expect(assignments.find((x) => x.event.id === "a")?.lane).toBe(0);
    expect(assignments.find((x) => x.event.id === "b")?.lane).toBe(1);
    expect(assignments.find((x) => x.event.id === "c")?.lane).toBe(0);
  });

  it("keeps the outer event alone in its lane for a nested overlap", () => {
    const { assignments, laneCount } = assignLanes([
      ev(0, 100, "outer"),
      ev(10, 20, "inner1"),
      ev(30, 40, "inner2"),
    ]);
    expect(laneCount).toBe(2);
    expect(assignments.find((x) => x.event.id === "outer")?.lane).toBe(0);
    expect(assignments.find((x) => x.event.id === "inner1")?.lane).toBe(1);
    expect(assignments.find((x) => x.event.id === "inner2")?.lane).toBe(1);
  });

  it("is deterministic regardless of input order (sorts by start, end, id)", () => {
    const events = [ev(10, 20, "b"), ev(0, 8, "a"), ev(5, 15, "c")];
    const shuffled = [events[2], events[0], events[1]];
    const first = assignLanes(events);
    const second = assignLanes(shuffled);
    expect(second).toEqual(first);
    expect(first.assignments.map((x) => x.event.id)).toEqual(["a", "c", "b"]);
    expect(first.assignments.map((x) => x.lane)).toEqual([0, 1, 0]);
    expect(first.laneCount).toBe(2);
  });

  it("gives every event a lane no earlier event overlaps (greedy invariant)", () => {
    const events = [
      ev(0, 10, "a"),
      ev(2, 4, "b"),
      ev(3, 7, "c"),
      ev(6, 12, "d"),
      ev(12, 14, "e"),
    ];
    const { assignments } = assignLanes(events);
    for (const cur of assignments) {
      for (const other of assignments) {
        if (cur.event.id >= other.event.id) continue;
        if (overlaps(cur.event, other.event)) {
          expect(cur.lane).not.toBe(other.lane);
        }
      }
    }
    expect(assignments.find((x) => x.event.id === "e")?.lane).toBe(0);
  });
});

describe("dayKeyFor", () => {
  const jan5 = Date.UTC(2026, 0, 5);

  it("formats a UTC day key at boundary 0", () => {
    expect(dayKeyFor(jan5 + 13 * HOUR, 0)).toBe("2026-01-05");
    expect(dayKeyFor(jan5 + 23 * HOUR + 59 * 60_000, 0)).toBe("2026-01-05");
  });

  it("shifts the day with a non-zero boundary hour", () => {
    // Day "2026-01-05" with boundary 4 runs 04:00 → next 04:00.
    expect(dayKeyFor(jan5 + 3 * HOUR, 4)).toBe("2026-01-04");
    expect(dayKeyFor(jan5 + 4 * HOUR, 4)).toBe("2026-01-05");
    // Jan 6 02:00 is still before the 04:00 boundary → day 2026-01-05;
    // Jan 6 04:00 opens day 2026-01-06.
    expect(dayKeyFor(jan5 + 26 * HOUR, 4)).toBe("2026-01-05");
    expect(dayKeyFor(jan5 + 28 * HOUR, 4)).toBe("2026-01-06");
  });

  it("zero-pads month and day", () => {
    expect(dayKeyFor(Date.UTC(2026, 2, 7), 0)).toBe("2026-03-07");
  });

  it("rejects out-of-range boundary hours", () => {
    expect(() => dayKeyFor(jan5, 24)).toThrow(RangeError);
    expect(() => dayKeyFor(jan5, -1)).toThrow(RangeError);
    expect(() => dayKeyFor(jan5, Number.NaN)).toThrow(RangeError);
  });
});

describe("daysSpanned", () => {
  // 2026-03-05 10:00 UTC → 2026-03-05 20:00 UTC
  const singleDay: TimeEvent = {
    start: Date.UTC(2026, 2, 5, 10),
    end: Date.UTC(2026, 2, 5, 20),
  };
  // 2026-03-05 10:00 → 2026-03-07 12:00 UTC
  const threeDays: TimeEvent = {
    start: Date.UTC(2026, 2, 5, 10),
    end: Date.UTC(2026, 2, 7, 12),
  };

  it("returns the single day for a one-day event", () => {
    expect(daysSpanned(singleDay, 0)).toEqual(["2026-03-05"]);
  });

  it("returns every covered day for a multi-day event, inclusive of the end day", () => {
    expect(daysSpanned(threeDays, 0)).toEqual([
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
    ]);
  });

  it("does not include the day after when the event ends exactly on a boundary", () => {
    const endsAtMidnight: TimeEvent = {
      start: Date.UTC(2026, 2, 5, 10),
      end: Date.UTC(2026, 2, 6, 0),
    };
    expect(daysSpanned(endsAtMidnight, 0)).toEqual(["2026-03-05"]);
    expect(daysSpanned(endsAtMidnight, 4)).toEqual(["2026-03-05"]);
  });

  it("collapses a midnight-crossing event into one day when the boundary says so", () => {
    const crossesMidnight: TimeEvent = {
      start: Date.UTC(2026, 2, 5, 23),
      end: Date.UTC(2026, 2, 6, 1),
    };
    expect(daysSpanned(crossesMidnight, 0)).toEqual(["2026-03-05", "2026-03-06"]);
    // With a 04:00 day boundary both instants sit inside the single day
    // "2026-03-05" (which runs Mar 5 04:00 → Mar 6 04:00).
    expect(daysSpanned(crossesMidnight, 4)).toEqual(["2026-03-05"]);
  });

  it("splits on the boundary hour even within one civil date", () => {
    const earlyMorning: TimeEvent = {
      start: Date.UTC(2026, 2, 5, 3),
      end: Date.UTC(2026, 2, 5, 5),
    };
    expect(daysSpanned(earlyMorning, 0)).toEqual(["2026-03-05"]);
    expect(daysSpanned(earlyMorning, 4)).toEqual(["2026-03-04", "2026-03-05"]);
  });

  it("crosses month boundaries", () => {
    const crossMonth: TimeEvent = {
      start: Date.UTC(2026, 0, 31, 9),
      end: Date.UTC(2026, 1, 2, 18),
    };
    expect(daysSpanned(crossMonth, 0)).toEqual([
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("returns one day for an instant event", () => {
    const instant = Date.UTC(2026, 5, 10, 12);
    expect(daysSpanned({ start: instant, end: instant }, 0)).toEqual(["2026-06-10"]);
  });

  it("rejects out-of-range boundary hours", () => {
    expect(() => daysSpanned(singleDay, 25)).toThrow(RangeError);
    expect(() => daysSpanned(singleDay, -2)).toThrow(RangeError);
  });

  it("refuses absurdly long spans instead of allocating forever", () => {
    const century: TimeEvent = {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2126, 0, 1),
    };
    expect(() => daysSpanned(century, 0)).toThrow(RangeError);
  });
});

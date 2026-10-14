import { describe, expect, it } from "vitest";
import {
  MS_PER_DAY,
  monthGrid,
  placeEvents,
  type CalendarEvent,
} from "@/lib/calendar-multiday";

/* Everything is UTC: literals are built with `Date.UTC` and day math uses
   `MS_PER_DAY`, so no assertion depends on the machine's timezone or clock.
   Month arguments are 0-based (`Date` convention): 1 = February. */

const JAN = 0;
const FEB = 1;
const MAR = 2;
const APR = 3;
const MAY = 4;
const JUN = 5;

/** A half-open `[start, end)` event in ms epochs. */
const ev = (id: string, start: number, end: number): CalendarEvent => ({
  id,
  start,
  end,
});

/** One whole UTC day at midnight, `days` days long (end exclusive). */
const day = (month: number, date: number, days = 1): [number, number] => [
  Date.UTC(2026, month, date),
  Date.UTC(2026, month, date + days),
];

describe("monthGrid - UTC week layout", () => {
  it("lays February 2026 out in four clean weeks from a Sunday", () => {
    const grid = monthGrid(2026, FEB);
    expect(grid.weeks).toHaveLength(4);
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    expect(grid.days).toHaveLength(28);
    expect(grid.days.every((cell) => cell.inMonth)).toBe(true);
    expect(grid.weeks[0][0].key).toBe("2026-02-01");
    expect(grid.weeks[0][0].weekday).toBe(0);
    expect(grid.weeks[3][6].key).toBe("2026-02-28");
    expect(grid.days[0]).toMatchObject({ date: 1, month: FEB, year: 2026 });
    expect(grid.year).toBe(2026);
    expect(grid.month).toBe(FEB);
    expect(grid.weekStartsOn).toBe(0);
  });

  it("pads April 2026 with spill days so every week is whole", () => {
    const grid = monthGrid(2026, APR);
    expect(grid.weeks).toHaveLength(5);
    // April 1 2026 is a Wednesday, so the first row opens the previous Sunday.
    expect(grid.weeks[0][0]).toMatchObject({
      key: "2026-03-29",
      weekday: 0,
      inMonth: false,
    });
    expect(grid.weeks[0][3]).toMatchObject({
      key: "2026-04-01",
      weekday: 3,
      inMonth: true,
    });
    // The last row runs past month-end into May.
    expect(grid.weeks[4][4]).toMatchObject({ key: "2026-04-30", inMonth: true });
    expect(grid.weeks[4][5]).toMatchObject({ key: "2026-05-01", inMonth: false });
    expect(grid.days.filter((cell) => cell.inMonth)).toHaveLength(30);
  });

  it("honours weekStartsOn = 1 (Monday)", () => {
    const grid = monthGrid(2026, MAR, { weekStartsOn: 1 });
    expect(grid.weeks).toHaveLength(6);
    expect(grid.weeks[0][0]).toMatchObject({
      key: "2026-02-23",
      weekday: 1,
      inMonth: false,
    });
    // March 1 2026 is a Sunday, so it closes the first row.
    expect(grid.weeks[0][6]).toMatchObject({
      key: "2026-03-01",
      weekday: 0,
      inMonth: true,
    });
    expect(grid.weeks[5][1]).toMatchObject({ key: "2026-03-31", inMonth: true });
  });

  it("honours weekStartsOn = 6 (Saturday)", () => {
    const grid = monthGrid(2026, MAR, { weekStartsOn: 6 });
    expect(grid.weeks).toHaveLength(5);
    expect(grid.weeks[0][0]).toMatchObject({ key: "2026-02-28", weekday: 6 });
    expect(grid.weeks[0][1]).toMatchObject({ key: "2026-03-01", weekday: 0 });
  });

  it("never produces a short week for a month starting mid-week in December", () => {
    // December 2026 starts on a Tuesday; the final row stays whole.
    const grid = monthGrid(2026, 11);
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    expect(grid.days).toHaveLength(grid.weeks.length * 7);
    expect(grid.days.filter((cell) => cell.inMonth)).toHaveLength(31);
  });

  it("rejects malformed inputs", () => {
    expect(() => monthGrid(2026, 12)).toThrow(RangeError);
    expect(() => monthGrid(2026, -1)).toThrow(RangeError);
    expect(() => monthGrid(2026, 1.5)).toThrow(RangeError);
    expect(() => monthGrid(2026.5, FEB)).toThrow(RangeError);
    expect(() => monthGrid(2026, FEB, { weekStartsOn: 7 })).toThrow(RangeError);
    expect(() => monthGrid(2026, FEB, { weekStartsOn: -1 })).toThrow(RangeError);
  });
});

describe("placeEvents - single and multi-day bars", () => {
  const feb = monthGrid(2026, FEB); // week 0: Feb 1-7, week 1: Feb 8-14, ...

  it("places a single-day event in its column at lane 0", () => {
    const layout = placeEvents(feb, [ev("one", ...(day(FEB, 10) as [number, number]))]);
    const week = layout.weeks[1];
    expect(week.placements).toHaveLength(1);
    expect(week.placements[0]).toMatchObject({
      lane: 0,
      startCol: 2,
      span: 1,
      continuesBefore: false,
      continuesAfter: false,
    });
    expect(week.placements[0].event.id).toBe("one");
    expect(week.laneCount).toBe(1);
  });

  it("spans a multi-day event across consecutive columns of one week", () => {
    const layout = placeEvents(feb, [ev("trip", ...(day(FEB, 9, 3) as [number, number]))]);
    const placement = layout.weeks[1].placements[0];
    expect(placement).toMatchObject({ startCol: 1, span: 3, lane: 0 });
  });

  it("treats end as exclusive: a midnight end does not spill to the next day", () => {
    const noon = Date.UTC(2026, FEB, 9);
    const layout = placeEvents(feb, [ev("half", noon, Date.UTC(2026, FEB, 10))]);
    expect(layout.weeks[1].placements[0].span).toBe(1);
  });

  it("treats an instant (start === end) as one day", () => {
    const instant = Date.UTC(2026, FEB, 10, 12);
    const layout = placeEvents(feb, [ev("now", instant, instant)]);
    expect(layout.weeks[1].placements[0].span).toBe(1);
    expect(layout.weeks[1].placements[0].startCol).toBe(2);
  });

  it("clips a week-crossing event with continues flags on both rows", () => {
    const layout = placeEvents(feb, [ev("long", ...(day(FEB, 5, 8) as [number, number]))]);
    // Week 0 (Feb 1-7): Feb 5, 6, 7 shown, bar continues right.
    expect(layout.weeks[0].placements[0]).toMatchObject({
      startCol: 4,
      span: 3,
      continuesBefore: false,
      continuesAfter: true,
    });
    // Week 1 (Feb 8-14): Feb 8-12 shown, bar continues from the left.
    expect(layout.weeks[1].placements[0]).toMatchObject({
      startCol: 0,
      span: 5,
      continuesBefore: true,
      continuesAfter: false,
    });
    expect(layout.weeks[2].placements).toHaveLength(0);
  });

  it("flags an event covering an entire week as continuing on both sides", () => {
    const layout = placeEvents(feb, [ev("all", Date.UTC(2026, JAN, 25), Date.UTC(2026, MAR, 5))]);
    expect(layout.weeks[1].placements[0]).toMatchObject({
      startCol: 0,
      span: 7,
      continuesBefore: true,
      continuesAfter: true,
    });
  });

  it("ignores events entirely outside the grid", () => {
    const layout = placeEvents(feb, [ev("june", ...(day(JUN, 10) as [number, number]))]);
    expect(layout.weeks.every((week) => week.placements.length === 0)).toBe(true);
    expect(layout.weeks.every((week) => week.laneCount === 0)).toBe(true);
    expect(layout.hiddenCount).toBe(0);
  });

  it("echoes the grid metadata", () => {
    const layout = placeEvents(feb, []);
    expect(layout).toMatchObject({ year: 2026, month: FEB, weekStartsOn: 0 });
    expect(layout.weeks).toHaveLength(feb.weeks.length);
  });
});

describe("placeEvents - lane packing", () => {
  const feb = monthGrid(2026, FEB);

  it("stacks overlapping events into separate lanes", () => {
    const layout = placeEvents(feb, [
      ev("a", Date.UTC(2026, FEB, 10, 0), Date.UTC(2026, FEB, 11, 0)),
      ev("b", Date.UTC(2026, FEB, 10, 9), Date.UTC(2026, FEB, 10, 18)),
      ev("c", Date.UTC(2026, FEB, 10, 12), Date.UTC(2026, FEB, 11, 9)),
    ]);
    const week = layout.weeks[1];
    expect(week.placements.map((p) => p.event.id)).toEqual(["a", "b", "c"]);
    expect(week.placements.map((p) => p.lane)).toEqual([0, 1, 2]);
    expect(week.laneCount).toBe(3);
  });

  it("reuses a lane for back-to-back events (half-open day ranges)", () => {
    const layout = placeEvents(feb, [
      ev("tue", ...(day(FEB, 10) as [number, number])),
      ev("wed", ...(day(FEB, 11) as [number, number])),
    ]);
    expect(layout.weeks[1].placements.map((p) => p.lane)).toEqual([0, 0]);
    expect(layout.weeks[1].laneCount).toBe(1);
  });

  it("is deterministic regardless of input order (start, end, id)", () => {
    const events = [
      ev("b", ...(day(FEB, 10) as [number, number])),
      ev("a", ...(day(FEB, 8) as [number, number])),
      ev("c", ...(day(FEB, 12) as [number, number])),
    ];
    const first = placeEvents(feb, events);
    const second = placeEvents(feb, [...events].reverse());
    expect(second).toEqual(first);
    expect(first.weeks[1].placements.map((p) => p.event.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the events array or the grid", () => {
    const events = [
      ev("x", ...(day(FEB, 10) as [number, number])),
      ev("y", ...(day(FEB, 11) as [number, number])),
    ];
    const snapshot = events.map((event) => ({ ...event }));
    const dayCount = feb.days.length;
    placeEvents(feb, events);
    expect(events).toEqual(snapshot);
    expect(feb.days).toHaveLength(dayCount);
  });

  it("keeps the caller's payload on the placement (generic events)", () => {
    const [start, end] = day(FEB, 10);
    const layout = placeEvents(feb, [{ id: "x", start, end, title: "Standup" }]);
    expect(layout.weeks[1].placements[0].event.title).toBe("Standup");
  });

  it("orders placements by start within a week", () => {
    const layout = placeEvents(feb, [
      ev("late", ...(day(FEB, 13) as [number, number])),
      ev("early", ...(day(FEB, 9) as [number, number])),
    ]);
    expect(layout.weeks[1].placements.map((p) => p.event.id)).toEqual(["early", "late"]);
  });
});

describe("placeEvents - maxLanes overflow", () => {
  const feb = monthGrid(2026, FEB);

  it("drops bars past maxLanes and counts them as hidden", () => {
    const layout = placeEvents(
      feb,
      [
        ev("a", Date.UTC(2026, FEB, 10, 8), Date.UTC(2026, FEB, 10, 9)),
        ev("b", Date.UTC(2026, FEB, 10, 9), Date.UTC(2026, FEB, 10, 10)),
        ev("c", Date.UTC(2026, FEB, 10, 10), Date.UTC(2026, FEB, 10, 11)),
      ],
      { maxLanes: 2 },
    );
    const week = layout.weeks[1];
    expect(week.placements.map((p) => p.event.id)).toEqual(["a", "b"]);
    expect(week.placements.map((p) => p.lane)).toEqual([0, 1]);
    expect(week.laneCount).toBe(2);
    expect(week.hiddenCount).toBe(1);
    expect(layout.hiddenCount).toBe(1);
  });

  it("hides everything with maxLanes = 0", () => {
    const layout = placeEvents(
      feb,
      [
        ev("a", ...(day(FEB, 10) as [number, number])),
        ev("b", ...(day(FEB, 11) as [number, number])),
      ],
      { maxLanes: 0 },
    );
    expect(layout.weeks[1].placements).toHaveLength(0);
    expect(layout.weeks[1].laneCount).toBe(0);
    // Both fit in lane 0 (back-to-back) but no lane is available at all.
    expect(layout.weeks[1].hiddenCount).toBe(2);
  });

  it("sums hidden counts across week rows", () => {
    const layout = placeEvents(
      feb,
      [
        ev("spine", Date.UTC(2026, JAN, 1), Date.UTC(2026, MAR, 1)),
        ev("cover", Date.UTC(2026, FEB, 3), Date.UTC(2026, FEB, 15)),
      ],
      { maxLanes: 1 },
    );
    expect(layout.weeks.map((week) => week.hiddenCount)).toEqual([1, 1, 0, 0]);
    expect(layout.hiddenCount).toBe(2);
  });

  it("rejects malformed maxLanes", () => {
    expect(() => placeEvents(feb, [], { maxLanes: -1 })).toThrow(RangeError);
    expect(() => placeEvents(feb, [], { maxLanes: 1.5 })).toThrow(RangeError);
  });

  it("does not count out-of-grid events as hidden", () => {
    const layout = placeEvents(
      feb,
      [ev("june", ...(day(JUN, 10) as [number, number]))],
      { maxLanes: 0 },
    );
    expect(layout.hiddenCount).toBe(0);
  });
});

describe("MS_PER_DAY", () => {
  it("is exactly one UTC day", () => {
    expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
  });
});

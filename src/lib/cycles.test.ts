import { describe, expect, it } from "vitest";
import {
  activeCycle,
  addedMidCycle,
  burndownSeries,
  cycleDays,
  cycleProgress,
  scopeChange,
  ticketsInCycle,
  velocity,
  type Cycle,
} from "./cycles";

const ticket = (overrides: Partial<Parameters<typeof cycleProgress>[0][number]> = {}) => ({
  id: overrides.id ?? "t1",
  key: overrides.key ?? "NOE-1",
  title: overrides.title ?? "Ticket",
  status: overrides.status ?? "todo",
  priority: overrides.priority ?? "none",
  type: overrides.type ?? "task",
  estimate: overrides.estimate ?? null,
  estimateUnit: overrides.estimateUnit ?? "points",
  startDate: overrides.startDate ?? null,
  dueDate: overrides.dueDate ?? null,
  completedAt: overrides.completedAt ?? null,
  updatedAt: overrides.updatedAt ?? null,
  createdAt: overrides.createdAt ?? null,
});

const cycle = {
  id: "c1",
  name: "Sprint 1",
  startDate: "2026-03-01T00:00:00.000Z",
  endDate: "2026-03-10T00:00:00.000Z",
};

describe("cycleDays", () => {
  it("counts inclusive days and never returns zero", () => {
    expect(cycleDays(cycle)).toBe(10);
    expect(cycleDays({ ...cycle, endDate: cycle.startDate })).toBe(1);
  });
});

describe("activeCycle", () => {
  const previous = { id: "p", name: "Sprint 0", startDate: "2026-02-01", endDate: "2026-02-10" };
  const next = { id: "n", name: "Sprint 2", startDate: "2026-04-01", endDate: "2026-04-10" };

  it("returns the cycle containing today", () => {
    expect(activeCycle([previous, cycle, next], new Date("2026-03-05"))?.id).toBe("c1");
  });

  it("falls forward to the next cycle when none is running", () => {
    expect(activeCycle([previous, cycle, next], new Date("2026-03-20"))?.id).toBe("n");
  });

  it("returns null when nothing is scheduled", () => {
    expect(activeCycle([], new Date("2026-03-05"))).toBeNull();
  });
});

describe("cycleProgress", () => {
  const tickets = [
    ticket({ id: "a", estimate: 5, status: "done", completedAt: "2026-03-03T00:00:00.000Z" }),
    ticket({ id: "b", estimate: 3, status: "in_progress" }),
    ticket({ id: "c", estimate: 2, status: "todo" }),
  ];

  it("reports committed, completed and remaining effort", () => {
    const progress = cycleProgress(tickets, cycle, new Date("2026-03-05"));
    expect(progress.committed).toBe(10);
    expect(progress.completed).toBe(5);
    expect(progress.remaining).toBe(5);
    expect(progress.percent).toBe(50);
    expect(progress.days).toBe(10);
    expect(progress.daysElapsed).toBe(5);
    expect(progress.daysLeft).toBe(5);
  });

  it("builds a burndown that drops when work closes and stays null in the future", () => {
    const { burndown } = cycleProgress(tickets, cycle, new Date("2026-03-05"));
    expect(burndown).toHaveLength(10);
    // Ticket "a" closed on 3 Mar, which is day 3 of a cycle starting on 1 Mar.
    expect(burndown[1].remaining).toBe(10); // day 2: nothing closed yet
    expect(burndown[2].remaining).toBe(5); // day 3: 10 - 5
    expect(burndown[4].remaining).toBe(5); // day 5 (today): still 5 to go
    // Future days are not drawn yet
    expect(burndown[6].remaining).toBeNull();
    // The ideal line reaches zero on the last day
    expect(burndown[9].ideal).toBe(0);
  });

  it("handles an empty cycle without dividing by zero", () => {
    const progress = cycleProgress([], cycle);
    expect(progress.percent).toBe(0);
    expect(progress.committed).toBe(0);
  });
});

describe("velocity", () => {
  it("averages finished cycles, newest first, and ignores the running one", () => {
    const rows = velocity(
      [
        { ...cycle, name: "S1", startDate: "2026-01-01", endDate: "2026-01-10", tickets: [ticket({ estimate: 8, status: "done" })] },
        { ...cycle, name: "S2", startDate: "2026-02-01", endDate: "2026-02-10", tickets: [ticket({ estimate: 5, status: "done" }), ticket({ estimate: 5, status: "todo" })] },
        { ...cycle, name: "running", startDate: "2026-03-01", endDate: "2026-03-31", tickets: [ticket({ estimate: 3, status: "todo" })] },
      ],
      new Date("2026-03-05"),
    );
    expect(rows.map((row) => row.name)).toEqual(["S2", "S1"]);
    expect(rows[0]).toEqual({ name: "S2", completed: 5, committed: 10 });
  });
});

/**
 * The `Cycle` shape the cycles UI stores (`start`/`end`, ISO strings) and the
 * pure burndown/scope helpers built on it. All the date maths is UTC, so the
 * assertions do not depend on the machine's timezone.
 */
const epochCycle: Cycle = {
  id: "c1",
  name: "Sprint 1",
  start: "2026-03-01T00:00:00.000Z",
  end: "2026-03-05T00:00:00.000Z",
};

describe("cycleDays with a Cycle", () => {
  it("counts inclusive UTC days and never returns zero", () => {
    expect(cycleDays(epochCycle)).toBe(5);
    expect(cycleDays({ ...epochCycle, end: epochCycle.start })).toBe(1);
    // A same-day end that is still later than the start is still one day.
    expect(cycleDays({ ...epochCycle, end: "2026-03-01T23:59:59.000Z" })).toBe(1);
  });
});

describe("ticketsInCycle", () => {
  const list = [
    ticket({ id: "a", status: "done", estimate: 8, completedAt: "2026-03-02T00:00:00.000Z" }),
    ticket({ id: "b", status: "todo", startDate: "2026-03-05" }),
    ticket({ id: "c", status: "todo", dueDate: "2026-03-07" }),
    ticket({ id: "d", status: "todo" }),
    ticket({ id: "e", status: "done", completedAt: "2026-02-25T00:00:00.000Z" }),
    ticket({ id: "f", status: "done", completedAt: "2026-03-05T00:00:00.000Z" }),
  ];

  it("keeps tickets whose completion or schedule lands inside the window", () => {
    expect(ticketsInCycle(list, epochCycle).map((row) => row.id)).toEqual(["a", "b", "f"]);
  });

  it("drops tickets that only fall outside the window", () => {
    const ids = ticketsInCycle(list, epochCycle).map((row) => row.id);
    expect(ids).not.toContain("c"); // scheduled after the end
    expect(ids).not.toContain("e"); // completed before the start
    expect(ids).not.toContain("d"); // carries no dates at all
  });

  it("honours a custom completion field", () => {
    const custom = [
      ticket({ id: "x", status: "done", updatedAt: "2026-03-04T00:00:00.000Z" }),
      ticket({ id: "y", status: "done", updatedAt: "2026-03-09T00:00:00.000Z" }),
    ];
    expect(ticketsInCycle(custom, epochCycle)).toEqual([]);
    expect(ticketsInCycle(custom, epochCycle, { completedAtField: "updatedAt" }).map((row) => row.id)).toEqual([
      "x",
    ]);
  });
});

describe("burndownSeries", () => {
  const tickets = [
    ticket({ id: "a", status: "done", estimate: 8, completedAt: "2026-03-02T00:00:00.000Z" }),
    ticket({ id: "b", status: "todo", estimate: 5 }),
    ticket({ id: "c", status: "in_progress", estimate: 2 }),
  ];
  const now = new Date("2026-03-03T12:00:00.000Z");

  it("draws one point per UTC day, dated from the cycle start", () => {
    const series = burndownSeries(epochCycle, tickets, { now });
    expect(series).toHaveLength(5);
    expect(series.map((point) => point.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
  });

  it("burns closed estimates on their completion day and leaves the future unmeasured", () => {
    const series = burndownSeries(epochCycle, tickets, { now });
    expect(series.map((point) => point.remaining)).toEqual([15, 7, 7, null, null]);
  });

  it("runs the ideal line from the total to zero", () => {
    const series = burndownSeries(epochCycle, tickets, { now });
    expect(series[0].ideal).toBe(15);
    expect(series[2].ideal).toBe(7.5);
    expect(series[4].ideal).toBe(0);
  });

  it("measures the whole cycle when no clock is given", () => {
    const series = burndownSeries(epochCycle, tickets);
    expect(series.every((point) => typeof point.remaining === "number")).toBe(true);
    expect(series[4].remaining).toBe(7);
  });

  it("handles a single-day cycle without dividing by zero", () => {
    const series = burndownSeries({ ...epochCycle, end: epochCycle.start }, tickets);
    expect(series).toHaveLength(1);
    expect(series[0].ideal).toBe(15);
    expect(series[0].remaining).toBe(7);
  });
});

describe("addedMidCycle & scopeChange", () => {
  const list = [
    ticket({ id: "p1", estimate: 2, createdAt: "2026-02-20T00:00:00.000Z" }),
    ticket({ id: "p2", estimate: 3, createdAt: "2026-03-01T00:00:00.000Z" }),
    ticket({ id: "p3", estimate: 5, createdAt: "2026-03-03T00:00:00.000Z" }),
    ticket({ id: "p4", estimate: 1, createdAt: "2026-03-05T23:00:00.000Z" }),
    ticket({ id: "p5", estimate: 100, createdAt: "2026-03-09T00:00:00.000Z" }),
  ];

  it("flags tickets created on a later UTC day than the start", () => {
    expect(addedMidCycle(list, epochCycle).map((row) => row.id)).toEqual(["p3", "p4"]);
  });

  it("ignores tickets created after the cycle ends and those with no stamp", () => {
    const withUntimed = [...list, ticket({ id: "p6", estimate: 4 })];
    expect(addedMidCycle(withUntimed, epochCycle).map((row) => row.id)).toEqual(["p3", "p4"]);
  });

  it("summarises the mid-cycle scope creep", () => {
    const change = scopeChange(list, epochCycle);
    expect(change.planned).toBe(2);
    expect(change.added).toBe(2);
    expect(change.addedEstimate).toBe(6);
    expect(change.ratio).toBe(0.5);
  });

  it("never divides by zero on an empty cycle", () => {
    expect(scopeChange([], epochCycle)).toEqual({ planned: 0, added: 0, addedEstimate: 0, ratio: 0 });
  });
});

describe("cycleProgress with the Cycle shape", () => {
  const tickets = [
    ticket({ id: "a", estimate: 8, status: "done", completedAt: "2026-03-02T00:00:00.000Z" }),
    ticket({ id: "b", estimate: 5, status: "todo" }),
    ticket({ id: "c", estimate: 2, status: "in_progress" }),
  ];

  it("reads committed/completed/remaining from the same window", () => {
    const progress = cycleProgress(tickets, epochCycle, new Date("2026-03-03T12:00:00.000Z"));
    expect(progress.committed).toBe(15);
    expect(progress.completed).toBe(8);
    expect(progress.remaining).toBe(7);
    expect(progress.percent).toBe(53);
    expect(progress.days).toBe(5);
  });
});

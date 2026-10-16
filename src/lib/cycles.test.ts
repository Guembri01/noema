import { describe, expect, it } from "vitest";
import {
  activeCycle,
  addedMidCycle,
  burndown,
  burndownSeries,
  currentCycle,
  cycleDays,
  cycleProgress,
  cycleScope,
  describeCycle,
  nextCycleStart,
  rollOverIncomplete,
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

/**
 * The canonical `Cycle` shape (`startDate`/`endDate` inclusive window) and the
 * additive cycles/sprints engine built on it. All date maths is UTC, so the
 * assertions do not depend on the machine's timezone.
 */
const sprint: Cycle = {
  id: "sprint-1",
  name: "Sprint 1",
  startDate: "2026-03-01T00:00:00.000Z",
  endDate: "2026-03-10T00:00:00.000Z",
  scopeId: "proj-1",
};

const sprintDays = [
  "2026-03-01",
  "2026-03-02",
  "2026-03-03",
  "2026-03-04",
  "2026-03-05",
  "2026-03-06",
  "2026-03-07",
  "2026-03-08",
  "2026-03-09",
  "2026-03-10",
];

describe("currentCycle", () => {
  const previous = { id: "sprint-0", name: "Sprint 0", startDate: "2026-02-01", endDate: "2026-02-10" };
  const later = { id: "sprint-2", name: "Sprint 2", startDate: "2026-03-15", endDate: "2026-03-24" };

  it("returns the cycle whose window contains now", () => {
    expect(currentCycle([previous, sprint, later], new Date("2026-03-05"))?.id).toBe("sprint-1");
  });

  it("treats the start instant as inside the window", () => {
    expect(currentCycle([previous, sprint, later], new Date("2026-03-01T00:00:00.000Z"))?.id).toBe(
      "sprint-1",
    );
  });

  it("treats the end instant as inside the window", () => {
    expect(currentCycle([previous, sprint, later], new Date("2026-03-10T00:00:00.000Z"))?.id).toBe(
      "sprint-1",
    );
  });

  it("returns null in the gap between cycles", () => {
    expect(currentCycle([previous, sprint, later], new Date("2026-03-12"))).toBeNull();
  });

  it("returns null when nothing is scheduled", () => {
    expect(currentCycle([], new Date("2026-03-05"))).toBeNull();
  });
});

describe("cycleProgress timing", () => {
  it("reports elapsed percent and days left mid-cycle", () => {
    const timing = cycleProgress(sprint, new Date("2026-03-05T12:00:00.000Z"));
    expect(timing).toMatchObject({
      status: "running",
      days: 10,
      daysElapsed: 5,
      daysLeft: 5,
      elapsedPercent: 50,
    });
  });

  it("labels the inclusive UTC window", () => {
    const timing = cycleProgress(sprint, new Date("2026-03-05T12:00:00.000Z"));
    expect(timing.start).toBe("2026-03-01");
    expect(timing.end).toBe("2026-03-10");
  });

  it("reports an upcoming cycle as zero elapsed", () => {
    expect(cycleProgress(sprint, new Date("2026-02-20"))).toMatchObject({
      status: "upcoming",
      daysElapsed: 0,
      daysLeft: 10,
      elapsedPercent: 0,
    });
  });

  it("reports a finished cycle as fully elapsed", () => {
    expect(cycleProgress(sprint, new Date("2026-03-20"))).toMatchObject({
      status: "ended",
      daysElapsed: 10,
      daysLeft: 0,
      elapsedPercent: 100,
    });
  });

  it("clamps the last day to zero days left", () => {
    expect(cycleProgress(sprint, new Date("2026-03-10T00:00:00.000Z"))).toMatchObject({
      status: "running",
      daysLeft: 0,
      elapsedPercent: 100,
    });
  });
});

describe("nextCycleStart", () => {
  const scheduled: Cycle[] = [
    { id: "a", name: "A", startDate: "2026-03-01T00:00:00.000Z", endDate: "2026-03-10T00:00:00.000Z" },
  ];

  it("steps one cadence past the most recent cycle start", () => {
    expect(nextCycleStart(scheduled, { cadenceDays: 14, fromDate: "2026-03-05" })).toBe("2026-03-15");
  });

  it("keeps stepping while the candidate is not in the future", () => {
    expect(nextCycleStart(scheduled, { cadenceDays: 14, fromDate: "2026-03-15" })).toBe("2026-03-29");
    expect(nextCycleStart(scheduled, { cadenceDays: 14, fromDate: "2026-03-16" })).toBe("2026-03-29");
  });

  it("falls back to the from date when no cycle precedes it", () => {
    expect(nextCycleStart([], { cadenceDays: 14, fromDate: "2026-03-05" })).toBe("2026-03-19");
  });

  it("anchors on the latest cycle that started on or before the from date", () => {
    const both: Cycle[] = [
      { id: "a", name: "A", startDate: "2026-03-01", endDate: "2026-03-10" },
      { id: "b", name: "B", startDate: "2026-03-20", endDate: "2026-03-29" },
    ];
    expect(nextCycleStart(both, { cadenceDays: 14, fromDate: "2026-03-25" })).toBe("2026-04-03");
  });
});

describe("cycleScope", () => {
  const rows = [
    { id: "a", cycleId: "c1" },
    { id: "b", cycleId: "c2" },
    { id: "c", cycleId: "c1" },
  ];

  it("keeps only the rows assigned to the cycle, in order", () => {
    expect(cycleScope(rows, "c1").map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("returns an empty list for an unknown cycle", () => {
    expect(cycleScope(rows, "c9")).toEqual([]);
  });

  it("returns a new array rather than the input", () => {
    expect(cycleScope(rows, "c1")).not.toBe(rows);
  });
});

describe("rollOverIncomplete", () => {
  const rows = [
    { id: "u", cycleId: "c1", done: false },
    { id: "f", cycleId: "c1", done: true },
    { id: "o", cycleId: "c2", done: false },
  ];
  const moved = rollOverIncomplete(rows, { fromCycleId: "c1", toCycleId: "c2", doneKey: "done" });

  it("moves only the unfinished rows to the next cycle", () => {
    expect(moved.find((row) => row.id === "u")?.cycleId).toBe("c2");
  });

  it("leaves finished rows behind", () => {
    expect(moved.find((row) => row.id === "f")?.cycleId).toBe("c1");
  });

  it("leaves rows that belong to other cycles untouched", () => {
    expect(moved.find((row) => row.id === "o")?.cycleId).toBe("c2");
  });

  it("does not mutate the input rows", () => {
    expect(rows[0].cycleId).toBe("c1");
    expect(moved).not.toBe(rows);
  });

  it("reads a status word when the done key is a status field", () => {
    const board = [
      { id: "u", cycleId: "c1", status: "in_progress" },
      { id: "f", cycleId: "c1", status: "done" },
      { id: "g", cycleId: "c1", status: "closed" },
    ];
    const result = rollOverIncomplete(board, { fromCycleId: "c1", toCycleId: "c2", doneKey: "status" });
    expect(result.map((row) => [row.id, row.cycleId])).toEqual([
      ["u", "c2"],
      ["f", "c1"],
      ["g", "c1"],
    ]);
  });

  it("treats a missing done marker as unfinished", () => {
    const board = [
      { id: "x", cycleId: "c1" },
      { id: "y", cycleId: "c2" },
    ];
    expect(rollOverIncomplete(board, { fromCycleId: "c1", toCycleId: "c2", doneKey: "done" })[0].cycleId).toBe(
      "c2",
    );
  });
});

describe("burndown", () => {
  const rows = [
    { id: "a", cycleId: "sprint-1", estimate: 8, done: true, completedAt: "2026-03-03T00:00:00.000Z" },
    { id: "b", cycleId: "sprint-1", estimate: 5, done: false },
    { id: "c", cycleId: "sprint-1", estimate: 2, done: false },
  ];
  const now = new Date("2026-03-05T12:00:00.000Z");
  const series = burndown(sprint, rows, { now });

  it("draws one point per UTC day across the window", () => {
    expect(series).toHaveLength(10);
    expect(series.map((point) => point.date)).toEqual(sprintDays);
  });

  it("has the requested shape and starts from the scope at the cycle start", () => {
    expect(series[0]).toEqual({
      date: "2026-03-01",
      remaining: 15,
      idealRemaining: 15,
      completed: 0,
    });
  });

  it("burns a completed row on its completion day", () => {
    // Row "a" (8 points) closed on 3 Mar, the third day of the window.
    expect(series[2]).toMatchObject({ date: "2026-03-03", completed: 8, remaining: 7 });
  });

  it("runs the ideal line linearly from the start scope to zero", () => {
    expect(series[2].idealRemaining).toBe(11.67);
    expect(series[4].idealRemaining).toBe(8.33);
  });

  it("leaves days after now unmeasured", () => {
    expect(series[4].remaining).toBe(7);
    expect(series[5].remaining).toBeNull();
    expect(series[9].remaining).toBeNull();
  });

  it("boundaries at the cycle end with the ideal line at zero", () => {
    expect(series[9]).toMatchObject({ date: "2026-03-10", idealRemaining: 0 });
  });

  it("never plots above the starting scope", () => {
    expect(series.every((point) => point.idealRemaining <= 15)).toBe(true);
  });

  it("handles an empty cycle without dividing by zero", () => {
    const empty = burndown(sprint, [], { now });
    expect(empty.every((point) => point.idealRemaining === 0)).toBe(true);
    expect(empty[0].remaining).toBe(0);
    expect(empty[5].remaining).toBeNull();
  });
});

describe("velocity", () => {
  const cycles: Cycle[] = [
    { id: "s1", name: "S1", startDate: "2026-03-01", endDate: "2026-03-10" },
    { id: "s2", name: "S2", startDate: "2026-03-15", endDate: "2026-03-24" },
  ];
  const rows = [
    { id: "a", cycleId: "s1", estimate: 5, done: true },
    { id: "b", cycleId: "s1", estimate: 3, done: false },
    { id: "c", cycleId: "s2", estimate: 8, done: true },
    { id: "d", cycleId: "s2", estimate: 2, done: false },
  ];

  it("reports committed/completed points per cycle with a rolling average", () => {
    expect(velocity(cycles, rows)).toEqual([
      { cycleId: "s1", name: "S1", committed: 8, completed: 5, rollingAverage: 5 },
      { cycleId: "s2", name: "S2", committed: 10, completed: 8, rollingAverage: 6.5 },
    ]);
  });

  it("orders cycles chronologically even when the input is unsorted", () => {
    expect(velocity([cycles[1], cycles[0]], rows).map((entry) => entry.cycleId)).toEqual(["s1", "s2"]);
  });

  it("ignores rows assigned to an unknown cycle", () => {
    const extra = [...rows, { id: "z", cycleId: "s9", estimate: 100, done: true }];
    expect(velocity(cycles, extra).map((entry) => entry.completed)).toEqual([5, 8]);
  });

  it("honours custom estimate and done keys", () => {
    const tagged = [
      { id: "a", cycleId: "s1", points: 5, status: "done" },
      { id: "b", cycleId: "s1", points: 3, status: "in_progress" },
    ];
    expect(velocity([cycles[0]], tagged, { estimateKey: "points", doneKey: "status" })[0]).toMatchObject({
      committed: 8,
      completed: 5,
    });
  });

  it("returns an empty series without cycles", () => {
    expect(velocity([], rows)).toEqual([]);
  });
});

describe("describeCycle", () => {
  it("describes a running cycle with its remaining days", () => {
    const label = describeCycle(sprint, new Date("2026-03-05T12:00:00.000Z"));
    expect(label).toContain("Sprint 1");
    expect(label).toContain("running");
    expect(label).toContain("5 of 10 days left");
  });

  it("describes an upcoming cycle by its start", () => {
    expect(describeCycle(sprint, new Date("2026-02-20"))).toBe("Sprint 1 · starts 2026-03-01");
  });

  it("describes an ended cycle by its end", () => {
    expect(describeCycle(sprint, new Date("2026-03-20"))).toBe("Sprint 1 · ended 2026-03-10");
  });
});

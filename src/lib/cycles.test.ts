import { describe, expect, it } from "vitest";
import { activeCycle, cycleDays, cycleProgress, velocity } from "./cycles";

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

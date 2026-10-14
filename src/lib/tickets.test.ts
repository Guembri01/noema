import { describe, expect, it } from "vitest";
import {
  formatEstimate,
  groupByLabel,
  groupByStatus,
  isClosed,
  keyPrefix,
  sortTickets,
  sumEstimates,
  ticketKey,
  ticketProgress,
  timelineLayout,
} from "./tickets";

const ticket = (overrides: Partial<Parameters<typeof sortTickets>[0][number]> = {}) => ({
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
});

describe("ticket keys", () => {
  it("builds a prefix from a workspace name", () => {
    expect(keyPrefix("Demo Workspace")).toBe("DW");
    expect(keyPrefix("Noema")).toBe("NOE");
    expect(keyPrefix("Alpha Beta Gamma Delta")).toBe("ABG");
    expect(keyPrefix("   ")).toBe("NOE");
  });

  it("formats keys", () => {
    expect(ticketKey("demo workspace", 42)).toBe("DEMO-42");
    expect(ticketKey("💥", 7)).toBe("NOE-7");
  });
});

describe("estimates", () => {
  it("formats values with unit labels", () => {
    expect(formatEstimate(3, "points")).toBe("3 points");
    expect(formatEstimate(1, "points")).toBe("1 point");
    expect(formatEstimate(1.5, "days")).toBe("1.5 days");
    expect(formatEstimate(null, "points")).toBe("—");
  });

  it("sums by dominant unit and ignores empty estimates", () => {
    expect(sumEstimates([{ estimate: 3 }, { estimate: 2 }, { estimate: null }])).toEqual({
      total: 5,
      unit: "points",
      count: 3,
    });
    expect(sumEstimates([{ estimate: 1, estimateUnit: "days" }])).toEqual({
      total: 1,
      unit: "days",
      count: 1,
    });
    expect(sumEstimates([])).toEqual({ total: 0, unit: "points", count: 0 });
  });
});

describe("board and sorting", () => {
  it("groups into workflow columns with estimate totals", () => {
    const columns = groupByStatus([
      ticket({ id: "a", status: "todo", estimate: 3 }),
      ticket({ id: "b", status: "todo", estimate: 2 }),
      ticket({ id: "c", status: "done", estimate: 5 }),
    ]);
    expect(columns.map((column) => column.status)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "cancelled",
    ]);
    expect(columns.find((column) => column.status === "todo")?.estimate).toBe(5);
    expect(columns.find((column) => column.status === "done")?.tickets).toHaveLength(1);
  });

  it("sorts by priority then due date then key", () => {
    const sorted = sortTickets([
      ticket({ key: "NOE-3", priority: "low", dueDate: "2026-01-01" }),
      ticket({ key: "NOE-2", priority: "urgent", dueDate: "2026-03-01" }),
      ticket({ key: "NOE-1", priority: "urgent", dueDate: "2026-02-01" }),
    ]);
    expect(sorted.map((item) => item.key)).toEqual(["NOE-1", "NOE-2", "NOE-3"]);
  });

  it("knows which statuses are closed", () => {
    expect(isClosed("done")).toBe(true);
    expect(isClosed("cancelled")).toBe(true);
    expect(isClosed("in_review")).toBe(false);
  });
});

describe("timeline", () => {
  it("lays dated tickets inside the window with a today marker", () => {
    const layout = timelineLayout(
      [
        ticket({ id: "a", startDate: "2026-01-10", dueDate: "2026-01-20" }),
        ticket({ id: "b" }),
      ],
      { today: new Date("2026-01-15") },
    );
    const [a, b] = layout.rows;
    expect(a.left).toBeGreaterThanOrEqual(0);
    expect(a.width).toBeGreaterThan(1);
    expect(a.hasDates).toBe(true);
    // Undated tickets still render at "today" and are flagged.
    expect(b.hasDates).toBe(false);
    expect(b.left).toBeCloseTo(layout.todayOffset, 0);
    expect(layout.todayOffset).toBeGreaterThan(0);
    expect(layout.todayOffset).toBeLessThan(100);
  });

  it("keeps a sane window for a single dateless ticket", () => {
    const layout = timelineLayout([ticket({ id: "solo" })], { today: new Date("2026-05-05") });
    expect(layout.days).toBe(4);
    expect(layout.rows).toHaveLength(1);
  });
});

describe("progress and label grouping", () => {
  it("computes closed counts and remaining estimate", () => {
    const progress = ticketProgress([
      ticket({ id: "a", status: "done", estimate: 5 }),
      ticket({ id: "b", status: "todo", estimate: 3 }),
      ticket({ id: "c", status: "in_progress", estimate: 2 }),
    ]);
    expect(progress).toMatchObject({ total: 3, closed: 1, open: 2, percent: 33 });
    expect(progress.remaining).toEqual({ total: 5, unit: "points", count: 2 });
  });

  it("groups by label with an unlabelled bucket", () => {
    const groups = groupByLabel(
      [{ id: "a" }, { id: "b" }],
      { a: ["l1"], b: [] },
      ["l1", "l2"],
    );
    expect(groups.map((group) => group.labelId)).toEqual(["l1", "l2", null]);
    expect(groups[0].tickets).toHaveLength(1);
    expect(groups[2].tickets).toHaveLength(1);
  });
});

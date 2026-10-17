import { describe, expect, it } from "vitest";
import {
  RELATION_TYPES,
  capacityStatus,
  formatEstimate,
  groupByLabel,
  groupByStatus,
  isClosed,
  keyPrefix,
  milestoneAfterProjectChange,
  milestoneChoices,
  normalizeLabelInput,
  priorityMeta,
  sortTickets,
  statusMeta,
  suggestRebalance,
  sumEstimates,
  ticketKey,
  ticketProgress,
  timelineLayout,
  typeMeta,
  workloadByAssignee,
  type WorkloadBucket,
  type WorkloadTicket,
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

describe("key generation format", () => {
  it("cleans prefixes to alphanumerics, caps them and falls back to NOE", () => {
    expect(ticketKey("a-b_c!", 5)).toBe("ABC-5");
    expect(ticketKey("ABCDEF", 1)).toBe("ABCD-1");
    // Digits are deliberately in the allowlist (`[^A-Za-z0-9]` keeps them).
    expect(ticketKey("ab12cd", 3)).toBe("AB12-3");
    expect(ticketKey("", 9)).toBe("NOE-9");
    expect(ticketKey("💥💥", 9)).toBe("NOE-9");
  });

  it("always emits a well-formed key for any workspace name", () => {
    const names = [
      "Demo Workspace",
      "Noema",
      "4D Space",
      "💥 Studio",
      "   ",
      "d-emo",
      "Alpha Beta Gamma Delta",
    ];
    for (const name of names) {
      expect(ticketKey(keyPrefix(name), 7)).toMatch(/^[A-Z0-9]{1,4}-7$/);
    }
  });

  it("builds prefixes from one- and two-word names", () => {
    expect(keyPrefix("my board")).toBe("MB");
    expect(keyPrefix("Bug")).toBe("BUG");
    expect(keyPrefix("alpha beta")).toBe("AB");
  });
});

describe("relation labels and inverses", () => {
  const byId = new Map(RELATION_TYPES.map((relation) => [relation.id, relation]));

  it("declares exactly the four board relation types", () => {
    expect([...byId.keys()]).toEqual(["blocks", "blocked_by", "relates", "duplicates"]);
  });

  it("points every inverse at a known relation", () => {
    for (const relation of RELATION_TYPES) {
      expect(byId.has(relation.inverse)).toBe(true);
    }
  });

  it("round-trips inverses: blocks <-> blocked_by, self-inverse pairs stay put", () => {
    for (const relation of RELATION_TYPES) {
      expect(byId.get(relation.inverse)?.inverse).toBe(relation.id);
    }
    expect(byId.get("blocks")?.inverse).toBe("blocked_by");
    expect(byId.get("blocked_by")?.inverse).toBe("blocks");
    expect(byId.get("relates")?.inverse).toBe("relates");
    expect(byId.get("duplicates")?.inverse).toBe("duplicates");
  });

  it("labels every direction, with unique labels", () => {
    expect(byId.get("blocks")?.label).toBe("Blocks");
    expect(byId.get("blocked_by")?.label).toBe("Blocked by");
    expect(byId.get("relates")?.label).toBe("Relates to");
    expect(byId.get("duplicates")?.label).toBe("Duplicates");
    expect(new Set(RELATION_TYPES.map((relation) => relation.label)).size).toBe(
      RELATION_TYPES.length,
    );
  });
});

describe("number sequencing", () => {
  it("issues unique, monotonically numbered keys from a counter", () => {
    const prefix = keyPrefix("Demo Workspace");
    const keys = Array.from({ length: 12 }, (_, index) => ticketKey(prefix, index + 1));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.map((key) => Number(key.split("-")[1]))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(keys.every((key) => key.startsWith("DW-"))).toBe(true);
  });

  it("orders list ties by key numerically, not lexicographically", () => {
    // Priority and due date tie, so the key tie-break decides: NOE-2 must
    // precede NOE-10 (keys are ordered identifiers, not strings).
    const sorted = sortTickets([
      ticket({ key: "NOE-10", priority: "none" }),
      ticket({ key: "NOE-2", priority: "none" }),
      ticket({ key: "NOE-1", priority: "none" }),
    ]);
    expect(sorted.map((item) => item.key)).toEqual(["NOE-1", "NOE-2", "NOE-10"]);
  });
});

describe("estimate counters", () => {
  it("counts every listed ticket even when no estimate is set", () => {
    // `count` is items.length (pinned above for mixed lists); the all-null
    // branch must not silently report 0.
    expect(sumEstimates([{ estimate: null }, { estimate: null }])).toEqual({
      total: 0,
      unit: "points",
      count: 2,
    });
    expect(sumEstimates([{ estimate: null }])).toEqual({
      total: 0,
      unit: "points",
      count: 1,
    });
  });
});

describe("metadata fallbacks", () => {
  it("falls back to safe defaults for unknown ids", () => {
    expect(statusMeta("nonsense").id).toBe("todo");
    expect(priorityMeta("nonsense").id).toBe("none");
    expect(typeMeta("nonsense").id).toBe("task");
    expect(isClosed("nonsense")).toBe(false);
  });

  it("resolves known ids to their metadata", () => {
    expect(statusMeta("in_review")).toMatchObject({ label: "In review", done: false });
    expect(priorityMeta("urgent")).toMatchObject({ label: "Urgent", weight: 4 });
    expect(typeMeta("bug")).toMatchObject({ label: "Bug", icon: "🐞" });
  });
});

describe("label input validation (extracted from createLabelAction)", () => {
  it("trims the name and defaults an omitted colour to gray", () => {
    expect(normalizeLabelInput({ name: "  Needs review  " })).toEqual({
      ok: true,
      name: "Needs review",
      color: "gray",
      description: null,
    });
    expect(normalizeLabelInput({ name: "x", color: null })).toMatchObject({ color: "gray" });
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(normalizeLabelInput({ name: "   " })).toEqual({
      ok: false,
      error: "Give the label a name.",
    });
    expect(normalizeLabelInput({ name: "" })).toEqual({
      ok: false,
      error: "Give the label a name.",
    });
  });

  it("caps the name at 40 characters", () => {
    const result = normalizeLabelInput({ name: "x".repeat(60) });
    expect(result.ok).toBe(true);
    expect(result.ok && result.name).toHaveLength(40);
  });

  it("keeps known colours and falls back to gray for junk", () => {
    expect(normalizeLabelInput({ name: "x", color: "pink" })).toMatchObject({ color: "pink" });
    expect(normalizeLabelInput({ name: "x", color: "chartreuse" })).toMatchObject({
      color: "gray",
    });
    expect(normalizeLabelInput({ name: "x", color: "" })).toMatchObject({ color: "gray" });
  });

  it("trims and caps the description, treating blanks as null", () => {
    expect(normalizeLabelInput({ name: "x", description: "  " })).toMatchObject({
      description: null,
    });
    expect(normalizeLabelInput({ name: "x", description: " /details  " })).toMatchObject({
      description: "/details",
    });
    const long = normalizeLabelInput({ name: "x", description: "d".repeat(300) });
    expect(long.ok && long.description).toHaveLength(200);
  });
});

/** Workload fixture: a normal ticket that also carries an assignee. */
const workloadTicket = (overrides: Partial<WorkloadTicket> = {}): WorkloadTicket => ({
  ...ticket(overrides),
  assigneeId: overrides.assigneeId ?? null,
});

/** Pre-shaped bucket, for capacityStatus tests that skip aggregation. */
const bucket = (assigneeId: string, openCount: number, points: number): WorkloadBucket => ({
  assigneeId,
  openCount,
  points,
  unit: "points",
});

describe("workload by assignee", () => {
  it("aggregates open tickets per assignee plus an unassigned bucket", () => {
    const buckets = workloadByAssignee([
      workloadTicket({ id: "a", assigneeId: "u1", estimate: 3 }),
      workloadTicket({ id: "b", assigneeId: "u1", estimate: 2 }),
      workloadTicket({ id: "c", assigneeId: "u2", estimate: 8 }),
      workloadTicket({ id: "d", assigneeId: null }),
    ]);
    // Sorted by load: open count desc, then points desc, then id asc.
    expect(buckets).toEqual([
      { assigneeId: "u1", openCount: 2, points: 5, unit: "points" },
      { assigneeId: "u2", openCount: 1, points: 8, unit: "points" },
      { assigneeId: "unassigned", openCount: 1, points: 0, unit: "points" },
    ]);
  });

  it("excludes done and cancelled tickets from counts and sums", () => {
    const buckets = workloadByAssignee([
      workloadTicket({ id: "a", assigneeId: "u1", status: "in_progress", estimate: 3 }),
      workloadTicket({ id: "b", assigneeId: "u1", status: "done", estimate: 5 }),
      workloadTicket({ id: "c", assigneeId: "u2", status: "cancelled", estimate: 13 }),
    ]);
    // u2 only holds closed work, so it gets no bucket at all.
    expect(buckets).toEqual([{ assigneeId: "u1", openCount: 1, points: 3, unit: "points" }]);
  });

  it("sums estimates, counting missing/zero estimates as nothing", () => {
    const buckets = workloadByAssignee([
      workloadTicket({ id: "a", assigneeId: "u1", estimate: null }),
      workloadTicket({ id: "b", assigneeId: "u1", estimate: 0 }),
      workloadTicket({ id: "c", assigneeId: "u1", estimate: 2.5 }),
    ]);
    expect(buckets).toEqual([{ assigneeId: "u1", openCount: 3, points: 2.5, unit: "points" }]);
  });

  it("scopes to a date range by start/due date overlap", () => {
    const scoped = workloadByAssignee(
      [
        workloadTicket({ id: "over", assigneeId: "u1", startDate: "2026-01-05", dueDate: "2026-01-12", estimate: 3 }),
        workloadTicket({ id: "before", assigneeId: "u1", startDate: "2026-01-01", dueDate: "2026-01-09", estimate: 5 }),
        workloadTicket({ id: "after", assigneeId: "u1", startDate: "2026-01-25", dueDate: "2026-01-27", estimate: 8 }),
        workloadTicket({ id: "undated", assigneeId: "u1", estimate: 11 }),
        workloadTicket({ id: "dueOnly", assigneeId: "u1", dueDate: "2026-01-15", estimate: 2 }),
        workloadTicket({ id: "closed", assigneeId: "u1", status: "done", startDate: "2026-01-10", dueDate: "2026-01-11", estimate: 4 }),
      ],
      { dateRange: { start: "2026-01-10", end: "2026-01-20" } },
    );
    // Overlapping + due-only tickets count; out-of-window, undated and
    // closed ones do not.
    expect(scoped).toEqual([{ assigneeId: "u1", openCount: 2, points: 5, unit: "points" }]);
  });

  it("treats range bounds as inclusive and a boundless range as no filter", () => {
    const tickets = [
      workloadTicket({ id: "startEdge", assigneeId: "u1", startDate: "2026-01-10" }),
      workloadTicket({ id: "endEdge", assigneeId: "u1", startDate: "2026-01-20" }),
      workloadTicket({ id: "undated", assigneeId: "u1" }),
    ];
    const edges = workloadByAssignee(tickets, {
      dateRange: { start: "2026-01-10", end: "2026-01-20" },
    });
    expect(edges[0]?.openCount).toBe(2);

    const unbounded = workloadByAssignee(tickets, { dateRange: {} });
    expect(unbounded[0]?.openCount).toBe(3);

    const elsewhere = workloadByAssignee(tickets, {
      dateRange: { start: "2027-06-01", end: "2027-06-30" },
    });
    expect(elsewhere).toEqual([]);
  });
});

describe("capacity status", () => {
  it("flags over, near and under around the near-capacity threshold", () => {
    const rows = capacityStatus(
      [bucket("u1", 1, 12), bucket("u2", 1, 8), bucket("u3", 1, 3)],
      { u1: { maxPoints: 10 }, u2: { maxPoints: 10 }, u3: { maxPoints: 10 } },
    );
    expect(rows.map((row) => row.state)).toEqual(["over", "near", "under"]);
    expect(rows[0]).toMatchObject({ used: 12, limit: 10 });
    expect(rows[0].utilization).toBeCloseTo(1.2, 4);
    expect(rows[1]).toMatchObject({ used: 8, limit: 10, utilization: 0.8 });
    expect(rows[2].utilization).toBeCloseTo(0.3, 4);
  });

  it("honours a configurable near-capacity threshold", () => {
    const generous = capacityStatus([bucket("u1", 1, 6)], { u1: { maxPoints: 10 } }, { nearThreshold: 0.5 });
    expect(generous[0]?.state).toBe("near");
    const strict = capacityStatus([bucket("u1", 1, 6)], { u1: { maxPoints: 10 } }, { nearThreshold: 0.9 });
    expect(strict[0]?.state).toBe("under");
  });

  it("reports unknown when capacity is missing instead of dividing by zero", () => {
    const rows = capacityStatus([bucket("u1", 3, 5), bucket("u2", 0, 0)], { u2: { maxPoints: 0 } });
    expect(rows[0]).toEqual({
      assigneeId: "u1",
      used: 5,
      limit: null,
      utilization: null,
      state: "unknown",
    });
    // Zero capacity with nothing loaded: no ratio, nothing flagged either.
    expect(rows[1]).toEqual({
      assigneeId: "u2",
      used: 0,
      limit: 0,
      utilization: null,
      state: "unknown",
    });
    // Zero capacity with load on it: no ratio, but definitely over.
    const loaded = capacityStatus([bucket("u1", 3, 5)], { u1: { maxPoints: 0 } });
    expect(loaded[0]).toEqual({
      assigneeId: "u1",
      used: 5,
      limit: 0,
      utilization: null,
      state: "over",
    });
    // A limit in the wrong unit for the requested basis is also unusable.
    const mismatched = capacityStatus([bucket("u1", 3, 5)], { u1: { maxPoints: 10 } }, { basis: "tickets" });
    expect(mismatched[0]?.state).toBe("unknown");
    expect(mismatched[0]?.utilization).toBeNull();
  });

  it("measures open ticket counts against maxOpenTickets on the tickets basis", () => {
    const rows = capacityStatus(
      [bucket("u1", 4, 40), bucket("u2", 9, 90)],
      { u1: { maxOpenTickets: 5 }, u2: { maxOpenTickets: 10 } },
      { basis: "tickets" },
    );
    expect(rows).toMatchObject([
      { assigneeId: "u1", used: 4, limit: 5, utilization: 0.8, state: "near" },
      { assigneeId: "u2", used: 9, limit: 10, utilization: 0.9, state: "near" },
    ]);
  });

  it("includes people who have capacity but no open tickets", () => {
    const rows = capacityStatus([bucket("u1", 2, 5)], {
      u1: { maxPoints: 10 },
      idle: { maxPoints: 10 },
    });
    expect(rows.map((row) => row.assigneeId)).toEqual(["u1", "idle"]);
    expect(rows[1]).toMatchObject({ used: 0, limit: 10, utilization: 0, state: "under" });
  });
});

describe("suggest rebalance", () => {
  it("moves work from the most overloaded to the least loaded candidate", () => {
    const suggestion = suggestRebalance(
      [
        workloadTicket({ id: "a", assigneeId: "u1", estimate: 8 }),
        workloadTicket({ id: "b", assigneeId: "u1", estimate: 5 }),
        workloadTicket({ id: "c", assigneeId: "u2", estimate: 3 }),
        workloadTicket({ id: "d", assigneeId: null, estimate: 13 }),
      ],
      { u3: { maxPoints: 10 } },
    );
    // u1 has 13 points; u3 only exists in the capacity map, so it is idle.
    expect(suggestion).toEqual({ from: "u1", to: "u3", fromLoad: 13, toLoad: 0 });
  });

  it("is deterministic when everyone is equal", () => {
    const tickets = [
      workloadTicket({ id: "a", assigneeId: "u2", estimate: 5 }),
      workloadTicket({ id: "b", assigneeId: "u1", estimate: 5 }),
      workloadTicket({ id: "c", assigneeId: "u3", estimate: 5 }),
    ];
    const expected = { from: "u1", to: "u2", fromLoad: 5, toLoad: 5 };
    expect(suggestRebalance(tickets, {})).toEqual(expected);
    // Input order must not change the pick: ties break on assignee id.
    expect(suggestRebalance([...tickets].reverse(), {})).toEqual(expected);
  });

  it("has nothing to suggest without open work or a second candidate", () => {
    expect(
      suggestRebalance(
        [workloadTicket({ id: "a", assigneeId: "u1", status: "done", estimate: 5 })],
        { u1: { maxPoints: 5 }, u2: { maxPoints: 5 } },
      ),
    ).toEqual({ from: null, to: null, fromLoad: 0, toLoad: null });
    expect(suggestRebalance([workloadTicket({ id: "a", assigneeId: "u1", estimate: 5 })], {})).toEqual(
      { from: "u1", to: null, fromLoad: 5, toLoad: null },
    );
  });

  it("never treats unassigned as a sender or receiver", () => {
    const suggestion = suggestRebalance(
      [
        workloadTicket({ id: "a", assigneeId: null, estimate: 20 }),
        workloadTicket({ id: "b", assigneeId: "u1", estimate: 5 }),
      ],
      {},
    );
    expect(suggestion).toEqual({ from: "u1", to: null, fromLoad: 5, toLoad: null });
  });

  it("respects the date range and the load basis", () => {
    const windowed = suggestRebalance(
      [
        workloadTicket({ id: "a", assigneeId: "u1", estimate: 10, startDate: "2026-01-02", dueDate: "2026-01-03" }),
        workloadTicket({ id: "b", assigneeId: "u2", estimate: 2, startDate: "2026-01-15", dueDate: "2026-01-16" }),
      ],
      {},
      { dateRange: { start: "2026-01-10", end: "2026-01-20" } },
    );
    expect(windowed).toEqual({ from: "u2", to: null, fromLoad: 2, toLoad: null });

    const tickets = [
      workloadTicket({ id: "c", assigneeId: "u1", estimate: 1 }),
      workloadTicket({ id: "d", assigneeId: "u1", estimate: 1 }),
      workloadTicket({ id: "e", assigneeId: "u2", estimate: 9 }),
    ];
    // By points u2 leads (9 > 2); by open tickets u1 leads (2 > 1).
    expect(suggestRebalance(tickets, {}).from).toBe("u2");
    expect(suggestRebalance(tickets, {}, { basis: "tickets" }).from).toBe("u1");
  });
});

describe("milestone choices", () => {
  const projects = [
    {
      id: "p1",
      name: "Apollo",
      milestones: [
        { id: "m1", name: "Launch" },
        { id: "m2", name: "Orbit" },
      ],
    },
    { id: "p2", name: "Borealis", milestones: [{ id: "m3", name: "Launch" }] },
  ];

  it("scopes a project ticket to that project's milestones with bare names", () => {
    expect(milestoneChoices(projects, "p2")).toEqual([
      { id: "m3", name: "Launch", projectId: "p2", projectName: "Borealis", label: "Launch" },
    ]);
  });

  it("qualifies every workspace milestone when the ticket has no project", () => {
    expect(milestoneChoices(projects, null).map((choice) => choice.label)).toEqual([
      "Apollo - Launch",
      "Apollo - Orbit",
      "Borealis - Launch",
    ]);
  });

  it("tolerates a project whose milestones were not loaded", () => {
    expect(milestoneChoices([{ id: "p3", name: "Cygnus" }], null)).toEqual([]);
  });

  it("keeps a milestone the ticket's project owns and drops a foreign one", () => {
    const choices = milestoneChoices(projects, "p1");
    expect(milestoneAfterProjectChange("m1", choices)).toBe("m1");
    expect(milestoneAfterProjectChange("m3", choices)).toBeNull();
    expect(milestoneAfterProjectChange(null, choices)).toBeNull();
  });

  it("keeps the milestone when the ticket leaves its project (all are offered then)", () => {
    expect(milestoneAfterProjectChange("m1", milestoneChoices(projects, null))).toBe("m1");
  });
});

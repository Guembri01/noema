import { describe, expect, it } from "vitest";
import {
  RELATION_TYPES,
  formatEstimate,
  groupByLabel,
  groupByStatus,
  isClosed,
  keyPrefix,
  normalizeLabelInput,
  priorityMeta,
  sortTickets,
  statusMeta,
  sumEstimates,
  ticketKey,
  ticketProgress,
  timelineLayout,
  typeMeta,
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

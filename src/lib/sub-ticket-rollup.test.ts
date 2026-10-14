import { describe, expect, it } from "vitest";
import { UNASSIGNED_BUCKET } from "@/lib/tickets";
import {
  buildTicketTree,
  isTicketClosed,
  progressOf,
  rollupByAssignee,
  rollupEstimate,
  rollupPoints,
  subtreeTickets,
  validateTicketTree,
  type RollupTicket,
} from "@/lib/sub-ticket-rollup";

/**
 * MISSING_FEATURES top gap #1 — "Sub-tickets & dependency tree": parent/child
 * issues already exist in the schema, the roll-up of child estimates does not.
 *
 * Red-first: `src/lib/sub-ticket-rollup.ts` did not exist when this file was
 * written, so the whole suite fails on the missing module until the pure engine
 * lands. Everything here is pure data in / data out — no DB, no routes, no
 * React — and every function must leave its input untouched.
 *
 * Ticket shape: `{ id, parentId?, estimate?, done?, state? }` plus optional
 * `assigneeId` for the per-person roll-up. `done` (when present) wins over
 * `state`; otherwise `state` is mapped through tickets' `isClosed`.
 */

const t = (
  id: string,
  parentId: string | null = null,
  estimate: number | null = null,
  extra: Partial<RollupTicket> = {},
): RollupTicket => ({ id, parentId, estimate, ...extra });

const ids = (tickets: readonly RollupTicket[]): string[] => tickets.map((ticket) => ticket.id);

/** Stored out of order on purpose: children keep input order in every walk. */
const tree: RollupTicket[] = [
  t("task-a2", "story-a", 2, { assigneeId: "bo" }),
  t("epic", null, 8, { assigneeId: "ana" }),
  t("task-a1", "story-a", 1, { done: true, assigneeId: "bo" }),
  t("story-a", "epic", 3, { assigneeId: "ana" }),
  t("story-b", "epic", 5, { state: "done", assigneeId: "ana" }),
];

describe("sub-ticket-rollup: isTicketClosed", () => {
  it("lets an explicit `done` flag win over `state`", () => {
    expect(isTicketClosed(t("a", null, null, { done: true }))).toBe(true);
    expect(isTicketClosed(t("b", null, null, { done: false, state: "done" }))).toBe(false);
    expect(isTicketClosed(t("c", null, null, { done: true, state: "todo" }))).toBe(true);
  });

  it("falls back to tickets' isClosed for `state` (done + cancelled close)", () => {
    expect(isTicketClosed(t("a", null, null, { state: "done" }))).toBe(true);
    expect(isTicketClosed(t("b", null, null, { state: "cancelled" }))).toBe(true);
    expect(isTicketClosed(t("c", null, null, { state: "in_progress" }))).toBe(false);
    expect(isTicketClosed(t("d"))).toBe(false);
  });
});

describe("sub-ticket-rollup: buildTicketTree", () => {
  it("builds roots with nested children in input order", () => {
    const forest = buildTicketTree(tree);
    expect(forest.map((node) => node.ticket.id)).toEqual(["epic"]);
    expect(forest[0].children.map((node) => node.ticket.id)).toEqual(["story-a", "story-b"]);
    expect(forest[0].children[0].children.map((node) => node.ticket.id)).toEqual([
      "task-a2",
      "task-a1",
    ]);
    expect(forest[0].children[0].children[0].children).toEqual([]);
  });

  it("treats an orphan as a root and omits a cycle component (no root)", () => {
    const messy = [t("root", null, 1), t("orphan", "ghost", 1), t("a", "b"), t("b", "a")];
    const forest = buildTicketTree(messy);
    expect(forest.map((node) => node.ticket.id)).toEqual(["root", "orphan"]);
  });

  it("handles empty input", () => {
    expect(buildTicketTree([])).toEqual([]);
  });
});

describe("sub-ticket-rollup: subtreeTickets", () => {
  it("returns the root plus descendants, depth-first pre-order", () => {
    expect(ids(subtreeTickets(tree, "epic"))).toEqual([
      "epic",
      "story-a",
      "task-a2",
      "task-a1",
      "story-b",
    ]);
    expect(ids(subtreeTickets(tree, "story-a"))).toEqual(["story-a", "task-a2", "task-a1"]);
    expect(ids(subtreeTickets(tree, "task-a1"))).toEqual(["task-a1"]);
  });

  it("returns an empty list for unknown ids or empty input", () => {
    expect(subtreeTickets(tree, "ghost")).toEqual([]);
    expect(subtreeTickets([], "epic")).toEqual([]);
  });

  it("visits each node once when a cycle is explicitly rooted", () => {
    const cycle = [t("a", "b", 1), t("b", "a", 1)];
    expect(ids(subtreeTickets(cycle, "a"))).toEqual(["a", "b"]);
  });
});

describe("sub-ticket-rollup: rollupPoints", () => {
  it("sums the whole subtree including the root", () => {
    expect(rollupPoints(tree)).toBe(19);
    expect(rollupPoints(tree, "epic")).toBe(19);
    expect(rollupPoints(tree, "story-a")).toBe(6);
    expect(rollupPoints(tree, "task-a1")).toBe(1);
  });

  it("ignores null/NaN estimates and returns 0 for an unknown root", () => {
    const scoped = [t("a", null, 2), t("b", null, null), t("c", null, Number.NaN)];
    expect(rollupPoints(scoped)).toBe(2);
    expect(rollupPoints(tree, "ghost")).toBe(0);
    expect(rollupPoints([])).toBe(0);
  });

  it("rounds floating-point noise to 2 decimals", () => {
    expect(rollupPoints([t("a", null, 0.1), t("b", null, 0.2)])).toBe(0.3);
  });
});

describe("sub-ticket-rollup: rollupEstimate", () => {
  it("rolls up total, remaining (open only), count, done and open", () => {
    expect(rollupEstimate(tree, "epic")).toEqual({
      rootId: "epic",
      total: 19,
      remaining: 13,
      count: 5,
      done: 2,
      open: 3,
    });
  });

  it("echoes a null root for the whole set and zeroes an unknown root", () => {
    expect(rollupEstimate(tree).rootId).toBe(null);
    expect(rollupEstimate(tree).total).toBe(19);
    expect(rollupEstimate(tree, "ghost")).toEqual({
      rootId: "ghost",
      total: 0,
      remaining: 0,
      count: 0,
      done: 0,
      open: 0,
    });
  });

  it("keeps remaining at 0 when every ticket is closed", () => {
    const closed = [t("a", null, 3, { state: "done" }), t("b", null, 2, { done: true })];
    expect(rollupEstimate(closed)).toMatchObject({ total: 5, remaining: 0, done: 2, open: 0 });
  });
});

describe("sub-ticket-rollup: progressOf", () => {
  it("reports done / total with a rounded percentage", () => {
    expect(progressOf(tree)).toEqual({ total: 5, done: 2, open: 3, percent: 40 });
  });

  it("returns 0% for empty input", () => {
    expect(progressOf([])).toEqual({ total: 0, done: 0, open: 0, percent: 0 });
  });

  it("counts cancelled tickets as done", () => {
    const mixed = [t("a", null, 1, { state: "cancelled" }), t("b", null, 1)];
    expect(progressOf(mixed)).toMatchObject({ done: 1, open: 1, percent: 50 });
  });
});

describe("sub-ticket-rollup: rollupByAssignee", () => {
  it("groups the subtree per assignee with total points and open remainder", () => {
    const buckets = rollupByAssignee(tree, "epic");
    expect(buckets.map((bucket) => bucket.assigneeId)).toEqual(["ana", "bo"]);
    expect(buckets[0]).toEqual({
      assigneeId: "ana",
      count: 3,
      open: 2,
      points: 16,
      remaining: 11,
    });
    expect(buckets[1]).toEqual({ assigneeId: "bo", count: 2, open: 1, points: 3, remaining: 2 });
  });

  it("buckets blank/missing assignees under UNASSIGNED and breaks ties by id", () => {
    const tickets = [
      t("a", null, 3, { assigneeId: "  " }),
      t("b", null, 2),
      t("c", null, 5, { assigneeId: "zoe" }),
      t("d", null, 1, { assigneeId: "amy" }),
      t("e", null, 4, { assigneeId: "zoe" }),
    ];
    const buckets = rollupByAssignee(tickets);
    expect(buckets.map((bucket) => bucket.assigneeId)).toEqual(["zoe", UNASSIGNED_BUCKET, "amy"]);
    expect(buckets[1]).toMatchObject({ count: 2, points: 5, open: 2, remaining: 5 });
  });

  it("returns an empty list for an empty or unknown scope", () => {
    expect(rollupByAssignee([])).toEqual([]);
    expect(rollupByAssignee(tree, "ghost")).toEqual([]);
  });
});

describe("sub-ticket-rollup: validateTicketTree", () => {
  it("accepts a well-formed forest and empty input", () => {
    expect(validateTicketTree(tree)).toEqual([]);
    expect(validateTicketTree([])).toEqual([]);
  });

  it("flags self-parenting tickets", () => {
    expect(validateTicketTree([t("a", "a", 1)])).toEqual([{ kind: "self-parent", id: "a" }]);
  });

  it("flags tickets whose parent is not in the list", () => {
    expect(validateTicketTree([t("a", "ghost", 1)])).toEqual([
      { kind: "orphan", id: "a", parentId: "ghost" },
    ]);
  });

  it("reports a cycle with a concrete, closed path", () => {
    const issues = validateTicketTree([t("a", "b"), t("b", "c"), t("c", "a")]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("cycle");
    const issue = issues[0];
    if (issue.kind === "cycle") {
      expect(issue.path).toEqual(["a", "b", "c", "a"]);
      expect(issue.path[0]).toBe(issue.path[issue.path.length - 1]);
    }
  });

  it("detects two-node cycles once and never throws on malformed input", () => {
    const twoNode = validateTicketTree([t("x", "y"), t("y", "x")]);
    expect(twoNode).toHaveLength(1);
    expect(twoNode[0].kind).toBe("cycle");

    const malformed = [t("a", "a"), t("b", "ghost"), t("c", "b")];
    expect(() => validateTicketTree(malformed)).not.toThrow();
    expect(validateTicketTree(malformed).map((issue) => issue.kind)).toEqual([
      "self-parent",
      "orphan",
    ]);
  });
});

describe("sub-ticket-rollup: purity and edge input", () => {
  it("never mutates the caller's tickets", () => {
    const snapshot = JSON.stringify(tree);
    buildTicketTree(tree);
    subtreeTickets(tree, "epic");
    rollupPoints(tree);
    rollupEstimate(tree);
    progressOf(tree);
    rollupByAssignee(tree);
    validateTicketTree(tree);
    expect(JSON.stringify(tree)).toBe(snapshot);
  });

  it("handles empty inputs across the API without throwing", () => {
    expect(buildTicketTree([])).toEqual([]);
    expect(subtreeTickets([], "a")).toEqual([]);
    expect(rollupPoints([])).toBe(0);
    expect(rollupEstimate([]).count).toBe(0);
    expect(progressOf([]).percent).toBe(0);
    expect(rollupByAssignee([])).toEqual([]);
    expect(validateTicketTree([])).toEqual([]);
  });
});

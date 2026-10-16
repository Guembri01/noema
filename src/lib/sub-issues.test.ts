import { describe, expect, it } from "vitest";
import {
  buildSubIssueTree,
  canMoveSubIssue,
  childProgress,
  criticalPath,
  dependencyTree,
  describeRollup,
  flattenTree,
  moveSubIssue,
  rollupEstimates,
  type SubIssueRow,
} from "@/lib/sub-issues";

/**
 * docs/specs/database-deep.md R89.30 (sub-items / sub-tasks) + R89.31
 * (dependencies + timeline arrows): the pure engine behind nested sub-issue
 * trees, estimate roll-ups, depth-capped reparenting and the blocking graph.
 *
 * Red-first: `src/lib/sub-issues.ts` does not exist when this file was written,
 * so every test fails on the missing module until the pure kernel lands.
 * Everything here is data in / data out — no DB, no routes, no React — and no
 * operation may mutate its input.
 */

type Row = {
  id: string;
  parentId: string | null;
  order?: number;
  estimate?: number;
  done?: boolean;
  points?: number;
  closed?: boolean;
  dependsOn?: string | null;
  seq?: number;
};

const r = (
  id: string,
  parentId: string | null = null,
  order?: number,
  extra: Partial<Row> = {},
): SubIssueRow => ({
  id,
  parentId,
  ...(order === undefined ? {} : { order }),
  ...extra,
});

const ids = (rows: readonly { row?: unknown; id?: string }[]): string[] =>
  rows.map((entry) => (entry.id ?? "").toString());

const snapshot = (rows: readonly SubIssueRow[]): string => JSON.stringify(rows);

/** Stored out of order on purpose: `b1x` sits two levels under `b`. */
const forest: SubIssueRow[] = [
  r("b2", "b", 2000),
  r("a", null, 1000),
  r("b1x", "b1", 1000),
  r("c", null, 3000),
  r("b", null, 2000),
  r("b1", "b", 1000),
];

describe("sub-issues: buildSubIssueTree", () => {
  it("nests rows under their parents with roots in `order` order", () => {
    const { tree, orphans, cycles } = buildSubIssueTree(forest, { maxDepth: 2 });
    expect(ids(tree)).toEqual(["a", "b", "c"]);
    const b = tree[1];
    expect(ids(b.children)).toEqual(["b1", "b2"]);
    expect(ids(b.children[0].children)).toEqual(["b1x"]);
    expect(orphans).toEqual([]);
    expect(cycles).toEqual([]);
  });

  it("attaches nodes at their computed depth (roots = 0)", () => {
    const { tree } = buildSubIssueTree(forest, { maxDepth: 2 });
    expect(tree[0].depth).toBe(0);
    expect(tree[1].children[0].depth).toBe(1);
    expect(tree[1].children[0].children[0].depth).toBe(2);
  });

  it("defaults `maxDepth` to 1, folding deeper rows into orphans", () => {
    const { tree, orphans } = buildSubIssueTree(forest);
    expect(ids(tree)).toEqual(["a", "b", "c"]);
    expect(ids(tree[1].children)).toEqual(["b1", "b2"]);
    expect(ids(orphans)).toEqual(["b1x"]);
  });

  it("maxDepth 0 keeps only the roots", () => {
    const { tree, orphans } = buildSubIssueTree(forest, { maxDepth: 0 });
    expect(ids(tree)).toEqual(["a", "b", "c"]);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
    expect(ids(orphans).sort()).toEqual(["b1", "b1x", "b2"]);
  });

  it("honours custom parent/order keys", () => {
    const rows = [
      { id: "x", dependsOn: null, seq: 2 },
      { id: "y", dependsOn: "x", seq: 1 },
      { id: "z", dependsOn: null, seq: 1 },
    ];
    const { tree } = buildSubIssueTree(rows, {
      parentKey: "dependsOn",
      orderKey: "seq",
      maxDepth: 2,
    });
    expect(ids(tree)).toEqual(["z", "x"]);
    expect(ids(tree[1].children)).toEqual(["y"]);
  });

  it("orders siblings by `order` and keeps input order for ties", () => {
    const rows = [r("y", null, 1000), r("x", null, 1000), r("z", null, 500)];
    const { tree } = buildSubIssueTree(rows, { maxDepth: 2 });
    expect(ids(tree)).toEqual(["z", "y", "x"]);
  });

  it("reports rows with an unknown parent as orphans", () => {
    const rows = [r("z", "ghost"), r("a", null)];
    const { tree, orphans, cycles } = buildSubIssueTree(rows, { maxDepth: 2 });
    expect(ids(tree)).toEqual(["a"]);
    expect(ids(orphans)).toEqual(["z"]);
    expect(cycles).toEqual([]);
  });

  it("reports a parent cycle as a concrete closed path and omits it", () => {
    const rows = [r("a", "b"), r("b", "a")];
    const { tree, orphans, cycles } = buildSubIssueTree(rows, { maxDepth: 2 });
    expect(tree).toEqual([]);
    expect(orphans).toEqual([]);
    expect(cycles).toEqual([["a", "b", "a"]]);
  });

  it("treats a self-parent as a one-row cycle", () => {
    const { cycles, orphans } = buildSubIssueTree([r("s", "s")], { maxDepth: 2 });
    expect(cycles).toEqual([["s", "s"]]);
    expect(orphans).toEqual([]);
  });

  it("orphans rows left dangling below a cycle", () => {
    const rows = [r("a", "b"), r("b", "a"), r("d", "a")];
    const { orphans, cycles } = buildSubIssueTree(rows, { maxDepth: 2 });
    expect(cycles).toEqual([["a", "b", "a"]]);
    expect(ids(orphans)).toEqual(["d"]);
  });

  it("does not mutate the input rows", () => {
    const before = snapshot(forest);
    buildSubIssueTree(forest, { maxDepth: 2 });
    expect(snapshot(forest)).toBe(before);
  });

  it("never throws on malformed data", () => {
    expect(() => buildSubIssueTree([r("a", "a"), r("b", "ghost")])).not.toThrow();
    expect(buildSubIssueTree([]).tree).toEqual([]);
  });
});

describe("sub-issues: flattenTree", () => {
  const { tree } = buildSubIssueTree(forest, { maxDepth: 2 });

  it("emits visible rows depth-first with their depth", () => {
    const rows = flattenTree(tree);
    expect(ids(rows)).toEqual(["a", "b", "b1", "b1x", "b2", "c"]);
    expect(rows.map((entry) => entry.depth)).toEqual([0, 0, 1, 2, 1, 0]);
  });

  it("records parent ids and whether a row has children", () => {
    const rows = flattenTree(tree);
    expect(rows.map((entry) => entry.parentId)).toEqual([null, null, "b", "b1", "b", null]);
    expect(rows.find((entry) => entry.id === "b")?.hasChildren).toBe(true);
    expect(rows.find((entry) => entry.id === "a")?.hasChildren).toBe(false);
  });

  it("hides the descendants of a collapsed row but keeps the row itself", () => {
    const rows = flattenTree(tree, { collapsedIds: ["b"] });
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(rows.find((entry) => entry.id === "b")?.collapsed).toBe(true);
  });

  it("accepts a Set of collapsed ids and defaults to nothing collapsed", () => {
    expect(ids(flattenTree(tree, { collapsedIds: new Set(["b", "b1"]) }))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(ids(flattenTree(tree)).length).toBe(6);
  });

  it("returns an empty list for an empty tree", () => {
    expect(flattenTree([])).toEqual([]);
  });
});

describe("sub-issues: rollupEstimates", () => {
  const rows: SubIssueRow[] = [
    r("epic", null, 1000, { estimate: 8, done: false }),
    r("s1", "epic", 1000, { estimate: 3, done: true }),
    r("s2", "epic", 2000, { estimate: 5, done: false }),
  ];
  const { tree } = buildSubIssueTree(rows, { maxDepth: 2 });

  it("computes own, childrenTotal and total per node", () => {
    const rollup = rollupEstimates(tree);
    const epic = rollup.get("epic");
    expect(epic).toBeDefined();
    expect(epic?.own).toBe(8);
    expect(epic?.childrenTotal).toBe(8);
    expect(epic?.total).toBe(16);
  });

  it("counts done nodes and progress over the whole subtree", () => {
    const rollup = rollupEstimates(tree);
    expect(rollup.get("epic")?.done).toBe(1);
    expect(rollup.get("epic")?.count).toBe(3);
    expect(rollup.get("epic")?.progress).toBeCloseTo(1 / 3, 4);
  });

  it("rolls leaves up as own === total", () => {
    const rollup = rollupEstimates(tree);
    expect(rollup.get("s1")).toMatchObject({
      own: 3,
      childrenTotal: 0,
      total: 3,
      done: 1,
      count: 1,
      progress: 1,
    });
    expect(rollup.get("s2")).toMatchObject({ total: 5, done: 0, progress: 0 });
  });

  it("counts missing or non-finite estimates as 0", () => {
    const messy: SubIssueRow[] = [
      r("p", null, 1000, { estimate: Number.NaN }),
      r("k", "p", 1000),
    ];
    const built = buildSubIssueTree(messy, { maxDepth: 2 });
    const rollup = rollupEstimates(built.tree);
    expect(rollup.get("p")?.total).toBe(0);
    expect(rollup.get("p")?.own).toBe(0);
  });

  it("honours custom estimate/done keys", () => {
    const custom: SubIssueRow[] = [
      r("p", null, 1000, { points: 4 }),
      r("k", "p", 1000, { points: 6, closed: true }),
    ];
    const built = buildSubIssueTree(custom, { maxDepth: 2 });
    const rollup = rollupEstimates(built.tree, { estimateKey: "points", doneKey: "closed" });
    expect(rollup.get("p")).toMatchObject({ own: 4, childrenTotal: 6, total: 10, done: 1 });
  });

  it("keys the result by row id", () => {
    const rollup = rollupEstimates(tree);
    expect([...rollup.keys()].sort()).toEqual(["epic", "s1", "s2"]);
  });
});

describe("sub-issues: childProgress", () => {
  const rows: SubIssueRow[] = [
    r("epic", null, 1000, { done: true }),
    r("s1", "epic", 1000, { done: true }),
    r("s2", "epic", 2000, { done: false }),
    r("s2a", "s2", 1000, { done: true }),
  ];
  const { tree } = buildSubIssueTree(rows, { maxDepth: 3 });

  it("measures progress over the descendants only, excluding the node", () => {
    expect(childProgress(tree[0])).toEqual({ done: 2, count: 3, progress: 0.6667 });
  });

  it("returns zero for a leaf even when the leaf itself is done", () => {
    const s1 = tree[0].children[0];
    expect(childProgress(s1)).toEqual({ done: 0, count: 0, progress: 0 });
  });

  it("counts grandchildren", () => {
    const s2 = tree[0].children[1];
    expect(childProgress(s2)).toEqual({ done: 1, count: 1, progress: 1 });
  });
});

describe("sub-issues: canMoveSubIssue", () => {
  it("rejects an unknown id", () => {
    expect(canMoveSubIssue(forest, "nope", { toParentId: "b" })).toEqual({
      ok: false,
      reason: "unknown-id",
    });
  });

  it("rejects an unknown target parent", () => {
    expect(canMoveSubIssue(forest, "a", { toParentId: "ghost" })).toEqual({
      ok: false,
      reason: "unknown-parent",
    });
  });

  it("rejects self-parenting", () => {
    expect(canMoveSubIssue(forest, "b", { toParentId: "b" })).toEqual({
      ok: false,
      reason: "self-parent",
    });
  });

  it("rejects a move that would close a cycle", () => {
    expect(canMoveSubIssue(forest, "b", { toParentId: "b1", maxDepth: 2 })).toEqual({
      ok: false,
      reason: "cycle",
    });
  });

  it("rejects a move that would exceed the depth cap", () => {
    const rows = [r("p", null, 1000), r("c", "p", 1000), r("gc", "c", 1000), r("q", null, 2000)];
    expect(canMoveSubIssue(rows, "p", { toParentId: "q", maxDepth: 2 })).toEqual({
      ok: false,
      reason: "depth",
    });
  });

  it("allows a move that stays inside the cap", () => {
    const rows = [r("p", null, 1000), r("c", "p", 1000), r("q", null, 2000)];
    expect(canMoveSubIssue(rows, "p", { toParentId: "q", maxDepth: 2 })).toEqual({ ok: true });
  });

  it("allows promoting a row to the top level", () => {
    expect(canMoveSubIssue(forest, "b1", { toParentId: null })).toEqual({ ok: true });
  });
});

describe("sub-issues: moveSubIssue", () => {
  it("returns the input reference unchanged on a rejected move", () => {
    expect(moveSubIssue(forest, "nope", { toParentId: "b" })).toBe(forest);
    expect(moveSubIssue(forest, "b", { toParentId: "b1", maxDepth: 2 })).toBe(forest);
  });

  it("reparents a row and renumbers the destination siblings around `index`", () => {
    const rows = [
      r("p", null, 1000),
      r("x", "p", 1000),
      r("y", "p", 2000),
      r("z", null, 2000),
    ];
    const moved = moveSubIssue(rows, "z", { toParentId: "p", index: 1 });
    const byId = new Map(moved.map((row) => [row.id, row] as const));
    expect(byId.get("z")).toMatchObject({ parentId: "p", order: 2000 });
    expect(byId.get("x")).toMatchObject({ order: 1000 });
    expect(byId.get("y")).toMatchObject({ order: 3000 });
  });

  it("appends after the existing children when `index` is omitted", () => {
    const rows = [r("p", null, 1000), r("x", "p", 1000), r("z", null, 2000)];
    const moved = moveSubIssue(rows, "z", { toParentId: "p" });
    const z = moved.find((row) => row.id === "z");
    expect(z).toMatchObject({ parentId: "p", order: 2000 });
  });

  it("clamps an out-of-range index", () => {
    const rows = [r("p", null, 1000), r("x", "p", 1000), r("z", null, 2000)];
    const moved = moveSubIssue(rows, "z", { toParentId: "p", index: 99 });
    expect(moved.find((row) => row.id === "z")).toMatchObject({ parentId: "p", order: 2000 });
  });

  it("promotes a row to the top level, appending it among the roots", () => {
    const rows = [r("a", null, 1000), r("b", null, 2000), r("c", "a", 1000)];
    const moved = moveSubIssue(rows, "c", { toParentId: null });
    expect(moved.find((row) => row.id === "c")).toMatchObject({ parentId: null, order: 3000 });
  });

  it("does not mutate the input rows", () => {
    const before = snapshot(forest);
    moveSubIssue(forest, "b1", { toParentId: "c" });
    expect(snapshot(forest)).toBe(before);
  });
});

describe("sub-issues: dependencyTree", () => {
  const edges = [
    { blockerId: "a", blockedId: "b" },
    { blockerId: "b", blockedId: "c" },
    { blockerId: "d", blockedId: "c" },
  ];

  it("records direct blockers and dependents", () => {
    const { nodes } = dependencyTree(edges);
    expect(nodes.get("a")).toEqual({ id: "a", blockedBy: [], blocks: ["b", "c"] });
    expect(nodes.get("b")).toEqual({ id: "b", blockedBy: ["a"], blocks: ["c"] });
  });

  it("computes transitive blocked-by/blocks closures, ascending", () => {
    const { nodes } = dependencyTree(edges);
    expect(nodes.get("c")?.blockedBy).toEqual(["a", "b", "d"]);
    expect(nodes.get("c")?.blocks).toEqual([]);
  });

  it("registers ids that only appear on one side of an edge", () => {
    const { nodes } = dependencyTree([{ blockerId: "x", blockedId: "y" }]);
    expect([...nodes.keys()].sort()).toEqual(["x", "y"]);
    expect(nodes.get("x")?.blocks).toEqual(["y"]);
    expect(nodes.get("y")?.blockedBy).toEqual(["x"]);
  });

  it("reports a blocking cycle as a closed path", () => {
    const { cycles } = dependencyTree([
      { blockerId: "a", blockedId: "b" },
      { blockerId: "b", blockedId: "c" },
      { blockerId: "c", blockedId: "a" },
    ]);
    expect(cycles).toEqual([["a", "b", "c", "a"]]);
  });

  it("treats a self-edge as a one-row cycle and excludes it from the closure", () => {
    const { nodes, cycles } = dependencyTree([{ blockerId: "a", blockedId: "a" }]);
    expect(cycles).toEqual([["a", "a"]]);
    expect(nodes.get("a")).toEqual({ id: "a", blockedBy: [], blocks: [] });
  });

  it("returns empty structures for no edges", () => {
    const { nodes, cycles } = dependencyTree([]);
    expect(nodes.size).toBe(0);
    expect(cycles).toEqual([]);
  });
});

describe("sub-issues: criticalPath", () => {
  it("finds the longest weighted path across a DAG", () => {
    const nodes = [
      { id: "a", weight: 1 },
      { id: "b", weight: 5 },
      { id: "c", weight: 2 },
      { id: "d", weight: 1 },
    ];
    const edges = [
      { blockerId: "a", blockedId: "b" },
      { blockerId: "b", blockedId: "c" },
      { blockerId: "a", blockedId: "d" },
    ];
    expect(criticalPath(nodes, edges)).toEqual({ ok: true, path: ["a", "b", "c"], weight: 8 });
  });

  it("defaults each node weight to 1 (longest chain in rows)", () => {
    const edges = [
      { blockerId: "a", blockedId: "b" },
      { blockerId: "b", blockedId: "c" },
    ];
    expect(criticalPath([{ id: "a" }, { id: "c" }], edges)).toEqual({
      ok: true,
      path: ["a", "b", "c"],
      weight: 3,
    });
  });

  it("breaks ties deterministically toward the smaller id", () => {
    const nodes = [
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
      { id: "c", weight: 1 },
    ];
    const edges = [
      { blockerId: "a", blockedId: "b" },
      { blockerId: "a", blockedId: "c" },
    ];
    expect(criticalPath(nodes, edges)).toEqual({ ok: true, path: ["a", "b"], weight: 2 });
  });

  it("returns a cycle instead of a path for a cyclic graph", () => {
    const result = criticalPath([], [
      { blockerId: "a", blockedId: "b" },
      { blockerId: "b", blockedId: "a" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cycle).toEqual(["a", "b", "a"]);
  });

  it("handles the empty graph and a single node", () => {
    expect(criticalPath([], [])).toEqual({ ok: true, path: [], weight: 0 });
    expect(criticalPath([{ id: "s" }], [])).toEqual({ ok: true, path: ["s"], weight: 1 });
  });
});

describe("sub-issues: describeRollup", () => {
  it("formats counts, percentage and total points", () => {
    expect(
      describeRollup({ id: "epic", own: 3, childrenTotal: 5, total: 8, done: 1, count: 2, progress: 0.5 }),
    ).toBe("1/2 done (50%), 8 pts");
  });

  it("rounds the percentage", () => {
    expect(
      describeRollup({ id: "e", own: 0, childrenTotal: 0, total: 0, done: 1, count: 3, progress: 1 / 3 }),
    ).toBe("1/3 done (33%), 0 pts");
  });

  it("handles an empty roll-up", () => {
    expect(
      describeRollup({ id: "e", own: 0, childrenTotal: 0, total: 0, done: 0, count: 0, progress: 0 }),
    ).toBe("0/0 done (0%), 0 pts");
  });
});

import { describe, expect, it } from "vitest";
import type { PageTreeNode } from "@/server/queries";
import {
  flattenVisible,
  groupByParent,
  moveCandidates,
  toggleExpanded,
  visibleChildren,
} from "@/lib/page-tree";

/**
 * B66 - page-tree large-tree tests + expand-state robustness.
 *
 * Red-first: `src/lib/page-tree.ts` did not exist when this file was written,
 * so the whole suite fails on the missing module until the helpers land. The
 * helpers are the pure half of `src/components/sidebar/page-tree.tsx`: they
 * decide which rows render, at what depth, which "Move to" targets exist and
 * how the expanded set changes — all provable without a DOM or the DB.
 *
 * Fixtures are synthetic 1000-node trees generated in-test (no prisma).
 */

const node = (
  id: string,
  parentId: string | null,
  teamspaceId: string | null = null,
): PageTreeNode => ({
  id,
  parentId,
  teamspaceId,
  title: `Page ${id}`,
  icon: null,
  type: "PAGE",
  position: 0,
  isFavorite: false,
});

/**
 * Synthetic large tree (~1000 nodes), deterministic:
 * - 10 roots: p0/p3/p6/p9 private, p1/p4/p7 -> ts-a, p2/p5/p8 -> ts-b;
 * - a 100-level chain under p0 (p10 -> p11 -> ... -> p109, depth 1..100);
 * - the remaining nodes fan out under p0..p109 (mixed depths).
 * Every node id is unique with a single parent, like the DB rows.
 */
function buildLargeTree(count = 1000): PageTreeNode[] {
  const nodes: PageTreeNode[] = [];
  const mk = (id: string, parentId: string | null, teamspaceId: string | null) =>
    nodes.push(node(id, parentId, teamspaceId));
  for (let i = 0; i < 10; i++) {
    mk(`p${i}`, null, i % 3 === 0 ? null : i % 3 === 1 ? "ts-a" : "ts-b");
  }
  for (let i = 10; i < 110; i++) {
    mk(`p${i}`, i === 10 ? "p0" : `p${i - 1}`, null);
  }
  for (let i = 110; i < count; i++) {
    mk(`p${i}`, `p${(i * 7) % 110}`, null);
  }
  return nodes;
}

/** Independent oracle: ids reachable from `seeds` following child links (DFS). */
function reach(tree: PageTreeNode[], seeds: Iterable<string>): Set<string> {
  const kids = new Map<string | null, string[]>();
  for (const n of tree) {
    const list = kids.get(n.parentId) ?? [];
    list.push(n.id);
    kids.set(n.parentId, list);
  }
  const seen = new Set<string>(seeds);
  const stack = [...seen];
  while (stack.length > 0) {
    for (const child of kids.get(stack.pop()!) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }
  return seen;
}

const ids = (rows: { node: PageTreeNode }[]) => rows.map((r) => r.node.id);

describe("groupByParent", () => {
  it("groups roots under null and children under their parent, keeping input order", () => {
    const tree = [node("a", null), node("b", "a"), node("c", null), node("d", "b")];
    const byParent = groupByParent(tree);
    expect((byParent.get(null) ?? []).map((n) => n.id)).toEqual(["a", "c"]);
    expect((byParent.get("a") ?? []).map((n) => n.id)).toEqual(["b"]);
    expect((byParent.get("b") ?? []).map((n) => n.id)).toEqual(["d"]);
    expect(byParent.has("d")).toBe(false);
  });

  it("partitions the tree exactly (sum of group sizes === tree length) on 1000 nodes", () => {
    const tree = buildLargeTree();
    const byParent = groupByParent(tree);
    let total = 0;
    for (const group of byParent.values()) total += group.length;
    expect(total).toBe(tree.length);
    // deep chain: p10 hangs off p0, and every chain node keeps its chain child
    expect((byParent.get("p0") ?? []).map((n) => n.id)).toContain("p10");
    for (let i = 10; i < 109; i++) {
      expect((byParent.get(`p${i}`) ?? []).map((n) => n.id)).toContain(`p${i + 1}`);
    }
  });

  it("is stable under a 100-level deep chain (no group is dropped or merged)", () => {
    const tree: PageTreeNode[] = [];
    for (let i = 0; i < 100; i++) {
      tree.push(node(`n${i}`, i === 0 ? null : `n${i - 1}`));
    }
    const byParent = groupByParent(tree);
    expect(byParent.get(null)).toHaveLength(1);
    for (let i = 0; i < 99; i++) {
      expect((byParent.get(`n${i}`) ?? []).map((n) => n.id)).toEqual([`n${i + 1}`]);
    }
  });
});

describe("visibleChildren", () => {
  it("applies the root filter only at root level (children never filtered)", () => {
    const tree = [node("r", null, "ts-a"), node("kiddo", "r"), node("other", null)];
    const byParent = groupByParent(tree);
    const filter = (n: PageTreeNode) => n.teamspaceId === "ts-a";
    expect((visibleChildren(byParent, null, filter) ?? []).map((n) => n.id)).toEqual(["r"]);
    // filter is irrelevant below the root level - children of a shown root always render
    expect((visibleChildren(byParent, "r", filter) ?? []).map((n) => n.id)).toEqual(["kiddo"]);
  });

  it("returns an empty list for unknown parents instead of throwing", () => {
    const byParent = groupByParent([node("a", null)]);
    expect(visibleChildren(byParent, "missing")).toEqual([]);
    expect(visibleChildren(byParent, null)).toHaveLength(1);
  });
});

describe("flattenVisible (render plan)", () => {
  it("with nothing expanded, renders only the roots at depth 0", () => {
    const tree = buildLargeTree();
    const plan = flattenVisible(tree, new Set());
    expect(plan).toHaveLength(10);
    expect(plan.every((r) => r.depth === 0)).toBe(true);
    expect(ids(plan)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
  });

  it("walks a deep chain in pre-order with contiguous depths", () => {
    const tree: PageTreeNode[] = [];
    for (let i = 0; i < 5; i++) {
      tree.push(node(`n${i}`, i === 0 ? null : `n${i - 1}`));
    }
    const plan = flattenVisible(tree, new Set(["n0", "n1", "n2", "n3"]));
    expect(plan.map((r) => `${r.node.id}@${r.depth}`)).toEqual([
      "n0@0",
      "n1@1",
      "n2@2",
      "n3@3",
      "n4@4",
    ]);
  });

  it("never shows a child of a collapsed parent, even when its id is in the expanded set", () => {
    // expand state invariant: expanded is a superset of visible-open ids;
    // stale ids (collapsed ancestor) must simply not render.
    const tree = buildLargeTree();
    const plan = flattenVisible(tree, new Set(["p50"])); // p50's ancestors are all collapsed
    expect(plan.map((r) => r.node.id)).toEqual(
      ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"],
    );
  });

  it("on 1000 nodes fully expanded: every node visible, parent before child, depth = parent depth + 1", () => {
    const tree = buildLargeTree();
    const expanded = new Set(tree.map((n) => n.id));
    const plan = flattenVisible(tree, expanded);
    expect(plan).toHaveLength(tree.length);
    const depth = new Map<string, number>();
    const byId = new Map(tree.map((n) => [n.id, n]));
    for (const { node: n, depth: d } of plan) {
      if (n.parentId === null) {
        expect(d).toBe(0);
      } else {
        expect(d).toBe((depth.get(n.parentId) ?? -1000) + 1); // parent seen before child
      }
      depth.set(n.id, d);
      expect(byId.get(n.id)).toBe(n); // plan carries the actual tree rows
    }
    // the 100-level chain under p0 reaches depth 100; fan children add one more
    expect(Math.max(...depth.values())).toBe(101);
  });

  it("root filters partition the roots and pull in exactly their subtrees", () => {
    const tree = buildLargeTree();
    const expanded = new Set(tree.map((n) => n.id));
    const roots = tree.filter((n) => n.parentId === null);
    const pRootIds = roots.filter((n) => !n.teamspaceId).map((n) => n.id);
    const aRootIds = roots.filter((n) => n.teamspaceId === "ts-a").map((n) => n.id);
    const bRootIds = roots.filter((n) => n.teamspaceId === "ts-b").map((n) => n.id);
    expect(new Set([...pRootIds, ...aRootIds, ...bRootIds]).size).toBe(roots.length);

    const privatePlan = ids(flattenVisible(tree, expanded, (n) => !n.teamspaceId));
    const aPlan = ids(flattenVisible(tree, expanded, (n) => n.teamspaceId === "ts-a"));
    const bPlan = ids(flattenVisible(tree, expanded, (n) => n.teamspaceId === "ts-b"));

    // disjoint + covering: the three sidebar sections show every row exactly once
    expect(privatePlan.length + aPlan.length + bPlan.length).toBe(tree.length);
    expect(
      new Set([...privatePlan, ...aPlan, ...bPlan]).size,
    ).toBe(tree.length);

    const pSet = reach(tree, pRootIds);
    const aSet = reach(tree, aRootIds);
    const bSet = reach(tree, bRootIds);
    for (const id of privatePlan) expect(pSet.has(id)).toBe(true);
    for (const id of aPlan) expect(aSet.has(id)).toBe(true);
    for (const id of bPlan) expect(bSet.has(id)).toBe(true);
    // children of a hidden root never leak into another section
    expect(aPlan.some((id) => pSet.has(id))).toBe(false);
    expect(privatePlan.some((id) => aSet.has(id))).toBe(false);
  });

  it("never reaches an orphaned parent cycle (single-parent data cannot loop back to a root)", () => {
    // a <-> b point at each other; neither is reachable from a root, so the
    // walk must terminate with just the root instead of recursing forever.
    const tree = [node("r", null), node("a", "b"), node("b", "a")];
    const plan = flattenVisible(tree, new Set(["r", "a", "b"]));
    expect(ids(plan)).toEqual(["r"]);
  });

  it("rename-in-flight: a title change keeps ids/depths stable and is picked up on re-plan", () => {
    const tree = buildLargeTree();
    const expanded = new Set(tree.map((n) => n.id));
    const before = flattenVisible(tree, expanded).map((r) => `${r.node.id}@${r.depth}`);
    const renamed = tree.map((n) => (n.id === "p42" ? { ...n, title: "Renamed mid-flight" } : n));
    const after = flattenVisible(renamed, expanded);
    expect(after.map((r) => `${r.node.id}@${r.depth}`)).toEqual(before);
    expect(after.find((r) => r.node.id === "p42")?.node.title).toBe("Renamed mid-flight");
  });
});

describe("toggleExpanded", () => {
  it("adds an id then removes it, returning a new set each time", () => {
    const first = toggleExpanded(new Set(), "a");
    expect(first.has("a")).toBe(true);
    const second = toggleExpanded(first, "a");
    expect(second.has("a")).toBe(false);
    expect(first.has("a")).toBe(true); // input never mutated (React state invariant)
    expect(second).not.toBe(first);
  });

  it("round-trips a sequence back to the original contents", () => {
    const original = new Set(["x", "y"]);
    let next = toggleExpanded(original, "z"); // add
    next = toggleExpanded(next, "x"); // remove
    next = toggleExpanded(next, "x"); // re-add
    next = toggleExpanded(next, "z"); // remove again
    expect(new Set(next)).toEqual(new Set(["x", "y"]));
    expect(new Set(original)).toEqual(new Set(["x", "y"])); // input never mutated
  });

  it("toggling one id never disturbs the others (1000 ids)", () => {
    const tree = buildLargeTree();
    let expanded = new Set<string>();
    for (const n of tree) expanded = toggleExpanded(expanded, n.id);
    expect(expanded.size).toBe(tree.length);
    expanded = toggleExpanded(expanded, "p500");
    expect(expanded.size).toBe(tree.length - 1);
    expect(expanded.has("p500")).toBe(false);
    for (const n of tree) if (n.id !== "p500") expect(expanded.has(n.id)).toBe(true);
    for (const n of tree) if (n.id !== "p500") expanded = toggleExpanded(expanded, n.id);
    expect(expanded.size).toBe(0);
  });
});

describe("moveCandidates", () => {
  it("never offers a descendant as a target (cycle guard - regression net)", () => {
    const tree = buildLargeTree();
    const root = tree.find((n) => n.id === "p0")!;
    const blocked = reach(tree, ["p0"]);
    const candidates = moveCandidates(tree, root);
    for (const candidate of candidates) {
      expect(blocked.has(candidate.id)).toBe(false); // self + every descendant excluded
    }
    expect(candidates.some((c) => c.id === "p0")).toBe(false);
    expect(candidates.some((c) => c.id === "p109")).toBe(false); // deepest chain node
    expect(blocked.has("p999")).toBe(true); // fan node under p0's chain
    expect(candidates.some((c) => c.id === "p999")).toBe(false);
  });

  it("blocks descendants even when they appear BEFORE their ancestor in the array", () => {
    // naive single-pass filters miss this; the fix-point loop must catch it
    const tree = [node("deep", "mid"), node("mid", "top"), node("top", null), node("other", null)];
    const candidates = moveCandidates(tree, tree.find((n) => n.id === "top")!);
    expect(candidates.map((n) => n.id)).toEqual(["other"]);
  });

  it("blocks descendants at every depth, not just the first level", () => {
    const tree = [
      node("top", null),
      node("d1", "top"),
      node("d2", "d1"),
      node("d3", "d2"),
      node("other", null),
    ];
    expect(moveCandidates(tree, tree[0]).map((n) => n.id)).toEqual(["other"]);
  });

  it("allows the current parent and unrelated branches", () => {
    const tree = [node("a", null), node("a1", "a"), node("a11", "a1"), node("b", null)];
    expect(moveCandidates(tree, tree.find((n) => n.id === "a1")!).map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
    expect(moveCandidates(tree, tree.find((n) => n.id === "a")!).map((n) => n.id)).toEqual(["b"]);
  });

  it("caps the menu at 12 targets while preserving tree order", () => {
    const tree = buildLargeTree();
    const candidates = moveCandidates(tree, tree.find((n) => n.id === "p7")!);
    expect(candidates).toHaveLength(12);
    const positions = candidates.map((c) => tree.findIndex((n) => n.id === c.id));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // p7's siblings/roots come first; nothing from p7's own subtree leaks in
    expect(candidates.some((c) => reach(tree, ["p7"]).has(c.id))).toBe(false);
  });
});

describe("perf smoke (pure, no DOM)", () => {
  it("generates the 1000-node render plan in well under 100 ms", () => {
    const tree = buildLargeTree(1000);
    const expanded = new Set(tree.map((n) => n.id));
    const started = performance.now();
    const plan = flattenVisible(tree, expanded);
    const elapsed = performance.now() - started;
    expect(plan).toHaveLength(1000);
    expect(elapsed).toBeLessThan(100);
  });

  it("moveCandidates + grouping on 1000 nodes each stay under 100 ms", () => {
    const tree = buildLargeTree(1000);
    const started = performance.now();
    const byParent = groupByParent(tree);
    const candidates = moveCandidates(tree, tree.find((n) => n.id === "p0")!);
    const elapsed = performance.now() - started;
    expect(byParent.size).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(12);
    expect(elapsed).toBeLessThan(100);
  });
});

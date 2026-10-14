import { describe, expect, it } from "vitest";
import type { PageTreeNode } from "@/server/queries";
import {
  ancestryOf,
  canReparent,
  collectSubtree,
  flattenTree,
  flattenVisible,
  groupByParent,
  moveCandidates,
  movePage,
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
 *
 * Red-first round two (MISSING_FEATURES §9): the `canReparent` / `movePage` /
 * `ancestryOf` / `flattenTree` / `collectSubtree` describes below were written
 * against exports that did not exist yet (TS2305 + runtime failures), then the
 * pure operations landed in `src/lib/page-tree.ts` until everything went green.
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

/** Move/ancestry fixture: `top -> mid -> leaf -> deep` plus an unrelated root. */
const familyTree = (): PageTreeNode[] => [
  node("top", null),
  node("mid", "top"),
  node("leaf", "mid"),
  node("deep", "leaf"),
  node("other", null),
];

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

describe("canReparent (cycle-safe reparent guard)", () => {
  it("allows an unrelated target, the current parent and the top level", () => {
    const tree = familyTree();
    expect(canReparent(tree, "mid", "other")).toBe(true);
    expect(canReparent(tree, "mid", "top")).toBe(true); // current parent (no-op reparent)
    expect(canReparent(tree, "mid", null)).toBe(true); // move to top level
    expect(canReparent(tree, "top", null)).toBe(true);
  });

  it("rejects moving a page under itself", () => {
    const tree = familyTree();
    expect(canReparent(tree, "top", "top")).toBe(false);
    expect(canReparent(tree, "mid", "mid")).toBe(false);
    expect(movePage(tree, "mid", "mid")).toBeNull();
  });

  it("rejects moving a page under a deep descendant (cycle guard)", () => {
    const tree = familyTree();
    for (const descendant of ["mid", "leaf", "deep"]) {
      expect(canReparent(tree, "top", descendant)).toBe(false);
      expect(movePage(tree, "top", descendant)).toBeNull();
    }
    expect(canReparent(tree, "mid", "deep")).toBe(false);
    expect(canReparent(tree, "leaf", "deep")).toBe(false);
    // `deep` is a leaf (no descendants of its own) — re-parenting it under its
    // current parent is a legal no-op, like any other existing parent.
    expect(canReparent(tree, "deep", "leaf")).toBe(true);
    expect(canReparent(tree, "deep", "top")).toBe(true); // its grandparent: also legal
    expect(canReparent(tree, "deep", "other")).toBe(true); // unrelated branch
  });

  it("rejects a missing page and a missing target", () => {
    const tree = familyTree();
    expect(canReparent(tree, "ghost", "other")).toBe(false);
    expect(canReparent(tree, "ghost", null)).toBe(false);
    expect(canReparent(tree, "mid", "ghost")).toBe(false);
    expect(movePage(tree, "ghost", "other")).toBeNull();
    expect(movePage(tree, "mid", "ghost")).toBeNull();
  });

  it("rejects a target whose lineage never reaches a root (orphan cycle)", () => {
    // a <-> b point at each other: the target's ancestry cannot be verified,
    // so the guard fails closed instead of guessing.
    const tree = [...familyTree(), node("a", "b"), node("b", "a")];
    expect(canReparent(tree, "top", "a")).toBe(false);
    expect(canReparent(tree, "top", "b")).toBe(false);
    expect(movePage(tree, "top", "a")).toBeNull();
  });

  it("rejects a target whose parent is missing from the list (partial tree)", () => {
    const tree = [...familyTree(), node("floating", "somewhere-else")];
    expect(canReparent(tree, "mid", "floating")).toBe(false);
  });

  it("holds on the 1000-node tree, deep descendants in both directions", () => {
    const tree = buildLargeTree();
    // p0 is an ancestor of p999 (fan node under p0's chain): that move cycles
    expect(canReparent(tree, "p0", "p999")).toBe(false);
    expect(movePage(tree, "p0", "p999")).toBeNull();
    expect(canReparent(tree, "p0", "p109")).toBe(false); // deepest chain node
    // ...while the reverse direction and unrelated roots are legal
    expect(canReparent(tree, "p999", "p0")).toBe(true);
    expect(canReparent(tree, "p0", "p7")).toBe(true);
    expect(canReparent(tree, "p109", "p7")).toBe(true);
  });
});

describe("movePage (pure reparent)", () => {
  it("reparents the page under a valid target and returns a NEW tree", () => {
    const tree = familyTree();
    const moved = movePage(tree, "mid", "other");
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(tree);
    expect(moved!.find((n) => n.id === "mid")!.parentId).toBe("other");
    // the subtree travels with the page: child links are untouched
    expect(moved!.find((n) => n.id === "leaf")!.parentId).toBe("mid");
    expect(moved!.find((n) => n.id === "deep")!.parentId).toBe("leaf");
    // row order is stable — only the parentId changes
    expect(moved!.map((n) => n.id)).toEqual(tree.map((n) => n.id));
  });

  it("never mutates the input tree or its rows", () => {
    const tree = familyTree();
    const before = JSON.parse(JSON.stringify(tree));
    const moved = movePage(tree, "mid", "other")!;
    expect(tree).toEqual(before); // input untouched (value-wise)
    expect(moved).not.toBe(tree); // new array
    const movedMid = moved.find((n) => n.id === "mid")!;
    const treeMid = tree.find((n) => n.id === "mid")!;
    expect(movedMid).not.toBe(treeMid); // moved row is a new object
    expect(movedMid.parentId).toBe("other");
    expect(treeMid.parentId).toBe("top"); // original row untouched
    // untouched rows keep their values
    expect(moved.find((n) => n.id === "other")).toEqual(
      tree.find((n) => n.id === "other"),
    );
  });

  it("moves to the top level when the target is null", () => {
    const tree = familyTree();
    const moved = movePage(tree, "deep", null)!;
    expect(moved.find((n) => n.id === "deep")!.parentId).toBeNull();
    // the rest of the chain is untouched — `deep` was a leaf, so it carries no children
    expect(moved.find((n) => n.id === "leaf")!.parentId).toBe("mid");
    expect(moved.find((n) => n.id === "mid")!.parentId).toBe("top");
  });

  it("returns null for every rejected move and leaves the input alone", () => {
    const tree = familyTree();
    const before = JSON.parse(JSON.stringify(tree));
    expect(movePage(tree, "top", "deep")).toBeNull(); // descendant
    expect(movePage(tree, "top", "top")).toBeNull(); // self
    expect(movePage(tree, "ghost", "other")).toBeNull(); // missing page
    expect(movePage(tree, "mid", "ghost")).toBeNull(); // missing target
    expect(tree).toEqual(before);
  });

  it("round-trips: moving back under the original parent restores the shape", () => {
    const tree = familyTree();
    const away = movePage(tree, "mid", "other")!;
    const back = movePage(away, "mid", "top")!;
    expect(back).toEqual(tree);
  });
});

describe("ancestryOf (breadcrumbs)", () => {
  it("returns the root -> page path, page last", () => {
    const tree = familyTree();
    expect(ancestryOf(tree, "deep").map((n) => n.id)).toEqual([
      "top",
      "mid",
      "leaf",
      "deep",
    ]);
    expect(ancestryOf(tree, "mid").map((n) => n.id)).toEqual(["top", "mid"]);
    expect(ancestryOf(tree, "top").map((n) => n.id)).toEqual(["top"]); // root itself
  });

  it("returns an empty path for a missing page, a broken lineage or an orphan cycle", () => {
    const tree = [
      ...familyTree(),
      node("floating", "ghost"), // parent missing from the list
      node("a", "b"),
      node("b", "a"), // cycle never reaches a root
    ];
    expect(ancestryOf(tree, "ghost")).toEqual([]); // no such page
    expect(ancestryOf(tree, "floating")).toEqual([]);
    expect(ancestryOf(tree, "a")).toEqual([]);
  });

  it("walks the 100-level chain of the large tree in one pass", () => {
    const tree = buildLargeTree();
    const path = ancestryOf(tree, "p109");
    expect(path.map((n) => n.id)).toEqual([
      "p0",
      ...Array.from({ length: 100 }, (_, i) => `p${10 + i}`),
    ]);
    expect(path[0].parentId).toBeNull();
    expect(path[path.length - 1].id).toBe("p109");
    expect(ancestryOf(tree, "p0")).toEqual([tree.find((n) => n.id === "p0")!]);
  });
});

describe("flattenTree (virtualization plan)", () => {
  it("defaults to roots only, in stable input order, all visible and collapsed", () => {
    const rows = flattenTree(buildLargeTree());
    expect(ids(rows)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
      "p7",
      "p8",
      "p9",
    ]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    expect(rows.every((r) => r.visible)).toBe(true);
    expect(rows.every((r) => !r.expanded)).toBe(true);
  });

  it("matches flattenVisible row-for-row for the same expand state (order + depth)", () => {
    const tree = buildLargeTree();
    const cases: ReadonlySet<string>[] = [
      new Set<string>(),
      new Set(["p0", "p5", "p63"]),
      new Set(tree.map((n) => n.id)),
    ];
    for (const expanded of cases) {
      const rows = flattenTree(tree, { expanded });
      expect(rows.every((r) => r.visible)).toBe(true); // render-plan mode
      expect(rows.map((r) => `${r.node.id}@${r.depth}`)).toEqual(
        flattenVisible(tree, expanded).map((r) => `${r.node.id}@${r.depth}`),
      );
    }
  });

  it("includeCollapsed emits hidden descendants with visible=false and contiguous depth", () => {
    const tree: PageTreeNode[] = [];
    for (let i = 0; i < 5; i++) tree.push(node(`n${i}`, i === 0 ? null : `n${i - 1}`));
    const expanded = new Set(["n0", "n1"]);
    const rows = flattenTree(tree, { expanded, includeCollapsed: true });
    expect(
      rows.map((r) => ({ id: r.node.id, depth: r.depth, visible: r.visible })),
    ).toEqual([
      { id: "n0", depth: 0, visible: true },
      { id: "n1", depth: 1, visible: true },
      { id: "n2", depth: 2, visible: true },
      { id: "n3", depth: 3, visible: false },
      { id: "n4", depth: 4, visible: false },
    ]);
    // the visible slice is exactly what the sidebar renders
    expect(ids(rows.filter((r) => r.visible))).toEqual(
      ids(flattenVisible(tree, expanded)),
    );
  });

  it("rootFilter drops a filtered-out root AND its whole subtree, even with includeCollapsed", () => {
    const tree = [
      node("mine", null, "ts-a"),
      node("mineKid", "mine"),
      node("yours", null, "ts-b"),
      node("yoursKid", "yours"),
      node("private", null),
    ];
    const expanded = new Set(tree.map((n) => n.id));
    const rootFilter = (n: PageTreeNode) => n.teamspaceId === "ts-a";
    const renderPlan = flattenTree(tree, { expanded, rootFilter });
    const full = flattenTree(tree, { expanded, rootFilter, includeCollapsed: true });
    expect(ids(renderPlan)).toEqual(["mine", "mineKid"]);
    expect(ids(full)).toEqual(["mine", "mineKid"]);
    expect(full.every((r) => r.visible)).toBe(true);
  });

  it("never emits orphaned rows (an a <-> b cycle is unreachable from a root)", () => {
    const tree = [node("r", null), node("a", "b"), node("b", "a")];
    const expanded = new Set(["r", "a", "b"]);
    expect(ids(flattenTree(tree, { expanded }))).toEqual(["r"]);
    expect(ids(flattenTree(tree, { expanded, includeCollapsed: true }))).toEqual(["r"]);
  });

  it("mirrors expand state per row (a collapsed ancestor keeps stale ids inert)", () => {
    const rows = flattenTree(familyTree(), {
      expanded: new Set(["mid"]),
      includeCollapsed: true,
    });
    expect(
      rows.map((r) => ({ id: r.node.id, visible: r.visible, open: r.expanded })),
    ).toEqual([
      { id: "top", visible: true, open: false }, // root always visible
      { id: "mid", visible: false, open: true }, // stale: its parent is collapsed
      { id: "leaf", visible: false, open: false },
      { id: "deep", visible: false, open: false },
      { id: "other", visible: true, open: false },
    ]);
  });

  it("keeps sibling order exactly as given (input order, not re-sorted)", () => {
    const tree = [node("r", null), node("z", "r"), node("a", "r"), node("m", "r")];
    expect(ids(flattenTree(tree, { expanded: new Set(["r"]) }))).toEqual([
      "r",
      "z",
      "a",
      "m",
    ]);
  });
});

describe("collectSubtree", () => {
  it("gathers a leaf (single node)", () => {
    expect(collectSubtree(familyTree(), "other")).toEqual(new Set(["other"]));
  });

  it("gathers a page and every descendant, seed first in tree order", () => {
    const sub = collectSubtree(familyTree(), "top");
    expect(sub).toEqual(new Set(["top", "mid", "leaf", "deep"]));
    expect([...sub]).toEqual(["top", "mid", "leaf", "deep"]); // pre-order
  });

  it("collects an orphaned subtree whose parent is missing from the list", () => {
    const tree = [node("r", null), node("float", "ghost"), node("floatKid", "float")];
    expect(collectSubtree(tree, "float")).toEqual(new Set(["float", "floatKid"]));
    expect(collectSubtree(tree, "r")).toEqual(new Set(["r"]));
  });

  it("terminates on a malformed descendant cycle", () => {
    const tree = [node("r", null), node("x", "y"), node("y", "x")];
    expect(collectSubtree(tree, "x")).toEqual(new Set(["x", "y"]));
    expect(collectSubtree(tree, "y")).toEqual(new Set(["y", "x"]));
    expect(collectSubtree(tree, "r")).toEqual(new Set(["r"]));
  });

  it("returns an empty set for a page that is not there", () => {
    expect(collectSubtree(familyTree(), "ghost").size).toBe(0);
  });

  it("accepts plain id pairs (structural rows, no PageTreeNode fields needed)", () => {
    const refs = [
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
    ];
    expect(collectSubtree(refs, "a")).toEqual(new Set(["a", "b"]));
  });

  it("matches the reach() oracle on the 1000-node tree", () => {
    const tree = buildLargeTree();
    expect(collectSubtree(tree, "p0")).toEqual(reach(tree, ["p0"]));
    expect(collectSubtree(tree, "p63")).toEqual(reach(tree, ["p63"]));
    expect(collectSubtree(tree, "p9").has("p10")).toBe(false); // disjoint branch
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

  it("flattenTree (fully expanded + collapsed rows) on 1000 nodes stays under 100 ms", () => {
    const tree = buildLargeTree(1000);
    const expanded = new Set(tree.map((n) => n.id));
    const started = performance.now();
    const rows = flattenTree(tree, { expanded, includeCollapsed: true });
    const elapsed = performance.now() - started;
    expect(rows).toHaveLength(1000);
    expect(rows.every((r) => r.visible)).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it("collectSubtree + canReparent on 1000 nodes each stay under 100 ms", () => {
    const tree = buildLargeTree(1000);
    let started = performance.now();
    const sub = collectSubtree(tree, "p0");
    const collectMs = performance.now() - started;
    started = performance.now();
    const legal = canReparent(tree, "p0", "p7");
    const guardMs = performance.now() - started;
    expect(sub.size).toBe(reach(tree, ["p0"]).size);
    expect(legal).toBe(true);
    expect(collectMs).toBeLessThan(100);
    expect(guardMs).toBeLessThan(100);
  });
});

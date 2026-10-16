import { describe, expect, it } from "vitest";
import type { PageTreeNode } from "@/server/queries";
import { flattenVisible } from "@/lib/page-tree";
import {
  VIRTUALIZE_ROW_THRESHOLD,
  anchorForScroll,
  buildRenderPlan,
  describeRenderPlan,
  measurePerf,
  scrollToIndex,
  shouldVirtualize,
  visibleRange,
  type PageTreeRenderPlan,
} from "@/lib/page-tree-window";

/**
 * W09 — page-tree virtualization + perf model
 * (MISSING_FEATURES §9: "React DOM render at 1000 nodes still unmeasured").
 *
 * Red-first: `src/lib/page-tree-window.ts` did not exist when this file was
 * written, so the whole suite fails on the missing module until the pure
 * windowing helpers land. Everything here is deterministic — no ambient clock
 * (the perf clock is injected), no DOM, no prisma, no `any`. The render plan is
 * compared against `flattenVisible` from `src/lib/page-tree.ts` as an
 * independent oracle for the visible-row order.
 */

const node = (id: string, parentId: string | null): PageTreeNode => ({
  id,
  parentId,
  teamspaceId: null,
  title: `Page ${id}`,
  icon: null,
  type: "PAGE",
  position: 0,
  isFavorite: false,
});

const tenRoots = (): PageTreeNode[] =>
  Array.from({ length: 10 }, (_, i) => node(`p${i}`, null));

/** `A -> a1..a5`, `B -> b1..b5` — 12 rows when both nodes are expanded. */
const abTree = (): PageTreeNode[] => [
  node("A", null),
  ...Array.from({ length: 5 }, (_, i) => node(`a${i + 1}`, "A")),
  node("B", null),
  ...Array.from({ length: 5 }, (_, i) => node(`b${i + 1}`, "B")),
];

/** `top -> mid -> leaf -> deep` plus an unrelated root. */
const familyTree = (): PageTreeNode[] => [
  node("top", null),
  node("mid", "top"),
  node("leaf", "mid"),
  node("deep", "leaf"),
  node("other", null),
];

/** ~1000-node synthetic tree, same shape as `page-tree.test.ts`. */
function buildLargeTree(count = 1000): PageTreeNode[] {
  const nodes: PageTreeNode[] = [];
  for (let i = 0; i < 10; i++) nodes.push(node(`p${i}`, null));
  for (let i = 10; i < 110; i++) nodes.push(node(`p${i}`, i === 10 ? "p0" : `p${i - 1}`));
  for (let i = 110; i < count; i++) nodes.push(node(`p${i}`, `p${(i * 7) % 110}`));
  return nodes;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

const PLAN = { rowHeight: 20, viewportHeight: 100 } as const;

const allExpanded = (tree: PageTreeNode[]) => new Set(tree.map((n) => n.id));

/** Deterministic step clock: each call returns the current value then advances. */
function stepClock(start: number, step: number): () => number {
  let t = start;
  return () => {
    const value = t;
    t += step;
    return value;
  };
}

function countRows(plan: PageTreeRenderPlan): number {
  return plan.visibleIds.length;
}

describe("buildRenderPlan — window boundaries", () => {
  it("renders only the top viewport of the flattened visible rows", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(ids(plan.rows)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(plan.startIndex).toBe(0);
    expect(plan.endIndex).toBe(5);
  });

  it("follows the scroll position (end is exclusive)", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 60 });
    expect(ids(plan.rows)).toEqual(["p3", "p4", "p5", "p6", "p7"]);
    expect(plan.startIndex).toBe(3);
    expect(plan.endIndex).toBe(8);
  });

  it("expands the window by overscan on both sides", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 60, overscan: 2 });
    expect(ids(plan.rows)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
    expect(plan.startIndex).toBe(1);
    expect(plan.endIndex).toBe(10);
  });

  it("records each row's absolute top and height inside the full list", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 60, overscan: 1 });
    expect(plan.rows.map((r) => r.top)).toEqual([40, 60, 80, 100, 120, 140, 160]);
    expect(plan.rows.every((r) => r.height === 20)).toBe(true);
    expect(plan.rows[0].id).toBe("p2");
  });

  it("reports totalHeight over every visible row, not just the window", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(plan.totalHeight).toBe(200);
    expect(plan.rows).toHaveLength(5);
    expect(plan.visibleIds).toHaveLength(10);
  });

  it("clamps the window to the list end (empty when scrolled past)", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 200 });
    expect(plan.rows).toEqual([]);
    expect(plan.startIndex).toBe(10);
    expect(plan.endIndex).toBe(10);
  });

  it("still shows the tail rows under overscan when scrolled past the end", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 1000, overscan: 2 });
    expect(ids(plan.rows)).toEqual(["p8", "p9"]);
    expect(plan.startIndex).toBe(8);
    expect(plan.endIndex).toBe(10);
  });

  it("clamps a negative scrollTop to the top", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: -40 });
    expect(ids(plan.rows)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(plan.startIndex).toBe(0);
  });

  it("degrades non-finite scrollTop/overscan to sane defaults", () => {
    const plan = buildRenderPlan(tenRoots(), {
      ...PLAN,
      scrollTop: Number.NaN,
      overscan: Number.POSITIVE_INFINITY,
    });
    expect(ids(plan.rows)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(plan.rows.every((r) => r.top >= 0)).toBe(true);
  });

  it("returns an empty plan for an empty tree", () => {
    const plan = buildRenderPlan([], { ...PLAN, scrollTop: 0 });
    expect(plan.rows).toEqual([]);
    expect(plan.totalHeight).toBe(0);
    expect(plan.startIndex).toBe(0);
    expect(plan.endIndex).toBe(0);
  });

  it("returns an empty window when the row height is unusable", () => {
    for (const rowHeight of [0, -20, Number.NaN]) {
      const plan = buildRenderPlan(tenRoots(), { ...PLAN, rowHeight, scrollTop: 0 });
      expect(plan.rows).toEqual([]);
      expect(plan.startIndex).toBe(0);
      expect(plan.endIndex).toBe(0);
      expect(plan.totalHeight).toBe(0);
    }
  });

  it("returns an empty window when the viewport height is unusable", () => {
    for (const viewportHeight of [0, -10, Number.NaN]) {
      const plan = buildRenderPlan(tenRoots(), { ...PLAN, viewportHeight, scrollTop: 0 });
      expect(plan.rows).toEqual([]);
      expect(plan.startIndex).toBe(0);
      expect(plan.endIndex).toBe(0);
    }
  });
});

describe("buildRenderPlan — expand state + row shape", () => {
  it("hides collapsed subtrees (only roots are visible by default)", () => {
    const plan = buildRenderPlan(familyTree(), { ...PLAN, scrollTop: 0 });
    expect(ids(plan.rows)).toEqual(["top", "other"]);
    expect(plan.totalHeight).toBe(40);
  });

  it("adds a node's children contiguously once it is expanded", () => {
    const plan = buildRenderPlan(familyTree(), {
      ...PLAN,
      expandedIds: new Set(["top"]),
      scrollTop: 0,
    });
    expect(ids(plan.rows)).toEqual(["top", "mid", "other"]);
    expect(plan.rows.map((r) => r.depth)).toEqual([0, 1, 0]);
  });

  it("shifts the tops of later rows when a subtree expands above them", () => {
    const collapsed = buildRenderPlan(familyTree(), {
      ...PLAN,
      expandedIds: new Set(["mid", "leaf"]),
      scrollTop: 0,
    });
    const expanded = buildRenderPlan(familyTree(), {
      ...PLAN,
      expandedIds: new Set(["top", "mid", "leaf"]),
      scrollTop: 0,
    });
    const otherCollapsed = collapsed.rows.find((r) => r.id === "other")!;
    const otherExpanded = expanded.rows.find((r) => r.id === "other")!;
    expect(otherCollapsed.top).toBe(20); // top, other
    expect(otherExpanded.top).toBe(80); // top, mid, leaf, deep, other
  });

  it("marks hasChildren from the raw tree, independent of expand state", () => {
    const plan = buildRenderPlan(familyTree(), { ...PLAN, scrollTop: 0 });
    const byId = new Map(plan.rows.map((r) => [r.id, r]));
    expect(byId.get("top")!.hasChildren).toBe(true);
    expect(byId.get("other")!.hasChildren).toBe(false);
  });

  it("mirrors the per-row expanded flag", () => {
    const plan = buildRenderPlan(familyTree(), {
      ...PLAN,
      expandedIds: new Set(["top", "mid"]),
      scrollTop: 0,
    });
    expect(plan.rows.map((r) => [r.id, r.expanded])).toEqual([
      ["top", true],
      ["mid", true],
      ["leaf", false],
      ["other", false],
    ]);
  });

  it("ignores a stale expanded id under a collapsed ancestor", () => {
    const plan = buildRenderPlan(familyTree(), {
      ...PLAN,
      expandedIds: new Set(["mid", "leaf"]),
      scrollTop: 0,
    });
    // `top` is collapsed, so `mid`/`leaf` never become visible.
    expect(ids(plan.rows)).toEqual(["top", "other"]);
  });

  it("matches flattenVisible row-for-row (independent oracle)", () => {
    const tree = buildLargeTree(400);
    for (const expanded of [
      new Set<string>(),
      new Set(["p0", "p10", "p20"]),
      allExpanded(tree),
    ]) {
      const plan = buildRenderPlan(tree, { ...PLAN, expandedIds: expanded, scrollTop: 0 });
      expect(plan.visibleIds).toEqual(flattenVisible(tree, expanded).map((r) => r.node.id));
    }
  });
});

describe("visibleRange", () => {
  it("mirrors the plan's window", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 60, overscan: 1 });
    expect(visibleRange(plan)).toEqual({ start: plan.startIndex, end: plan.endIndex });
    expect(visibleRange(plan)).toEqual({ start: 2, end: 9 });
  });

  it("is an empty range for an empty plan", () => {
    const plan = buildRenderPlan([], { ...PLAN, scrollTop: 0 });
    expect(visibleRange(plan)).toEqual({ start: 0, end: 0 });
  });
});

describe("scrollToIndex — centre alignment", () => {
  it("centres an interior row in the viewport", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(scrollToIndex(plan, 5)).toBe(60); // row 5 centre (110) - viewport centre (50)
  });

  it("clamps at the top", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(scrollToIndex(plan, 0)).toBe(0);
  });

  it("clamps at the bottom to the scrollable range", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(scrollToIndex(plan, 9)).toBe(100);
  });

  it("clamps an out-of-range index into the list", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(scrollToIndex(plan, -3)).toBe(0);
    expect(scrollToIndex(plan, 500)).toBe(100);
  });

  it("returns 0 for an empty plan", () => {
    const plan = buildRenderPlan([], { ...PLAN, scrollTop: 0 });
    expect(scrollToIndex(plan, 3)).toBe(0);
  });
});

describe("shouldVirtualize", () => {
  it("stays false up to and including the threshold", () => {
    expect(shouldVirtualize(0)).toBe(false);
    expect(shouldVirtualize(VIRTUALIZE_ROW_THRESHOLD)).toBe(false);
  });

  it("turns on above the default threshold", () => {
    expect(shouldVirtualize(VIRTUALIZE_ROW_THRESHOLD + 1)).toBe(true);
  });

  it("honours an explicit threshold", () => {
    expect(shouldVirtualize(11, { threshold: 10 })).toBe(true);
    expect(shouldVirtualize(10, { threshold: 10 })).toBe(false);
  });

  it("guards non-finite and negative counts", () => {
    expect(shouldVirtualize(Number.NaN)).toBe(false);
    expect(shouldVirtualize(Number.POSITIVE_INFINITY)).toBe(false);
    expect(shouldVirtualize(-5)).toBe(false);
  });

  it("treats a threshold of 0 (or below) as 'virtualize any non-empty list'", () => {
    expect(shouldVirtualize(1, { threshold: 0 })).toBe(true);
    expect(shouldVirtualize(1, { threshold: -3 })).toBe(true);
    expect(shouldVirtualize(0, { threshold: 0 })).toBe(false);
  });
});

describe("anchorForScroll — pin the same row across expand/collapse", () => {
  it("keeps the row under the viewport top pinned when a subtree above collapses", () => {
    const tree = abTree();
    const prev = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["A", "B"]),
      scrollTop: 120,
    });
    expect(prev.visibleIds[6]).toBe("B");
    const next = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["B"]),
      scrollTop: 120,
    });
    const scrollTop = anchorForScroll(prev, next, 120);
    expect(scrollTop).toBe(20); // B moved from index 6 to index 1
    const rebuilt = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["B"]),
      scrollTop,
    });
    expect(rebuilt.visibleIds[Math.floor(scrollTop / 20)]).toBe("B");
  });

  it("preserves the intra-row offset when pinning", () => {
    const tree = abTree();
    const prev = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["A", "B"]),
      scrollTop: 125, // 5px into row index 6 (B)
    });
    const next = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["B"]),
      scrollTop: 125,
    });
    const scrollTop = anchorForScroll(prev, next, 125);
    expect(scrollTop).toBe(25); // B now at index 1: 20px top + 5px into the row
    expect(scrollTop % 20).toBe(125 % 20);
  });

  it("shifts scrollTop down when a subtree above expands", () => {
    const tree = abTree();
    const prev = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["B"]),
      scrollTop: 20, // B at index 1
    });
    const next = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["A", "B"]),
      scrollTop: 20,
    });
    expect(anchorForScroll(prev, next, 20)).toBe(120); // B is now index 6
  });

  it("falls back to the clamped scrollTop when the pinned row disappears", () => {
    const tree = abTree();
    const prev = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["A", "B"]),
      scrollTop: 160, // row index 8 = b2
    });
    expect(prev.visibleIds[8]).toBe("b2");
    const next = buildRenderPlan(tree, {
      ...PLAN,
      expandedIds: new Set(["A"]),
      scrollTop: 160,
    });
    // b2 is gone; clamp 160 into the 7-row (140px) list → max scroll 40.
    expect(anchorForScroll(prev, next, 160)).toBe(40);
  });

  it("clamps a scrollTop past the end of the previous list", () => {
    const tree = tenRoots();
    const prev = buildRenderPlan(tree, { ...PLAN, scrollTop: 5000 });
    const next = buildRenderPlan(tree, { ...PLAN, scrollTop: 5000 });
    expect(anchorForScroll(prev, next, 5000)).toBe(100);
  });

  it("is a no-op for identical plans", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 80 });
    expect(anchorForScroll(plan, plan, 80)).toBe(80);
  });
});

describe("measurePerf", () => {
  it("visits every rendered row once per sample", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    const result = measurePerf(plan, { samples: 3, now: stepClock(0, 1) });
    expect(result.nodesVisited).toBe(plan.rows.length * 3);
    expect(result.nodesVisited).toBe(15);
  });

  it("derives durationMs from the injected clock (deterministic)", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(measurePerf(plan, { samples: 2, now: stepClock(100, 10) })).toEqual({
      nodesVisited: 10,
      durationMs: 10,
    });
  });

  it("defaults samples to 1", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    const result = measurePerf(plan, { now: stepClock(0, 5) });
    expect(result.nodesVisited).toBe(plan.rows.length);
    expect(result.durationMs).toBe(5);
  });

  it("does no visits for samples <= 0", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(measurePerf(plan, { samples: 0, now: stepClock(0, 7) }).nodesVisited).toBe(0);
    expect(measurePerf(plan, { samples: -4, now: stepClock(0, 7) }).nodesVisited).toBe(0);
  });

  it("degrades a non-finite sample count to a single pass", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    const result = measurePerf(plan, { samples: Number.NaN, now: stepClock(0, 2) });
    expect(result.nodesVisited).toBe(plan.rows.length);
  });

  it("never reports a negative duration when the clock runs backwards", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    const result = measurePerf(plan, { samples: 1, now: stepClock(100, -10) });
    expect(result.durationMs).toBe(0);
  });
});

describe("describeRenderPlan", () => {
  it("summarises the window, the full row count and the geometry", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 0 });
    expect(describeRenderPlan(plan)).toBe("5/10 rows · window [0, 5) · 200px · 20px/row");
  });

  it("reflects a scrolled, overscanned window", () => {
    const plan = buildRenderPlan(tenRoots(), { ...PLAN, scrollTop: 60, overscan: 2 });
    expect(describeRenderPlan(plan)).toBe("9/10 rows · window [1, 10) · 200px · 20px/row");
  });

  it("handles an empty plan", () => {
    const plan = buildRenderPlan([], { ...PLAN, scrollTop: 0 });
    expect(describeRenderPlan(plan)).toBe("0/0 rows · window [0, 0) · 0px · 20px/row");
  });
});

describe("1000-node plan stays inside the viewport step budget", () => {
  const tree = buildLargeTree();

  it("windows the fully-expanded tree to a bounded render set", () => {
    const plan = buildRenderPlan(tree, {
      rowHeight: 24,
      viewportHeight: 600,
      overscan: 3,
      expandedIds: allExpanded(tree),
      scrollTop: 0,
    });
    expect(countRows(plan)).toBe(1000);
    const viewportRows = Math.ceil(600 / 24);
    expect(plan.rows.length).toBeLessThanOrEqual(viewportRows + 2 * 3 + 1);
    expect(plan.rows.length).toBeLessThan(50);
  });

  it("reports the full scroll height without materialising it", () => {
    const plan = buildRenderPlan(tree, {
      rowHeight: 24,
      viewportHeight: 600,
      overscan: 3,
      expandedIds: allExpanded(tree),
      scrollTop: 0,
    });
    expect(plan.totalHeight).toBe(1000 * 24);
    expect(plan.rows.length * 24).toBeLessThan(plan.totalHeight);
  });

  it("keeps the perf model well under a 1000-node step budget", () => {
    const plan = buildRenderPlan(tree, {
      rowHeight: 24,
      viewportHeight: 600,
      overscan: 3,
      expandedIds: allExpanded(tree),
      scrollTop: 4800,
    });
    const { nodesVisited, durationMs } = measurePerf(plan, { samples: 10, now: stepClock(0, 1) });
    expect(nodesVisited).toBe(plan.rows.length * 10);
    expect(nodesVisited).toBeLessThan(1000);
    expect(durationMs).toBe(1);
  });

  it("matches the flattenVisible oracle across a deep window", () => {
    const expanded = allExpanded(tree);
    const plan = buildRenderPlan(tree, {
      rowHeight: 24,
      viewportHeight: 600,
      overscan: 0,
      expandedIds: expanded,
      scrollTop: 4800,
    });
    const oracle = flattenVisible(tree, expanded).map((r) => r.node.id);
    expect(plan.visibleIds).toEqual(oracle);
    expect(ids(plan.rows)).toEqual(oracle.slice(plan.startIndex, plan.endIndex));
  });
});

import { describe, expect, it } from "vitest";
import type { PageTreeNode } from "@/server/queries";
import {
  SIDEBAR_ROW_HEIGHT,
  buildSidebarRenderPlan,
  type SidebarRenderItem,
  type SidebarTeamspace,
} from "@/components/sidebar/page-tree";
import { anchorForScroll, scrollToIndex, visibleRange } from "@/lib/page-tree-window";

/**
 * W10 — the plan ⇄ props mapping for the virtualized sidebar.
 *
 * `@/lib/page-tree-window` is pure windowing math with its own 50-test suite;
 * this file proves the *wiring*: `buildSidebarRenderPlan` turns the sidebar's
 * sectioned tree (teamspace sections + private section, headers included) into
 * the windowed, absolutely-positioned items the component renders, and the
 * component's navigation helpers (`scrollToIndex`, `anchorForScroll`) move that
 * window consistently. Node environment only — no DOM, no React.
 */

const TEAMSPACE: SidebarTeamspace = { id: "t1", name: "Team One", icon: "👥" };

const node = (
  id: string,
  parentId: string | null = null,
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

const roots = (count: number, prefix: string): PageTreeNode[] =>
  Array.from({ length: count }, (_, i) => node(`${prefix}${i}`));

/** `A -> a1..a5`, `B -> b1..b5`, both top-level private pages. */
const abTree = (): PageTreeNode[] => [
  node("A"),
  ...Array.from({ length: 5 }, (_, i) => node(`a${i + 1}`, "A")),
  node("B"),
  ...Array.from({ length: 5 }, (_, i) => node(`b${i + 1}`, "B")),
];

const headersOf = (items: SidebarRenderItem[]): string[] =>
  items.filter((item) => item.kind === "header").map((item) => item.id);

const idsOf = (items: SidebarRenderItem[]): string[] => items.map((item) => item.id);

const PLAN = { rowHeight: 20, viewportHeight: 1000, scrollTop: 0 } as const;

const TEAMSPACE_HEADER = "__sidebar_section__:teamspace:t1";
const PRIVATE_HEADER = "__sidebar_section__:private";

describe("buildSidebarRenderPlan — sections and headers", () => {
  it("emits each teamspace section then the private section, headers first", () => {
    const tree = [node("a1", null, "t1"), node("a2", null, "t1"), node("p1")];
    const plan = buildSidebarRenderPlan(tree, [TEAMSPACE], PLAN);

    expect(idsOf(plan.items)).toEqual([TEAMSPACE_HEADER, "a1", "a2", PRIVATE_HEADER, "p1"]);
    expect(headersOf(plan.items)).toEqual([TEAMSPACE_HEADER, PRIVATE_HEADER]);
    expect(plan.rowIds).toEqual(["a1", "a2", "p1"]);
    expect(plan.count).toBe(5);
  });

  it("skips a teamspace with no roots but always keeps the private header", () => {
    const empty: SidebarTeamspace = { id: "t2", name: "Empty", icon: null };
    const tree = [node("a1", null, "t1")];
    const plan = buildSidebarRenderPlan(tree, [TEAMSPACE, empty], PLAN);

    expect(plan.headers.has("__sidebar_section__:teamspace:t2")).toBe(false);
    expect(plan.headers.has(PRIVATE_HEADER)).toBe(true);
    expect(idsOf(plan.items)).toEqual([TEAMSPACE_HEADER, "a1", PRIVATE_HEADER]);
    expect(plan.count).toBe(3);
  });

  it("subtracts the synthetic header level so roots keep depth 0", () => {
    const tree = [node("a1", null, "t1"), node("a1x", "a1"), node("p1")];
    const plan = buildSidebarRenderPlan(tree, [TEAMSPACE], {
      ...PLAN,
      expandedIds: new Set(["a1"]),
    });
    const rowAt = (id: string) => {
      const item = plan.items.find((candidate) => candidate.kind === "row" && candidate.id === id);
      return item && item.kind === "row" ? item : undefined;
    };

    expect(rowAt("a1")!.depth).toBe(0);
    expect(rowAt("a1x")!.depth).toBe(1);
    expect(rowAt("p1")!.depth).toBe(0);
  });
});

describe("buildSidebarRenderPlan — windowing", () => {
  const tree = roots(100, "p");

  it("materialises only the viewport window, positioned absolutely", () => {
    const plan = buildSidebarRenderPlan(tree, [], { ...PLAN, viewportHeight: 100 });
    expect(idsOf(plan.items)).toEqual([PRIVATE_HEADER, "p0", "p1", "p2", "p3"]);
    expect(plan.items.map((item) => item.top)).toEqual([0, 20, 40, 60, 80]);
    expect(plan.plan.startIndex).toBe(0);
    expect(plan.plan.endIndex).toBe(5);
  });

  it("follows the scroll offset (window is half-open)", () => {
    const plan = buildSidebarRenderPlan(tree, [], {
      ...PLAN,
      viewportHeight: 100,
      scrollTop: 60,
    });
    // Index 3 = "p2" (index 0 is the private header).
    expect(idsOf(plan.items)).toEqual(["p2", "p3", "p4", "p5", "p6"]);
    expect(plan.items.map((item) => item.top)).toEqual([60, 80, 100, 120, 140]);
  });

  it("reports totalHeight over every visible item, not just the window", () => {
    const plan = buildSidebarRenderPlan(tree, [], { ...PLAN, viewportHeight: 100 });
    expect(plan.count).toBe(101); // header + 100 rows
    expect(plan.plan.totalHeight).toBe(101 * 20);
    expect(plan.items.length).toBeLessThan(plan.count);
  });

  it("exposes visibleRange(plan) as the rendered window", () => {
    const plan = buildSidebarRenderPlan(tree, [], {
      ...PLAN,
      viewportHeight: 100,
      scrollTop: 60,
      overscan: 1,
    });
    expect(plan.window).toEqual(visibleRange(plan.plan));
    expect(plan.window).toEqual({ start: plan.plan.startIndex, end: plan.plan.endIndex });
  });

  it("gives every item the plan's uniform height (row height stays in sync)", () => {
    const plan = buildSidebarRenderPlan(tree, [], {
      ...PLAN,
      rowHeight: SIDEBAR_ROW_HEIGHT,
      viewportHeight: 400,
    });
    expect(plan.plan.rowHeight).toBe(SIDEBAR_ROW_HEIGHT);
    expect(plan.items.every((item) => item.height === SIDEBAR_ROW_HEIGHT)).toBe(true);
    // Consecutive items are exactly one row apart — no drift between DOM and math.
    expect(plan.items.every((item, index) => item.top === index * SIDEBAR_ROW_HEIGHT)).toBe(
      true,
    );
  });
});

describe("buildSidebarRenderPlan — plan to props mapping", () => {
  it("maps plan rows back to the original node objects", () => {
    const tree = [node("a1", null, "t1"), node("p1")];
    const plan = buildSidebarRenderPlan(tree, [TEAMSPACE], PLAN);
    const row = plan.items.find((item) => item.kind === "row" && item.id === "a1");
    expect(row).toBeDefined();
    // Same reference, not a copy: the row renderer gets the live node.
    expect(row!.kind === "row" && row!.node).toBe(tree[0]);
  });

  it("carries hasChildren from the raw tree and expanded from the input set", () => {
    const tree = [node("a1", null, "t1"), node("a1x", "a1"), node("p1")];
    const collapsed = buildSidebarRenderPlan(tree, [TEAMSPACE], PLAN);
    const collapsedA1 = collapsed.items.find(
      (item) => item.kind === "row" && item.id === "a1",
    );
    expect(collapsedA1!.kind === "row" && collapsedA1!.hasChildren).toBe(true);
    expect(collapsedA1!.kind === "row" && collapsedA1!.expanded).toBe(false);
    expect(collapsed.items.some((item) => item.id === "a1x")).toBe(false);

    const open = buildSidebarRenderPlan(tree, [TEAMSPACE], {
      ...PLAN,
      expandedIds: new Set(["a1"]),
    });
    const openA1 = open.items.find((item) => item.kind === "row" && item.id === "a1");
    expect(openA1!.kind === "row" && openA1!.expanded).toBe(true);
    expect(idsOf(open.items)).toContain("a1x");
  });

  it("rowIds is the visible order with headers removed", () => {
    const plan = buildSidebarRenderPlan(abTree(), [], {
      ...PLAN,
      expandedIds: new Set(["A", "B"]),
    });
    expect(plan.rowIds).toEqual([
      "A",
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "B",
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
    ]);
    expect(plan.rowIds.every((id) => !plan.headers.has(id))).toBe(true);
  });

  it("turns virtualization on only above the threshold", () => {
    const atThreshold = buildSidebarRenderPlan(roots(49, "p"), [], PLAN); // 49 rows + header = 50
    const above = buildSidebarRenderPlan(roots(50, "p"), [], PLAN); // 50 rows + header = 51

    expect(atThreshold.count).toBe(50);
    expect(atThreshold.virtualized).toBe(false);
    expect(above.count).toBe(51);
    expect(above.virtualized).toBe(true);
  });
});

describe("buildSidebarRenderPlan — navigation stays coherent with the window", () => {
  const tree = roots(100, "p");

  it("scrollToIndex brings an off-window row into the rendered window", () => {
    const before = buildSidebarRenderPlan(tree, [], { ...PLAN, viewportHeight: 100 });
    expect(before.items.some((item) => item.id === "p50")).toBe(false);

    const index = before.plan.visibleIds.indexOf("p50");
    const scrollTop = scrollToIndex(before.plan, index);

    const after = buildSidebarRenderPlan(tree, [], {
      ...PLAN,
      viewportHeight: 100,
      scrollTop,
    });
    expect(after.items.some((item) => item.id === "p50")).toBe(true);
  });

  it("anchorForScroll keeps a row pinned when a subtree above collapses", () => {
    const tree = abTree();
    const expanded = new Set(["A", "B"]);
    const prev = buildSidebarRenderPlan(tree, [], {
      ...PLAN,
      viewportHeight: 100,
      scrollTop: 140, // row index 7 = "B"
      expandedIds: expanded,
    });
    expect(prev.plan.visibleIds[7]).toBe("B");

    const next = buildSidebarRenderPlan(tree, [], {
      ...PLAN,
      viewportHeight: 100,
      scrollTop: 140,
      expandedIds: new Set(["B"]),
    });
    const pinned = anchorForScroll(prev.plan, next.plan, 140);

    const rebuilt = buildSidebarRenderPlan(tree, [], {
      ...PLAN,
      viewportHeight: 100,
      scrollTop: pinned,
      expandedIds: new Set(["B"]),
    });
    expect(rebuilt.items.some((item) => item.id === "B")).toBe(true);
    expect(rebuilt.plan.visibleIds[Math.floor(pinned / 20)]).toBe("B");
  });
});

import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  canMoveSubtree,
  childrenOf,
  depthOf,
  indent,
  moveSubtree,
  outdent,
  renumberSiblings,
  subtreeOf,
  validateSubItems,
  visibleRows,
  type SubItemRow,
} from "@/lib/sub-items";

/**
 * MISSING_FEATURES §3 — "Sub-items / sub-tasks" (docs/MISSING_FEATURES.md
 * "Sub-items / sub-tasks": parent-child rows inside a database).
 *
 * Red-first: `src/lib/sub-items.ts` did not exist when this file was written,
 * so the whole suite fails on the missing module until the pure tree engine
 * lands. Everything here is pure data in / data out — no DB, no routes, no
 * React — and every operation must leave its input untouched.
 */

type Row = SubItemRow & { title?: string };

const r = (id: string, parentId: string | null = null, order?: number): Row =>
  order === undefined ? { id, parentId } : { id, parentId, order };

const ids = (rows: readonly SubItemRow[]): string[] => rows.map((row) => row.id);

/** Deliberately stored out of order to prove `childrenOf` sorts by `order`. */
const tree: Row[] = [
  r("b2", "b", 2000),
  r("a", null, 1000),
  r("b1x", "b1", 1000),
  r("c", null, 3000),
  r("b", null, 2000),
  r("b1", "b", 1000),
];

describe("sub-items: childrenOf", () => {
  it("returns only the direct children, ordered by `order`", () => {
    expect(ids(childrenOf(tree, null))).toEqual(["a", "b", "c"]);
    expect(ids(childrenOf(tree, "b"))).toEqual(["b1", "b2"]);
    expect(ids(childrenOf(tree, "b1"))).toEqual(["b1x"]);
  });

  it("returns an empty list for a parent with no children (or unknown parent)", () => {
    expect(childrenOf(tree, "b2")).toEqual([]);
    expect(childrenOf(tree, "ghost")).toEqual([]);
    expect(childrenOf([], null)).toEqual([]);
  });

  it("keeps input order for missing or tied `order` values", () => {
    expect(ids(childrenOf([r("x"), r("y"), r("z")], null))).toEqual(["x", "y", "z"]);
    expect(ids(childrenOf([r("y", null, 1000), r("x", null, 1000)], null))).toEqual([
      "y",
      "x",
    ]);
  });

  it("does not mutate the input array", () => {
    const before = ids(tree);
    childrenOf(tree, null);
    expect(ids(tree)).toEqual(before);
  });
});

describe("sub-items: depth and ancestry", () => {
  it("reports depth with roots at 0", () => {
    expect(depthOf(tree, "a")).toBe(0);
    expect(depthOf(tree, "b")).toBe(0);
    expect(depthOf(tree, "b1")).toBe(1);
    expect(depthOf(tree, "b1x")).toBe(2);
  });

  it("returns -1 for an unknown id", () => {
    expect(depthOf(tree, "missing")).toBe(-1);
    expect(depthOf([], "missing")).toBe(-1);
  });

  it("lists ancestors from root to immediate parent (excluding the node)", () => {
    expect(ids(ancestorsOf(tree, "b1x"))).toEqual(["b", "b1"]);
    expect(ids(ancestorsOf(tree, "b1"))).toEqual(["b"]);
    expect(ids(ancestorsOf(tree, "a"))).toEqual([]);
  });

  it("returns an empty ancestry for unknown ids", () => {
    expect(ancestorsOf(tree, "missing")).toEqual([]);
    expect(ancestorsOf([], "a")).toEqual([]);
  });
});

describe("sub-items: subtreeOf", () => {
  it("returns the node plus descendants in depth-first order", () => {
    expect(ids(subtreeOf(tree, "b"))).toEqual(["b", "b1", "b1x", "b2"]);
    expect(ids(subtreeOf(tree, "b1"))).toEqual(["b1", "b1x"]);
    expect(ids(subtreeOf(tree, "a"))).toEqual(["a"]);
  });

  it("returns an empty list for an unknown id", () => {
    expect(subtreeOf(tree, "missing")).toEqual([]);
    expect(subtreeOf([], "a")).toEqual([]);
  });
});

describe("sub-items: validateSubItems", () => {
  it("returns no issues for a well-formed forest", () => {
    expect(validateSubItems(tree)).toEqual([]);
    expect(validateSubItems([])).toEqual([]);
  });

  it("flags self-parenting rows", () => {
    const issues = validateSubItems([r("a", "a")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "self-parent", id: "a" });
  });

  it("flags rows whose parent is not in the list", () => {
    expect(validateSubItems([r("a", "ghost")])).toEqual([
      { kind: "unknown-parent", id: "a", parentId: "ghost" },
    ]);
  });

  it("reports a cycle with a concrete, closed path", () => {
    const issues = validateSubItems([r("a", "b"), r("b", "c"), r("c", "a")]);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.kind).toBe("cycle");
    if (issue.kind === "cycle") {
      expect(issue.path).toEqual(["a", "b", "c", "a"]);
      expect(issue.path[0]).toBe(issue.path[issue.path.length - 1]);
    }
  });

  it("detects two-node cycles once", () => {
    const issues = validateSubItems([r("x", "y"), r("y", "x")]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("cycle");
  });

  it("never throws, even on malformed input", () => {
    expect(() =>
      validateSubItems([r("a", "a"), r("b", "ghost"), r("c", "b")]),
    ).not.toThrow();
    const issues = validateSubItems([r("a", "a"), r("b", "ghost")]);
    expect(issues.map((issue) => issue.kind)).toEqual(["self-parent", "unknown-parent"]);
  });
});

describe("sub-items: indent", () => {
  it("makes a row a child of its previous sibling", () => {
    const roots = [r("a", null, 1000), r("b", null, 2000), r("c", null, 3000)];
    const result = indent(roots, "b");
    expect(ids(childrenOf(result, null))).toEqual(["a", "c"]);
    expect(ids(childrenOf(result, "a"))).toEqual(["b"]);
    expect(result.find((row) => row.id === "b")!.parentId).toBe("a");
  });

  it("appends after any existing children of the new parent", () => {
    const rows = [r("a", null, 1000), r("b", null, 2000), r("c", null, 3000), r("a1", "a", 1000)];
    const result = indent(rows, "b");
    expect(ids(childrenOf(result, "a"))).toEqual(["a1", "b"]);
    const b = result.find((row) => row.id === "b")!;
    const a1 = result.find((row) => row.id === "a1")!;
    expect((b.order ?? 0) > (a1.order ?? 0)).toBe(true);
  });

  it("is a safe no-op without a previous sibling or for unknown ids", () => {
    const roots = [r("a", null, 1000), r("b", null, 2000)];
    expect(indent(roots, "a")).toBe(roots);
    expect(indent(roots, "missing")).toBe(roots);
    expect(indent([], "a")).toEqual([]);
  });

  it("does not mutate its input", () => {
    const rows = [r("a", null, 1000), r("b", null, 2000)];
    const snapshot = JSON.stringify(rows);
    indent(rows, "b");
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe("sub-items: outdent", () => {
  it("promotes a child to the grandparent level, right after its former parent", () => {
    const nested = [
      r("a", null, 1000),
      r("b", null, 2000),
      r("b1", "b", 1000),
      r("b2", "b", 2000),
      r("c", null, 3000),
    ];
    const result = outdent(nested, "b1");
    expect(result.find((row) => row.id === "b1")!.parentId).toBe(null);
    expect(ids(childrenOf(result, null))).toEqual(["a", "b", "b1", "c"]);
    expect(childrenOf(result, null).map((row) => row.order)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("promotes to the grandparent (not the root) at deeper levels", () => {
    const deep = [
      r("b", null, 1000),
      r("b1", "b", 1000),
      r("b1x", "b1", 1000),
      r("b2", "b", 2000),
    ];
    const result = outdent(deep, "b1x");
    expect(result.find((row) => row.id === "b1x")!.parentId).toBe("b");
    expect(ids(childrenOf(result, "b"))).toEqual(["b1", "b1x", "b2"]);
  });

  it("is a safe no-op for roots, unknown ids and empty input", () => {
    const nested = [r("a", null, 1000), r("b", null, 2000), r("b1", "b", 1000)];
    expect(outdent(nested, "a")).toBe(nested);
    expect(outdent(nested, "missing")).toBe(nested);
    expect(outdent([], "a")).toEqual([]);
  });

  it("does not mutate its input", () => {
    const nested = [r("b", null, 1000), r("b1", "b", 1000)];
    const snapshot = JSON.stringify(nested);
    outdent(nested, "b1");
    expect(JSON.stringify(nested)).toBe(snapshot);
    expect(nested.find((row) => row.id === "b1")!.parentId).toBe("b");
  });
});

describe("sub-items: moveSubtree", () => {
  const forest: Row[] = [
    r("a", null, 1000),
    r("b", null, 2000),
    r("b1", "b", 1000),
    r("b1x", "b1", 1000),
  ];

  it("reparents a row and carries its whole subtree along", () => {
    const result = moveSubtree(forest, "b", "a");
    expect(result.find((row) => row.id === "b")!.parentId).toBe("a");
    expect(ids(childrenOf(result, "a"))).toEqual(["b"]);
    expect(ids(subtreeOf(result, "a"))).toEqual(["a", "b", "b1", "b1x"]);
  });

  it("moves a row to the top level", () => {
    const result = moveSubtree(forest, "b1", null);
    expect(result.find((row) => row.id === "b1")!.parentId).toBe(null);
    expect(ids(childrenOf(result, null))).toEqual(["a", "b", "b1"]);
  });

  it("rejects moves onto itself or a descendant", () => {
    expect(canMoveSubtree(forest, "b", "b")).toBe(false);
    expect(canMoveSubtree(forest, "b", "b1")).toBe(false);
    expect(canMoveSubtree(forest, "b", "b1x")).toBe(false);
    expect(moveSubtree(forest, "b", "b1")).toBe(forest);
  });

  it("rejects unknown ids and unknown target parents", () => {
    expect(moveSubtree(forest, "ghost", "a")).toBe(forest);
    expect(moveSubtree(forest, "b", "ghost")).toBe(forest);
    expect(canMoveSubtree(forest, "b", "ghost")).toBe(false);
  });

  it("allows legal moves (including to the root)", () => {
    expect(canMoveSubtree(forest, "a", "b")).toBe(true);
    expect(canMoveSubtree(forest, "b1", null)).toBe(true);
    expect(canMoveSubtree(forest, "b", "a")).toBe(true);
  });
});

describe("sub-items: visibleRows", () => {
  const vt: Row[] = [
    r("a", null, 1000),
    r("b", null, 2000),
    r("b1", "b", 1000),
    r("b1x", "b1", 1000),
    r("b2", "b", 2000),
    r("c", null, 3000),
  ];

  it("emits the whole forest in depth order when nothing is collapsed", () => {
    expect(ids(visibleRows(vt, new Set()))).toEqual(["a", "b", "b1", "b1x", "b2", "c"]);
  });

  it("hides the descendants of collapsed nodes only", () => {
    expect(ids(visibleRows(vt, new Set(["b"])))).toEqual(["a", "b", "c"]);
    expect(ids(visibleRows(vt, new Set(["b1"])))).toEqual(["a", "b", "b1", "b2", "c"]);
    expect(ids(visibleRows(vt, new Set(["b", "b1"])))).toEqual(["a", "b", "c"]);
  });

  it("ignores collapse ids that are not in the tree", () => {
    expect(ids(visibleRows(vt, new Set(["missing"])))).toEqual([
      "a",
      "b",
      "b1",
      "b1x",
      "b2",
      "c",
    ]);
    expect(visibleRows([], new Set())).toEqual([]);
  });
});

describe("sub-items: renumberSiblings", () => {
  const messy: Row[] = [
    r("b2", "b", 5),
    r("a", null, 50),
    r("b1", "b", 2),
    r("c", null, 10),
    r("b", null, 20),
  ];

  it("renumbers one sibling group to 1000/2000/3000 spacing", () => {
    const result = renumberSiblings(messy, "b");
    expect(childrenOf(result, "b").map((row) => [row.id, row.order])).toEqual([
      ["b1", 1000],
      ["b2", 2000],
    ]);
  });

  it("renumbers roots without touching other groups", () => {
    const result = renumberSiblings(messy, null);
    expect(childrenOf(result, null).map((row) => row.id)).toEqual(["c", "b", "a"]);
    expect(childrenOf(result, null).map((row) => row.order)).toEqual([1000, 2000, 3000]);
    expect(result.find((row) => row.id === "b1")!.order).toBe(2);
  });

  it("is a no-op when the group has no children", () => {
    expect(renumberSiblings(messy, "zzz")).toBe(messy);
    expect(renumberSiblings([], null)).toEqual([]);
  });
});

describe("sub-items: empty and edge input", () => {
  it("handles empty inputs across the API without throwing", () => {
    expect(childrenOf([], null)).toEqual([]);
    expect(ancestorsOf([], "a")).toEqual([]);
    expect(depthOf([], "a")).toBe(-1);
    expect(subtreeOf([], "a")).toEqual([]);
    expect(validateSubItems([])).toEqual([]);
    expect(visibleRows([], new Set())).toEqual([]);
    expect(renumberSiblings([], null)).toEqual([]);
    expect(indent([], "a")).toEqual([]);
    expect(outdent([], "a")).toEqual([]);
    expect(moveSubtree([], "a", "b")).toEqual([]);
  });

  it("treats a lone row as a depth-0 root with no children", () => {
    const lone = [r("only")];
    expect(depthOf(lone, "only")).toBe(0);
    expect(childrenOf(lone, null)).toEqual(lone);
    expect(ids(visibleRows(lone, new Set()))).toEqual(["only"]);
  });
});

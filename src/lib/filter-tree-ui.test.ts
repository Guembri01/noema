import { describe, expect, it } from "vitest";
import type { FilterOperator, QueryProperty } from "@/lib/database-query";
import {
  addNode,
  depth,
  describeTree,
  findNode,
  findPath,
  isGroup,
  isLeaf,
  leafCount,
  makeGroup,
  makeLeaf,
  moveNode,
  nodeCount,
  normalizeTree,
  removeNode,
  toQueryExpr,
  updateNode,
  validateTree,
  type FilterGroup,
  type FilterLeaf,
  type FilterNode,
} from "@/lib/filter-tree-ui";

/* Fixtures mirror database-query.test.ts / filter-tree.test.ts so the builder
   validates against the exact property + operator vocabulary the evaluator
   already ships. */

const properties: QueryProperty[] = [
  { id: "name", name: "Name", type: "TEXT", config: { primary: true } },
  { id: "estimate", name: "Estimate", type: "NUMBER", config: null },
  {
    id: "status",
    name: "Status",
    type: "STATUS",
    config: {
      options: [
        { id: "todo", name: "To-do", color: "gray" },
        { id: "done", name: "Done", color: "green" },
      ],
    },
  },
  {
    id: "tags",
    name: "Tags",
    type: "MULTI_SELECT",
    config: {
      options: [
        { id: "web", name: "Web", color: "blue" },
        { id: "api", name: "API", color: "purple" },
      ],
    },
  },
  { id: "due", name: "Due", type: "DATE", config: null },
  { id: "done", name: "Done?", type: "CHECKBOX", config: null },
];

const names: Record<string, string> = {
  name: "Name",
  estimate: "Estimate",
  status: "Status",
  tags: "Tags",
  due: "Due",
  done: "Done?",
};

const propertyName = (id: string): string => names[id] ?? id;

const leaf = (
  propertyId: string,
  op: FilterOperator,
  value?: string,
  id?: string,
): FilterLeaf => makeLeaf({ propertyId, op, value, id });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

describe("makeLeaf / makeGroup", () => {
  it("builds a leaf with the given fields", () => {
    const node = makeLeaf({ propertyId: "status", op: "is", value: "done", id: "l1" });
    expect(node).toEqual({ id: "l1", propertyId: "status", op: "is", value: "done" });
  });

  it("omits value when the operator takes none", () => {
    const node = makeLeaf({ propertyId: "due", op: "is_empty", id: "l1" });
    expect("value" in node).toBe(false);
  });

  it("generates unique ids when none is supplied", () => {
    const a = makeLeaf({ propertyId: "name", op: "is", value: "x" });
    const b = makeLeaf({ propertyId: "name", op: "is", value: "x" });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBeTruthy();
  });

  it("defaults a group to AND with no children", () => {
    const group = makeGroup("and", [], "g1");
    expect(group).toEqual({ id: "g1", op: "and", children: [] });
  });

  it("accepts an OR group with children", () => {
    const child = leaf("status", "is", "done", "l1");
    const group = makeGroup("or", [child], "g1");
    expect(group.op).toBe("or");
    expect(group.children).toEqual([child]);
  });

  it("copies the children array so the caller cannot mutate the group", () => {
    const source: FilterNode[] = [leaf("status", "is", "done", "l1")];
    const group = makeGroup("and", source, "g1");
    source.push(leaf("due", "is_empty", undefined, "l2"));
    expect(group.children).toHaveLength(1);
  });

  it("classifies groups and leaves", () => {
    const group = makeGroup("and", [], "g1");
    const child = leaf("status", "is", "done", "l1");
    expect(isGroup(group)).toBe(true);
    expect(isLeaf(group)).toBe(false);
    expect(isGroup(child)).toBe(false);
    expect(isLeaf(child)).toBe(true);
  });
});

describe("addNode", () => {
  it("appends to the root immutably", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    const next = addNode(tree, [], leaf("due", "is_empty", undefined, "l2"));
    expect(tree.children).toHaveLength(1);
    expect(next.children).toHaveLength(2);
    expect(next).not.toBe(tree);
    expect(next.children[1]).toMatchObject({ id: "l2" });
  });

  it("appends into a nested group addressed by path", () => {
    const tree = makeGroup(
      "and",
      [makeGroup("or", [leaf("status", "is", "done", "l1")], "g1")],
      "root",
    );
    const next = addNode(tree, [0], leaf("due", "is_empty", undefined, "l2"));
    const nested = next.children[0] as FilterGroup;
    expect(nested.children.map((c) => c.id)).toEqual(["l1", "l2"]);
  });

  it("returns the same tree for an unknown path", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    expect(addNode(tree, [9], leaf("due", "is_empty", undefined, "l2"))).toBe(tree);
  });

  it("returns the same tree when the path targets a leaf", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    expect(addNode(tree, [0], leaf("due", "is_empty", undefined, "l2"))).toBe(tree);
  });
});

describe("removeNode", () => {
  it("removes a node at a path immutably", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), leaf("due", "is_empty", undefined, "l2")],
      "root",
    );
    const next = removeNode(tree, [0]);
    expect(tree.children).toHaveLength(2);
    expect(next.children.map((c) => c.id)).toEqual(["l2"]);
  });

  it("prunes a group that becomes empty", () => {
    const tree = makeGroup(
      "and",
      [makeGroup("or", [leaf("status", "is", "done", "l1")], "g1")],
      "root",
    );
    const next = removeNode(tree, [0, 0]);
    expect(next.children).toHaveLength(0);
  });

  it("removes an entire subtree", () => {
    const tree = makeGroup(
      "and",
      [
        makeGroup("or", [leaf("status", "is", "done", "l1")], "g1"),
        leaf("due", "is_empty", undefined, "l2"),
      ],
      "root",
    );
    const next = removeNode(tree, [0]);
    expect(next.children.map((c) => c.id)).toEqual(["l2"]);
  });

  it("clears the root for an empty path", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    const next = removeNode(tree, []);
    expect(next.children).toHaveLength(0);
    expect(next.id).toBe("root");
  });

  it("returns the same tree for an invalid path", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    expect(removeNode(tree, [5])).toBe(tree);
    expect(removeNode(tree, [0, 0])).toBe(tree);
  });
});

describe("updateNode", () => {
  it("patches a leaf immutably", () => {
    const tree = makeGroup("and", [leaf("status", "is", "todo", "l1")], "root");
    const next = updateNode(tree, [0], { op: "is_not", value: "done" });
    expect(tree.children[0]).toMatchObject({ op: "is", value: "todo" });
    expect(next.children[0]).toMatchObject({ id: "l1", op: "is_not", value: "done" });
  });

  it("throws when the target is a group", () => {
    const tree = makeGroup("and", [makeGroup("or", [], "g1")], "root");
    expect(() => updateNode(tree, [0], { op: "is" })).toThrow();
  });

  it("returns the same tree for an unknown path", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    expect(updateNode(tree, [7], { value: "x" })).toBe(tree);
  });
});

describe("moveNode", () => {
  it("moves a node into a nested group", () => {
    const tree = makeGroup(
      "and",
      [
        leaf("status", "is", "done", "l1"),
        makeGroup("or", [leaf("due", "is_empty", undefined, "l2")], "g1"),
      ],
      "root",
    );
    const next = moveNode(tree, [0], [1]);
    const nested = next.children.find((c) => c.id === "g1") as FilterGroup;
    expect(nested.children.map((c) => c.id)).toEqual(["l2", "l1"]);
    expect(next.children.map((c) => c.id)).toEqual(["g1"]);
  });

  it("moves a node to the end of its own parent", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), leaf("due", "is_empty", undefined, "l2")],
      "root",
    );
    const next = moveNode(tree, [0], []);
    expect(next.children.map((c) => c.id)).toEqual(["l2", "l1"]);
  });

  it("prevents moving a group into its own descendant", () => {
    const tree = makeGroup(
      "and",
      [makeGroup("or", [makeGroup("and", [leaf("status", "is", "done", "l1")], "g2")], "g1")],
      "root",
    );
    expect(moveNode(tree, [0], [0, 0])).toBe(tree);
  });

  it("moves a node into an ancestor without losing it", () => {
    const tree = makeGroup(
      "and",
      [makeGroup("or", [leaf("status", "is", "done", "l1")], "g1")],
      "root",
    );
    const next = moveNode(tree, [0, 0], [0]);
    expect(next).toEqual(tree);
    expect(findNode(next, "l1")).not.toBeNull();
  });

  it("refuses to move the root", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    expect(moveNode(tree, [], [0])).toBe(tree);
  });

  it("no-ops on an unknown source or a non-group destination", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), makeGroup("or", [], "g1")],
      "root",
    );
    expect(moveNode(tree, [9], [])).toBe(tree);
    expect(moveNode(tree, [1], [0])).toBe(tree);
  });
});

describe("depth / nodeCount / leafCount", () => {
  it("counts group nesting depth with the root as one", () => {
    expect(depth(makeGroup("and", [], "root"))).toBe(1);
    const flat = makeGroup("and", [leaf("a", "is", undefined, "l1")], "root");
    expect(depth(flat)).toBe(1);
    const nested = makeGroup(
      "and",
      [makeGroup("or", [makeGroup("and", [leaf("a", "is", undefined, "l1")], "g2")], "g1")],
      "root",
    );
    expect(depth(nested)).toBe(3);
  });

  it("counts every node and every leaf", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), makeGroup("or", [leaf("due", "is_empty", undefined, "l2")], "g1")],
      "root",
    );
    expect(nodeCount(tree)).toBe(4);
    expect(leafCount(tree)).toBe(2);
  });
});

describe("findNode / findPath", () => {
  it("finds a nested node by id", () => {
    const tree = makeGroup(
      "and",
      [makeGroup("or", [leaf("status", "is", "done", "l1")], "g1")],
      "root",
    );
    expect(findNode(tree, "l1")).toMatchObject({ id: "l1", propertyId: "status" });
    expect(findNode(tree, "g1")).toMatchObject({ id: "g1", op: "or" });
  });

  it("returns null for a missing id", () => {
    const tree = makeGroup("and", [], "root");
    expect(findNode(tree, "absent")).toBeNull();
  });

  it("returns the path to a node", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), makeGroup("or", [leaf("due", "is_empty", undefined, "l2")], "g1")],
      "root",
    );
    expect(findPath(tree, "l1")).toEqual([0]);
    expect(findPath(tree, "l2")).toEqual([1, 0]);
    expect(findPath(tree, "root")).toEqual([]);
    expect(findPath(tree, "absent")).toBeNull();
  });
});

describe("validateTree", () => {
  it("accepts a valid tree", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), makeGroup("or", [leaf("due", "before", "2026-02-01", "l2")], "g1")],
      "root",
    );
    expect(validateTree(tree, { properties })).toEqual([]);
  });

  it("flags an unknown property", () => {
    const tree = makeGroup("and", [leaf("ghost", "is", "x", "l1")], "root");
    const issues = validateTree(tree, { properties });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unknown_property", path: [0] });
  });

  it("flags an unknown operator", () => {
    const bad = { ...leaf("status", "is", "done", "l1"), op: "bogus" as unknown as FilterOperator };
    const tree = makeGroup("and", [bad], "root");
    const issues = validateTree(tree, { properties });
    expect(issues.map((issue) => issue.code)).toContain("unknown_operator");
  });

  it("flags an operator the property type cannot use", () => {
    const tree = makeGroup("and", [leaf("estimate", "before", "2026-02-01", "l1")], "root");
    const issues = validateTree(tree, { properties });
    expect(issues.map((issue) => issue.code)).toContain("type_mismatch");
  });

  it("flags empty groups", () => {
    const tree = makeGroup("and", [makeGroup("or", [], "g1")], "root");
    const issues = validateTree(tree, { properties });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "empty_group", path: [0] });
  });

  it("flags nesting past the depth cap", () => {
    const deep = makeGroup(
      "and",
      [makeGroup("and", [makeGroup("and", [makeGroup("and", [leaf("status", "is", "done", "l1")], "g3")], "g2")], "g1")],
      "root",
    );
    const issues = validateTree(deep, { properties, maxDepth: 3 });
    expect(issues.map((issue) => issue.code)).toContain("depth_exceeded");
  });

  it("reports every problem it finds", () => {
    const tree = makeGroup(
      "and",
      [leaf("ghost", "is", "x", "l1"), makeGroup("or", [], "g1")],
      "root",
    );
    const codes = validateTree(tree, { properties }).map((issue) => issue.code);
    expect(codes).toContain("unknown_property");
    expect(codes).toContain("empty_group");
  });
});

describe("normalizeTree", () => {
  it("collapses a redundant single-child nested group", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), makeGroup("or", [leaf("due", "is_empty", undefined, "l2")], "g1")],
      "root",
    );
    const next = normalizeTree(tree);
    expect(next.children.map((c) => c.id)).toEqual(["l1", "l2"]);
    expect(next).toEqual(
      makeGroup("and", [leaf("status", "is", "done", "l1"), leaf("due", "is_empty", undefined, "l2")], "root"),
    );
  });

  it("hoists a single-child root group", () => {
    const tree = makeGroup(
      "and",
      [makeGroup("or", [leaf("status", "is", "done", "l1"), leaf("due", "is_empty", undefined, "l2")], "g1")],
      "root",
    );
    const next = normalizeTree(tree);
    expect(next.id).toBe("g1");
    expect(next.op).toBe("or");
    expect(next.children).toHaveLength(2);
  });

  it("leaves a multi-child tree intact", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), makeGroup("or", [leaf("due", "is_empty", undefined, "l2"), leaf("name", "contains", "a", "l3")], "g1")],
      "root",
    );
    expect(normalizeTree(tree)).toEqual(tree);
    expect(depth(normalizeTree(tree))).toBe(2);
  });

  it("is idempotent", () => {
    const tree = makeGroup(
      "and",
      [makeGroup("and", [makeGroup("or", [leaf("status", "is", "done", "l1")], "g2")], "g1")],
      "root",
    );
    const once = normalizeTree(tree);
    expect(normalizeTree(once)).toEqual(once);
  });
});

describe("toQueryExpr", () => {
  it("maps a single leaf", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    expect(toQueryExpr(tree)).toEqual({ propertyId: "status", op: "is", value: "done" });
  });

  it("nests AND and OR groups", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), makeGroup("or", [leaf("estimate", "gt", "5", "l2"), leaf("due", "after", "2026-01-01", "l3")], "g1")],
      "root",
    );
    expect(toQueryExpr(tree)).toEqual({
      AND: [
        { propertyId: "status", op: "is", value: "done" },
        {
          OR: [
            { propertyId: "estimate", op: "gt", value: "5" },
            { propertyId: "due", op: "after", value: "2026-01-01" },
          ],
        },
      ],
    });
  });

  it("collapses a single-child group", () => {
    const tree = makeGroup("or", [makeGroup("and", [leaf("status", "is", "done", "l1")], "g1")], "root");
    expect(toQueryExpr(tree)).toEqual({ propertyId: "status", op: "is", value: "done" });
  });

  it("renders an empty group as an empty conjunction list", () => {
    expect(toQueryExpr(makeGroup("and", [], "root"))).toEqual({ AND: [] });
    expect(toQueryExpr(makeGroup("or", [], "root"))).toEqual({ OR: [] });
  });
});

describe("describeTree", () => {
  it("renders AND/OR nested groups with parentheses", () => {
    const tree = makeGroup(
      "and",
      [
        leaf("status", "is", "Done", "l1"),
        makeGroup("or", [leaf("estimate", "is", "High", "l2"), leaf("due", "before", "2026-02-01", "l3")], "g1"),
      ],
      "root",
    );
    expect(describeTree(tree, { propertyName })).toBe(
      "Status is Done AND (Estimate is High OR Due is before 2026-02-01)",
    );
  });

  it("uses plain labels for valueless operators", () => {
    const tree = makeGroup(
      "and",
      [leaf("due", "is_empty", undefined, "l1"), leaf("done", "checked", undefined, "l2"), leaf("name", "is_not_empty", undefined, "l3")],
      "root",
    );
    expect(describeTree(tree, { propertyName })).toBe(
      "Due is empty AND Done? is checked AND Name is not empty",
    );
  });

  it("falls back to the property id without a name resolver", () => {
    const tree = makeGroup("and", [leaf("status", "is", "done", "l1")], "root");
    expect(describeTree(tree)).toBe("status is done");
  });

  it("returns an empty string for an empty root", () => {
    expect(describeTree(makeGroup("and", [], "root"))).toBe("");
  });
});

describe("immutability", () => {
  it("never mutates a frozen tree", () => {
    const tree = deepFreeze(
      makeGroup(
        "and",
        [leaf("status", "is", "todo", "l1"), makeGroup("or", [leaf("due", "is_empty", undefined, "l2")], "g1")],
        "root",
      ),
    );
    expect(() => addNode(tree, [], leaf("name", "contains", "a", "l3"))).not.toThrow();
    expect(() => removeNode(tree, [1, 0])).not.toThrow();
    expect(() => updateNode(tree, [0], { op: "is_not" })).not.toThrow();
    expect(() => moveNode(tree, [0], [1])).not.toThrow();
  });

  it("returns a fresh root for every successful edit", () => {
    const tree = makeGroup(
      "and",
      [leaf("status", "is", "done", "l1"), makeGroup("or", [leaf("due", "is_empty", undefined, "l2")], "g1")],
      "root",
    );
    expect(addNode(tree, [], leaf("name", "contains", "a", "l3"))).not.toBe(tree);
    expect(removeNode(tree, [0])).not.toBe(tree);
    expect(updateNode(tree, [0], { value: "done" })).not.toBe(tree);
    expect(moveNode(tree, [0], [1])).not.toBe(tree);
  });
});

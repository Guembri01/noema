import { describe, expect, it } from "vitest";
import type { QueryProperty, QueryRow } from "@/lib/database-query";
import {
  countActiveFilters,
  evaluateFilterTree,
  hasActiveFilters,
  isFilterGroup,
  removeFilterById,
  replaceFilter,
  type FilterGroup,
  type FilterTreeLeaf,
  type FilterTreeNode,
} from "@/lib/filter-tree";

/* Fixtures mirror database-query.test.ts so tree semantics are compared
   against the exact values the flat evaluator is already tested with. */

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
];

const row = (
  id: string,
  title: string,
  values: Record<string, unknown>,
): QueryRow => ({
  id,
  title,
  icon: null,
  propertyValues: Object.entries(values).map(([propertyId, value]) => ({
    propertyId,
    value,
  })),
});

const alpha = row("1", "Alpha", {
  estimate: { number: 5 },
  status: { optionId: "todo" },
  due: { start: "2026-03-01" },
  tags: { optionIds: ["web"] },
});
const beta = row("2", "Beta", {
  estimate: { number: 2 },
  status: { optionId: "done" },
  due: { start: "2026-01-15" },
  tags: { optionIds: ["api"] },
});
const gamma = row("3", "Gamma", {
  estimate: { number: 9 },
  status: { optionId: "todo" },
});
const rows = [alpha, beta, gamma];

const matches = (tree: FilterTreeNode) =>
  rows.filter((r) => evaluateFilterTree(tree, r, properties)).map((r) => r.id);

const leaf = (id: string, propertyId: string, operator: FilterTreeLeaf["operator"], value?: string): FilterTreeLeaf =>
  value === undefined ? { id, propertyId, operator } : { id, propertyId, operator, value };

const group = (conjunction: "AND" | "OR", children: FilterTreeNode[]): FilterGroup => ({
  conjunction,
  children,
});

describe("evaluateFilterTree — leaves", () => {
  it("evaluates a single leaf against a row", () => {
    const tree = leaf("f1", "name", "contains", "amm");
    expect(matches(tree)).toEqual(["3"]);
  });

  it("reuses the flat operator vocabulary (is/contains/is_empty/gt)", () => {
    expect(matches(leaf("f1", "status", "is", "To-do"))).toEqual(["1", "3"]);
    expect(matches(leaf("f1", "tags", "contains", "api"))).toEqual(["2"]);
    expect(matches(leaf("f1", "due", "is_empty"))).toEqual(["3"]);
    expect(matches(leaf("f1", "estimate", "gt", "4"))).toEqual(["1", "3"]);
    expect(matches(leaf("f1", "due", "before", "2026-02-01"))).toEqual(["2"]);
  });

  it("treats a leaf on an unknown property as neutral (matches flat behaviour)", () => {
    expect(matches(leaf("f1", "ghost", "is", "x"))).toEqual(["1", "2", "3"]);
  });

  it("accepts leaves without an id (ids are only needed for editing)", () => {
    const tree: FilterTreeNode = { propertyId: "estimate", operator: "gte", value: "5" };
    expect(matches(tree)).toEqual(["1", "3"]);
  });
});

describe("evaluateFilterTree — groups", () => {
  it("AND group requires every child", () => {
    const tree = group("AND", [
      leaf("f1", "status", "is", "To-do"),
      leaf("f2", "estimate", "gt", "4"),
    ]);
    expect(matches(tree)).toEqual(["1", "3"]);
  });

  it("OR group requires any child", () => {
    const tree = group("OR", [
      leaf("f1", "status", "is", "Done"),
      leaf("f2", "estimate", "gt", "4"),
    ]);
    expect(matches(tree)).toEqual(["1", "2", "3"]);
  });

  it("negation operators compose like the flat filters", () => {
    const tree = group("AND", [
      leaf("f1", "tags", "does_not_contain", "api"),
      leaf("f2", "status", "is_not", "Done"),
    ]);
    expect(matches(tree)).toEqual(["1", "3"]);
  });

  it("nested AND-of-OR", () => {
    const tree = group("AND", [
      group("OR", [
        leaf("f1", "name", "contains", "alpha"),
        leaf("f2", "name", "contains", "beta"),
      ]),
      leaf("f3", "estimate", "lt", "3"),
    ]);
    expect(matches(tree)).toEqual(["2"]);
  });

  it("nested OR-of-AND", () => {
    const tree = group("OR", [
      group("AND", [
        leaf("f1", "status", "is", "To-do"),
        leaf("f2", "estimate", "gt", "6"),
      ]),
      group("AND", [leaf("f3", "status", "is", "Done")]),
    ]);
    expect(matches(tree)).toEqual(["2", "3"]);
  });

  it("deep mixed nesting (AND of OR of AND of OR)", () => {
    const tree = group("AND", [
      leaf("f1", "status", "is", "To-do"),
      group("OR", [
        group("AND", [
          leaf("f2", "estimate", "gt", "8"),
          leaf("f3", "due", "before", "2026-06-01"),
        ]),
        group("AND", [
          leaf("f4", "tags", "contains", "web"),
          leaf("f5", "due", "after", "2026-02-01"),
        ]),
      ]),
    ]);
    expect(matches(tree)).toEqual(["1"]);
  });

  it("empty groups are neutral (true for both AND and OR)", () => {
    expect(matches(group("AND", []))).toEqual(["1", "2", "3"]);
    expect(matches(group("OR", []))).toEqual(["1", "2", "3"]);
    expect(matches(group("AND", [group("OR", [])]))).toEqual(["1", "2", "3"]);
  });

  it("agrees with applyFilters for a flat AND of leaves", () => {
    const tree = group("AND", [
      leaf("f1", "estimate", "gt", "4"),
      leaf("f2", "tags", "contains", "web"),
    ]);
    expect(matches(tree)).toEqual(["1"]);
  });
});

describe("countActiveFilters / hasActiveFilters", () => {
  it("counts a single leaf", () => {
    const tree = leaf("f1", "estimate", "gt", "4");
    expect(countActiveFilters(tree)).toBe(1);
    expect(hasActiveFilters(tree)).toBe(true);
  });

  it("sums leaves across nested groups", () => {
    const tree = group("AND", [
      leaf("f1", "status", "is", "To-do"),
      group("OR", [
        leaf("f2", "estimate", "gt", "8"),
        group("AND", [leaf("f3", "due", "is_empty")]),
      ]),
    ]);
    expect(countActiveFilters(tree)).toBe(3);
    expect(hasActiveFilters(tree)).toBe(true);
  });

  it("reports no filters for an empty group", () => {
    expect(countActiveFilters(group("AND", []))).toBe(0);
    expect(hasActiveFilters(group("OR", []))).toBe(false);
  });
});

describe("removeFilterById", () => {
  it("removes a deeply nested leaf and leaves siblings intact", () => {
    const tree = group("AND", [
      leaf("f1", "status", "is", "To-do"),
      group("OR", [
        leaf("f2", "estimate", "gt", "8"),
        leaf("f3", "due", "is_empty"),
      ]),
    ]);
    const out = removeFilterById(tree, "f2");
    expect(countActiveFilters(out)).toBe(2);
    expect(out).toEqual(
      group("AND", [
        leaf("f1", "status", "is", "To-do"),
        group("OR", [leaf("f3", "due", "is_empty")]),
      ]),
    );
    // Original tree untouched (immutable edit).
    expect(countActiveFilters(tree)).toBe(3);
  });

  it("keeps groups (even emptied ones) so structure survives", () => {
    const tree = group("AND", [
      leaf("f1", "estimate", "gt", "4"),
      group("OR", [leaf("f2", "status", "is", "Done")]),
    ]);
    const out = removeFilterById(tree, "f2");
    expect(out).toEqual(
      group("AND", [
        leaf("f1", "estimate", "gt", "4"),
        group("OR", []),
      ]),
    );
    // The emptied OR group is neutral, so it no longer excludes anything.
    expect(matches(out)).toEqual(["1", "3"]);
  });

  it("returns the same reference when the id is absent", () => {
    const tree = group("AND", [leaf("f1", "estimate", "gt", "4")]);
    expect(removeFilterById(tree, "nope")).toBe(tree);
  });

  it("removes a bare leaf root by id", () => {
    const tree = leaf("f1", "estimate", "gt", "4");
    expect(removeFilterById(tree, "f1")).toEqual(group("AND", []));
  });
});

describe("replaceFilter", () => {
  it("replaces a nested leaf without touching siblings", () => {
    const tree = group("AND", [
      leaf("f1", "status", "is", "To-do"),
      group("OR", [leaf("f2", "estimate", "gt", "8")]),
    ]);
    const out = replaceFilter(tree, "f2", leaf("f2", "estimate", "lt", "6"));
    expect(out).toEqual(
      group("AND", [
        leaf("f1", "status", "is", "To-do"),
        group("OR", [leaf("f2", "estimate", "lt", "6")]),
      ]),
    );
    expect(matches(out)).toEqual(["1"]);
    expect(countActiveFilters(tree)).toBe(2);
  });

  it("can replace a leaf with a group (leaf → nested group)", () => {
    const tree = group("OR", [leaf("f1", "estimate", "gt", "8")]);
    const out = replaceFilter(
      tree,
      "f1",
      group("AND", [
        leaf("f1", "status", "is", "To-do"),
        leaf("f2", "estimate", "gt", "4"),
      ]),
    );
    expect(out).toEqual(
      group("OR", [
        group("AND", [
          leaf("f1", "status", "is", "To-do"),
          leaf("f2", "estimate", "gt", "4"),
        ]),
      ]),
    );
    expect(matches(out)).toEqual(["1", "3"]);
  });

  it("returns the same reference when the id is absent", () => {
    const tree = group("AND", [leaf("f1", "estimate", "gt", "4")]);
    expect(replaceFilter(tree, "nope", leaf("x", "name", "is", "Alpha"))).toBe(tree);
  });

  it("does not mutate the original tree", () => {
    const tree = group("AND", [leaf("f1", "estimate", "gt", "4")]);
    const snapshot = JSON.parse(JSON.stringify(tree));
    replaceFilter(tree, "f1", leaf("f1", "estimate", "lt", "4"));
    removeFilterById(tree, "f1");
    expect(tree).toEqual(snapshot);
  });
});

describe("isFilterGroup", () => {
  it("distinguishes groups from leaves", () => {
    expect(isFilterGroup(group("AND", []))).toBe(true);
    expect(isFilterGroup(leaf("f1", "estimate", "gt", "4"))).toBe(false);
  });
});

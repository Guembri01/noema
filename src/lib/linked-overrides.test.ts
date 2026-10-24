import { describe, expect, it } from "vitest";
import { makeGroup, makeLeaf } from "./filter-tree-ui";
import {
  addFilterLeaf,
  clearFilterAndSortOverrides,
  filterBuilderFromConfig,
  filterLeaves,
  removeFilterLeaf,
  setFilterMatch,
  updateFilterLeaf,
} from "./linked-overrides";

describe("filterBuilderFromConfig", () => {
  it("seeds from the legacy flat filters", () => {
    const tree = filterBuilderFromConfig({
      filters: [{ propertyId: "status", operator: "is", value: "Done" }],
      filterMode: "or",
    });
    expect(tree.op).toBe("or");
    expect(filterLeaves(tree)).toMatchObject([
      { propertyId: "status", op: "is", value: "Done" },
    ]);
  });

  it("seeds from a nested filter tree, preserving groups", () => {
    const tree = filterBuilderFromConfig({
      filterTree: [
        { propertyId: "status", operator: "is", value: "Done" },
        {
          or: [
            { propertyId: "estimate", operator: "gt", value: "3" },
            { propertyId: "owner", operator: "is_empty" },
          ],
        },
      ],
    });
    expect(tree.children).toHaveLength(2);
    expect(tree.children[1]).toMatchObject({ op: "or" });
    expect(filterLeaves(tree).map((leaf) => leaf.propertyId)).toEqual([
      "status",
      "estimate",
      "owner",
    ]);
  });

  it("keeps an existing builder root", () => {
    const builder = makeGroup("and", [makeLeaf({ propertyId: "a", op: "is_empty" })], "root");
    expect(filterBuilderFromConfig({ filterBuilder: builder })).toStrictEqual(builder);
  });

  it("normalizes malformed leaves away", () => {
    const tree = filterBuilderFromConfig({
      filters: [{ propertyId: "", operator: "is" }],
    });
    expect(tree.children).toHaveLength(0);
  });
});

describe("filter builder edits", () => {
  it("adds and updates a leaf without mutating the input", () => {
    const tree = makeGroup("and", [], "root");
    const added = addFilterLeaf(tree, { propertyId: "status", op: "is", value: "Done" });
    expect(tree.children).toHaveLength(0);
    const leaf = filterLeaves(added)[0];
    const updated = updateFilterLeaf(added, leaf.id, { value: "In progress" });
    expect(filterLeaves(updated)[0].value).toBe("In progress");
    expect(filterLeaves(added)[0].value).toBe("Done");
  });

  it("removes a nested leaf and leaves its group in place", () => {
    const tree = makeGroup(
      "and",
      [
        makeLeaf({ propertyId: "status", op: "is", value: "Done", id: "outer" }),
        makeGroup(
          "or",
          [
            makeLeaf({ propertyId: "estimate", op: "gt", value: "2", id: "inner" }),
            makeLeaf({ propertyId: "owner", op: "is_empty", id: "keep" }),
          ],
          "group",
        ),
      ],
      "root",
    );
    const next = removeFilterLeaf(tree, "inner");
    expect(filterLeaves(next).map((leaf) => leaf.id)).toEqual(["outer", "keep"]);
    expect(next.children[1]).toMatchObject({ id: "group", op: "or" });
  });

  it("changes only the root conjunction", () => {
    const tree = makeGroup(
      "and",
      [makeGroup("or", [makeLeaf({ propertyId: "a", op: "is_empty" })], "nested")],
      "root",
    );
    const next = setFilterMatch(tree, "or");
    expect(next.op).toBe("or");
    expect(next.children[0]).toMatchObject({ op: "or" });
  });
});

describe("clearFilterAndSortOverrides", () => {
  it("keeps display overrides and removes every row-selection key", () => {
    expect(
      clearFilterAndSortOverrides({
        visiblePropertyIds: ["a"],
        filters: [{ propertyId: "a", operator: "is_empty" }],
        filterTree: [],
        filterBuilder: makeGroup("and"),
        sorts: [{ propertyId: "a", direction: "asc" }],
      }),
    ).toEqual({ visiblePropertyIds: ["a"] });
  });
});

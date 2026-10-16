import { describe, expect, it } from "vitest";
import {
  collectBuilderGroupOptions,
  setBuilderGroupOp,
} from "@/components/database/view-settings";
import { makeGroup, makeLeaf } from "@/lib/filter-tree-ui";

/**
 * Proves the settings toolbar actually holds the `@/lib/filter-tree-ui` builder
 * (the module was unwired before fix05): the move destinations and the immutable
 * conjunction editor are the pure helpers the builder popover drives.
 */
describe("view-settings builder wiring (filter-tree-ui)", () => {
  it("collects group move destinations in discovery order", () => {
    const tree = makeGroup(
      "and",
      [
        makeLeaf({ propertyId: "status", op: "is", value: "done", id: "l1" }),
        makeGroup(
          "or",
          [makeLeaf({ propertyId: "name", op: "contains", value: "a", id: "l2" })],
          "g1",
        ),
      ],
      "root",
    );
    expect(collectBuilderGroupOptions(tree)).toEqual([
      { id: "root", label: "Group 1 (ALL)" },
      { id: "g1", label: "Group 2 (ANY)" },
    ]);
  });

  it("switches a nested group's conjunction without mutating the input", () => {
    const tree = makeGroup(
      "and",
      [
        makeGroup(
          "and",
          [makeLeaf({ propertyId: "status", op: "is", value: "done", id: "l1" })],
          "g1",
        ),
      ],
      "root",
    );
    const next = setBuilderGroupOp(tree, [0], "or");
    expect((next.children[0] as { op: string }).op).toBe("or");
    // The original tree is untouched (immutable edit).
    expect((tree.children[0] as { op: string }).op).toBe("and");
    // Path `[]` edits the root group.
    expect(setBuilderGroupOp(tree, [], "or").op).toBe("or");
  });
});

import { describe, expect, it } from "vitest";
import {
  collectBacklinks,
  describeMove,
  extractRange,
  insertBlocks,
  isSamePage,
  moveBlocks,
  planBlockMove,
  validateMove,
} from "@/lib/block-move";
import type { BlockPage, IdFactory, MoveBlock } from "@/lib/block-move";

/** Deterministic factory: `new-1`, `new-2`, … in allocation order. */
function seqFactory(start = 1): IdFactory {
  let n = start - 1;
  return () => {
    n += 1;
    return `new-${n}`;
  };
}

/**
 * Source page. Index map: 0=p1, 1=list1, 2=p2, 3=p3, 4=p4.
 * `p1` links the last block and `p2` links `p3`, so moving one side of either
 * link produces exactly one cross-reference warning.
 */
function pageA(): BlockPage {
  return {
    id: "page-a",
    blocks: [
      { id: "p1", type: "paragraph", text: "Intro", refBlockId: "p4" },
      {
        id: "list1",
        type: "bulletList",
        children: [
          { id: "li1", type: "listItem", text: "one" },
          { id: "li2", type: "listItem", text: "two" },
        ],
      },
      { id: "p2", type: "paragraph", text: "Middle", refBlockId: "p3" },
      { id: "p3", type: "paragraph", text: "Tail" },
      { id: "p4", type: "paragraph", text: "Last" },
    ],
  };
}

/** Destination page with no id overlaps. */
function pageB(): BlockPage {
  return {
    id: "page-b",
    blocks: [
      { id: "t1", type: "paragraph", text: "Target 1" },
      { id: "t2", type: "paragraph", text: "Target 2" },
    ],
  };
}

describe("extractRange", () => {
  it("extracts a half-open top-level range and keeps the rest", () => {
    const { moved, remaining } = extractRange(pageA(), { startIndex: 1, endIndex: 3 });
    expect(moved.map((b) => b.id)).toEqual(["list1", "p2"]);
    expect(remaining.blocks.map((b) => b.id)).toEqual(["p1", "p3", "p4"]);
    expect(remaining.id).toBe("page-a");
  });

  it("carries a moved list's whole subtree", () => {
    const { moved, remaining } = extractRange(pageA(), { startIndex: 1, endIndex: 2 });
    expect(moved).toHaveLength(1);
    expect(moved[0].children?.map((c) => c.id)).toEqual(["li1", "li2"]);
    expect(remaining.blocks.some((b) => b.type === "bulletList")).toBe(false);
  });

  it("clamps an out-of-range range to the document bounds", () => {
    const { moved, remaining } = extractRange(pageA(), { startIndex: -5, endIndex: 99 });
    expect(moved).toHaveLength(5);
    expect(remaining.blocks).toEqual([]);
  });

  it("treats a reversed range as empty", () => {
    const { moved, remaining } = extractRange(pageA(), { startIndex: 3, endIndex: 1 });
    expect(moved).toEqual([]);
    expect(remaining.blocks.map((b) => b.id)).toEqual(["p1", "list1", "p2", "p3", "p4"]);
  });

  it("treats an empty range as empty", () => {
    const { moved } = extractRange(pageA(), { startIndex: 2, endIndex: 2 });
    expect(moved).toEqual([]);
  });

  it("expands a partial selection of sibling list items to the whole run", () => {
    const doc: BlockPage = {
      id: "p",
      blocks: [
        { id: "i1", type: "listItem" },
        { id: "i2", type: "listItem" },
        { id: "i3", type: "listItem" },
      ],
    };
    const { moved, remaining } = extractRange(doc, { startIndex: 1, endIndex: 2 });
    expect(moved.map((b) => b.id)).toEqual(["i1", "i2", "i3"]);
    expect(remaining.blocks).toEqual([]);
  });

  it("does not expand a run when the range starts on a paragraph", () => {
    const doc: BlockPage = {
      id: "p",
      blocks: [
        { id: "i1", type: "listItem" },
        { id: "para", type: "paragraph" },
        { id: "i2", type: "listItem" },
      ],
    };
    const { moved } = extractRange(doc, { startIndex: 1, endIndex: 2 });
    expect(moved.map((b) => b.id)).toEqual(["para"]);
  });

  it("does not mutate the source document and returns independent clones", () => {
    const doc = pageA();
    const before = JSON.stringify(doc);
    const { moved } = extractRange(doc, { startIndex: 0, endIndex: 1 });
    moved[0].text = "changed";
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("insertBlocks", () => {
  it("inserts blocks at an index and leaves the input alone", () => {
    const doc = pageB();
    const next = insertBlocks(doc, [{ id: "x", type: "paragraph" }], 1);
    expect(next.blocks.map((b) => b.id)).toEqual(["t1", "x", "t2"]);
    expect(doc.blocks.map((b) => b.id)).toEqual(["t1", "t2"]);
  });

  it("clamps the insertion index into range", () => {
    const block: MoveBlock = { id: "x", type: "paragraph" };
    expect(insertBlocks(pageB(), [block], 99).blocks.map((b) => b.id)).toEqual(["t1", "t2", "x"]);
    expect(insertBlocks(pageB(), [block], -4).blocks.map((b) => b.id)).toEqual(["x", "t1", "t2"]);
  });

  it("clones the inserted blocks", () => {
    const block: MoveBlock = { id: "x", type: "paragraph", text: "hi" };
    const next = insertBlocks(pageB(), [block], 0);
    next.blocks[0].text = "changed";
    expect(block.text).toBe("hi");
  });

  it("is a pass-through for an empty insert", () => {
    expect(insertBlocks(pageB(), [], 1).blocks.map((b) => b.id)).toEqual(["t1", "t2"]);
  });
});

describe("moveBlocks", () => {
  it("removes from the source page and inserts into the destination", () => {
    const result = moveBlocks(
      { from: pageA(), to: pageB() },
      { indices: [4], targetIndex: 1 },
      { idFactory: seqFactory() },
    );
    expect(result.fromDoc.blocks.map((b) => b.id)).toEqual(["p1", "list1", "p2", "p3"]);
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["t1", "p4", "t2"]);
    expect(result.idMap.size).toBe(0);
  });

  it("flags an incoming backlink that the move strands", () => {
    const result = moveBlocks(
      { from: pageA(), to: pageB() },
      { indices: [4], targetIndex: 1 },
    );
    expect(result.warnings).toEqual([{ code: "backlink", blockId: "p4", relatedBlockId: "p1" }]);
  });

  it("flags an outgoing reference to a block left behind", () => {
    const result = moveBlocks({ from: pageA(), to: pageB() }, { indices: [2], targetIndex: 0 });
    expect(result.fromDoc.blocks.map((b) => b.id)).toEqual(["p1", "list1", "p3", "p4"]);
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["p2", "t1", "t2"]);
    expect(result.warnings).toEqual([{ code: "reference", blockId: "p2", relatedBlockId: "p3" }]);
  });

  it("moves a non-contiguous selection in source order", () => {
    const result = moveBlocks({ from: pageA(), to: pageB() }, { indices: [2, 0], targetIndex: 1 });
    expect(result.fromDoc.blocks.map((b) => b.id)).toEqual(["list1", "p3", "p4"]);
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["t1", "p1", "p2", "t2"]);
    expect(result.warnings).toEqual([
      { code: "reference", blockId: "p1", relatedBlockId: "p4" },
      { code: "reference", blockId: "p2", relatedBlockId: "p3" },
    ]);
  });

  it("clamps the destination index to the target page", () => {
    const result = moveBlocks({ from: pageA(), to: pageB() }, { indices: [0], targetIndex: 99 });
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["t1", "t2", "p1"]);
  });

  it("mints a fresh id when a moved id collides with the target page", () => {
    const from: BlockPage = { id: "page-a", blocks: [{ id: "dup", type: "paragraph", text: "from" }] };
    const to: BlockPage = { id: "page-b", blocks: [{ id: "dup", type: "heading", text: "target" }] };
    const result = moveBlocks({ from, to }, { indices: [0], targetIndex: 1 }, { idFactory: seqFactory() });
    expect(result.idMap.get("dup")).toBe("new-1");
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["dup", "new-1"]);
    expect(result.fromDoc.blocks).toEqual([]);
  });

  it("re-mints a colliding id inside a moved subtree", () => {
    const from: BlockPage = {
      id: "page-a",
      blocks: [{ id: "L", type: "bulletList", children: [{ id: "dup", type: "listItem" }] }],
    };
    const to: BlockPage = { id: "page-b", blocks: [{ id: "dup", type: "paragraph" }] };
    const result = moveBlocks({ from, to }, { indices: [0], targetIndex: 0 }, { idFactory: seqFactory() });
    expect(result.idMap.get("dup")).toBe("new-1");
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["L", "dup"]);
    expect(result.toDoc.blocks[0].children?.[0].id).toBe("new-1");
  });

  it("remaps an internal reference to a re-minted id", () => {
    const from: BlockPage = {
      id: "page-a",
      blocks: [
        { id: "dup", type: "paragraph" },
        { id: "ref", type: "block_ref", refBlockId: "dup" },
      ],
    };
    const to: BlockPage = { id: "page-b", blocks: [{ id: "dup", type: "paragraph" }] };
    const result = moveBlocks({ from, to }, { indices: [0, 1], targetIndex: 1 }, { idFactory: seqFactory() });
    expect(result.idMap.get("dup")).toBe("new-1");
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["dup", "new-1", "ref"]);
    expect(result.toDoc.blocks[2].refBlockId).toBe("new-1");
  });

  it("reorders within one page without minting ids or warnings", () => {
    const doc = pageA();
    const result = moveBlocks({ from: doc, to: doc }, { indices: [0], targetIndex: 3 });
    expect(result.idMap.size).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.fromDoc.blocks.map((b) => b.id)).toEqual(["list1", "p2", "p1", "p3", "p4"]);
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["list1", "p2", "p1", "p3", "p4"]);
  });

  it("adjusts a same-page move down for the removed items", () => {
    const doc = pageA();
    const result = moveBlocks({ from: doc, to: doc }, { indices: [0, 1], targetIndex: 4 });
    expect(result.fromDoc.blocks.map((b) => b.id)).toEqual(["p2", "p3", "p1", "list1", "p4"]);
  });

  it("does not mutate either input page", () => {
    const from = pageA();
    const to = pageB();
    const fromBefore = JSON.stringify(from);
    const toBefore = JSON.stringify(to);
    moveBlocks({ from, to }, { indices: [1], targetIndex: 0 }, { idFactory: seqFactory() });
    expect(JSON.stringify(from)).toBe(fromBefore);
    expect(JSON.stringify(to)).toBe(toBefore);
  });

  it("is a no-op for an empty selection", () => {
    const result = moveBlocks({ from: pageA(), to: pageB() }, { indices: [], targetIndex: 0 });
    expect(result.fromDoc.blocks.map((b) => b.id)).toEqual(["p1", "list1", "p2", "p3", "p4"]);
    expect(result.toDoc.blocks.map((b) => b.id)).toEqual(["t1", "t2"]);
    expect(result.idMap.size).toBe(0);
  });
});

describe("collectBacklinks", () => {
  it("finds blocks left behind that reference a moved block", () => {
    const doc = pageA();
    expect(collectBacklinks(doc, [doc.blocks[4]])).toEqual([
      { blockId: "p4", sourceBlockId: "p1" },
    ]);
  });

  it("ignores references that stay inside the moved set", () => {
    const doc = pageA();
    expect(collectBacklinks(doc, [doc.blocks[2], doc.blocks[3]])).toEqual([]);
  });

  it("recognizes array refs and inline mentions", () => {
    const doc: BlockPage = {
      id: "p",
      blocks: [
        { id: "a", type: "paragraph" },
        { id: "b", type: "block_ref", refBlockIds: ["a", "z"] },
        {
          id: "c",
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "a", type: "page" } }],
        },
      ],
    };
    expect(collectBacklinks(doc, [doc.blocks[0]])).toEqual([
      { blockId: "a", sourceBlockId: "b" },
      { blockId: "a", sourceBlockId: "c" },
    ]);
  });

  it("returns nothing when the moving set is empty", () => {
    expect(collectBacklinks(pageA(), [])).toEqual([]);
  });
});

describe("isSamePage", () => {
  it("compares page ids across object and string refs", () => {
    expect(isSamePage({ id: "x" }, { id: "x" })).toBe(true);
    expect(isSamePage("x", { id: "x" })).toBe(true);
    expect(isSamePage({ id: "x" }, { id: "y" })).toBe(false);
    expect(isSamePage(null, undefined)).toBe(false);
  });
});

describe("validateMove", () => {
  it("accepts a well-formed selection", () => {
    expect(validateMove({ doc: pageA(), indices: [1, 2], targetIndex: 4 })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("rejects an empty selection", () => {
    expect(validateMove({ doc: pageA(), indices: [], targetIndex: 0 }).errors).toContain(
      "empty selection",
    );
  });

  it("reports out-of-range source indices", () => {
    const result = validateMove({ doc: pageA(), indices: [9], targetIndex: 0 });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("out-of-range index: 9");
  });

  it("reports an out-of-range target index", () => {
    expect(validateMove({ doc: pageA(), indices: [0], targetIndex: 12 }).errors).toContain(
      "out-of-range target index: 12",
    );
  });

  it("rejects dropping a contiguous selection into its own span", () => {
    expect(validateMove({ doc: pageA(), indices: [0, 1], targetIndex: 1 }).errors).toContain(
      "moving into its own subtree",
    );
  });

  it("allows a target gap when the selection is not contiguous", () => {
    expect(validateMove({ doc: pageA(), indices: [0, 2], targetIndex: 1 }).ok).toBe(true);
  });
});

describe("planBlockMove", () => {
  it("plans a remove then an insert for a cross-page move", () => {
    const plan = planBlockMove({ doc: pageA(), indices: [4], targetPageId: "page-b", targetIndex: 1 });
    expect(plan.ops).toEqual([
      { op: "remove", pageId: "page-a", indices: [4], count: 1 },
      { op: "insert", pageId: "page-b", index: 1, count: 1 },
    ]);
    expect(plan.count).toBe(1);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([{ code: "backlink", blockId: "p4", relatedBlockId: "p1" }]);
  });

  it("collects warnings from both directions", () => {
    const plan = planBlockMove({ doc: pageA(), indices: [2, 4], targetPageId: "page-b", targetIndex: 0 });
    expect(plan.warnings).toEqual([
      { code: "backlink", blockId: "p4", relatedBlockId: "p1" },
      { code: "reference", blockId: "p2", relatedBlockId: "p3" },
    ]);
  });

  it("returns no ops and the errors for an invalid move", () => {
    const plan = planBlockMove({ doc: pageA(), indices: [0, 1], targetPageId: "page-a", targetIndex: 1 });
    expect(plan.ops).toEqual([]);
    expect(plan.count).toBe(0);
    expect(plan.errors).toContain("moving into its own subtree");
  });

  it("does not flag a source-document span when the destination is another page", () => {
    const plan = planBlockMove({ doc: pageA(), indices: [0, 1], targetPageId: "page-b", targetIndex: 1 });
    expect(plan.errors).toEqual([]);
    expect(plan.ops).toHaveLength(2);
  });

  it("uses the destination title as the plan label when given", () => {
    const plan = planBlockMove({
      doc: pageA(),
      indices: [4],
      targetPageId: "page-b",
      targetIndex: 0,
      targetTitle: "Beta",
    });
    expect(plan.targetLabel).toBe("Beta");
  });
});

describe("describeMove", () => {
  it("pluralizes a multi-block move", () => {
    const plan = planBlockMove({
      doc: pageA(),
      indices: [0, 1, 2],
      targetPageId: "page-b",
      targetIndex: 0,
      targetTitle: "Beta",
    });
    expect(describeMove(plan)).toBe("Moved 3 blocks to Beta");
  });

  it("keeps the singular for one block and falls back to the page id", () => {
    const plan = planBlockMove({ doc: pageA(), indices: [4], targetPageId: "page-b", targetIndex: 0 });
    expect(describeMove(plan)).toBe("Moved 1 block to page-b");
  });

  it("says nothing moved when the plan has no ops", () => {
    const plan = planBlockMove({ doc: pageA(), indices: [], targetPageId: "page-b", targetIndex: 0 });
    expect(describeMove(plan)).toBe("Nothing to move.");
  });
});

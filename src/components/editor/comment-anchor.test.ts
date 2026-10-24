import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import {
  anchorFromSelection,
  blockContentStart,
  blockTextAt,
  rangeFromAnchor,
  staleAnchorIds,
  wholeBlockAnchor,
} from "@/components/editor/comment-anchor";
import { commentHighlightDecorations } from "@/components/editor/extensions/comment-highlights";

/**
 * The editor side of inline comments: capturing a real selection as
 * block-relative offsets, mapping a persisted anchor back to a document
 * position, refusing to map a stale quote, and projecting anchors as
 * decorations (not document marks).
 */

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { id: { default: null } },
    },
    bulletList: {
      group: "block",
      content: "listItem+",
      attrs: { id: { default: null } },
    },
    listItem: { content: "paragraph+" },
    text: { group: "inline" },
  },
});

function docWith(text = "the selected words and more") {
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "b1" },
        content: [{ type: "text", text }],
      },
      {
        type: "paragraph",
        attrs: { id: "b2" },
        content: [{ type: "text", text: "second block" }],
      },
    ],
  });
}

describe("anchorFromSelection", () => {
  it("captures the selected words as block-relative offsets", () => {
    // Block b1 starts at doc position 0; its text starts at 1.
    expect(anchorFromSelection(docWith(), 5, 19)).toEqual({
      blockId: "b1",
      from: 4,
      to: 18,
      quote: "selected words",
    });
  });

  it("trims surrounding whitespace and clamps a selection to its start block", () => {
    const anchor = anchorFromSelection(docWith(), 5, 1000);
    expect(anchor?.blockId).toBe("b1");
    expect(anchor?.from).toBe(4);
    expect(anchor?.quote).toBe("selected words and more");
  });

  it("returns null for a collapsed selection or a block without an id", () => {
    expect(anchorFromSelection(docWith(), 5, 5)).toBeNull();
    const bare = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "no id" }] },
      ],
    });
    expect(anchorFromSelection(bare, 1, 3)).toBeNull();
  });

  it("counts text across inline mark boundaries, not document positions", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "b1" },
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    // "world" starts at text offset 6, document position 7.
    expect(anchorFromSelection(doc, 7, 12)).toEqual({
      blockId: "b1",
      from: 6,
      to: 11,
      quote: "world",
    });
  });
});

describe("rangeFromAnchor", () => {
  it("maps a valid anchor back to the exact document range", () => {
    expect(
      rangeFromAnchor(docWith(), {
        blockId: "b1",
        from: 4,
        to: 18,
        quote: "selected words",
      }),
    ).toEqual({ from: 5, to: 19 });
  });

  it("returns null when the block text no longer matches the quote (stale)", () => {
    const edited = docWith("the changed words and more");
    expect(
      rangeFromAnchor(edited, {
        blockId: "b1",
        from: 4,
        to: 18,
        quote: "selected words",
      }),
    ).toBeNull();
  });

  it("returns null for missing blocks, bad offsets and block-only anchors", () => {
    const doc = docWith();
    expect(
      rangeFromAnchor(doc, { blockId: "ghost", from: 0, to: 3, quote: "the" }),
    ).toBeNull();
    expect(
      rangeFromAnchor(doc, { blockId: "b1", from: -1, to: 3, quote: "the" }),
    ).toBeNull();
    expect(
      rangeFromAnchor(doc, { blockId: "b1", from: 0, to: 999, quote: "the" }),
    ).toBeNull();
    expect(rangeFromAnchor(doc, { blockId: "b1" })).toBeNull();
  });

  it("keeps a conservative block landing position for stale jumps", () => {
    expect(blockContentStart(docWith(), "b1")).toBe(1);
    expect(blockContentStart(docWith(), "ghost")).toBeNull();
  });
});

describe("staleAnchorIds", () => {
  const anchors = [
    {
      commentId: "live",
      blockId: "b1",
      from: 4,
      to: 18,
      quote: "selected words",
    },
    {
      commentId: "changed",
      blockId: "b2",
      from: 0,
      to: 6,
      quote: "second",
    },
    {
      commentId: "block-only",
      blockId: "b1",
    },
  ];

  it("reports only exact ranges that no longer match the live document", () => {
    expect(staleAnchorIds(docWith(), anchors)).toEqual([]);
    expect(staleAnchorIds(docWith("the changed words and more"), anchors)).toEqual([
      "live",
    ]);
  });

  it("reports a deleted block as stale but leaves block-only anchors alone", () => {
    const onlyFirst = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "b1" },
          content: [{ type: "text", text: "the selected words and more" }],
        },
      ],
    });
    expect(staleAnchorIds(onlyFirst, anchors)).toEqual(["changed"]);
  });
});

describe("wholeBlockAnchor / blockTextAt", () => {
  it("anchors the whole block as an exact range", () => {
    expect(wholeBlockAnchor(docWith(), "b1")).toEqual({
      blockId: "b1",
      from: 0,
      to: 27,
      quote: "the selected words and more",
    });
    expect(blockTextAt(docWith(), "b1")).toBe("the selected words and more");
  });

  it("returns null for a missing block", () => {
    expect(wholeBlockAnchor(docWith(), "ghost")).toBeNull();
    expect(blockTextAt(docWith(), "ghost")).toBeNull();
  });
});

describe("commentHighlightDecorations", () => {
  it("paints a valid range as an inline decoration with the comment id", () => {
    const doc = docWith();
    const before = JSON.stringify(doc.toJSON());
    const decorations = commentHighlightDecorations(
      doc,
      [
        {
          commentId: "c1",
          blockId: "b1",
          from: 4,
          to: 18,
          quote: "selected words",
        },
      ],
      "c1",
    ).find();
    // Decorations are a view projection: the document is byte-identical.
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    expect(decorations).toHaveLength(1);
    expect(decorations[0].from).toBe(5);
    expect(decorations[0].to).toBe(19);
    expect(
      (decorations[0] as unknown as { type: { attrs: Record<string, unknown> } })
        .type.attrs,
    ).toMatchObject({
      class: "noema-comment-highlight noema-comment-highlight-active",
      "data-comment-id": "c1",
      "data-comment-active": "true",
    });
  });

  it("never paints a stale range", () => {
    const decorations = commentHighlightDecorations(docWith("changed words"), [
      {
        commentId: "c1",
        blockId: "b1",
        from: 4,
        to: 18,
        quote: "selected words",
      },
    ]).find();
    expect(decorations).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_ANCHOR_QUOTE,
  blockTextById,
  commentAnchorState,
  normalizeAnchorSelection,
  validateCommentAnchor,
} from "@/lib/comment-anchors";

/**
 * Inline-comment anchors: block text extraction, offset validation (server
 * gate), and the stale/valid state the panel and editor decorations share.
 */

const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "b1" },
      content: [{ type: "text", text: "the selected words and more" }],
    },
    {
      type: "bulletList",
      attrs: { id: "list" },
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "first item" }],
            },
            {
              type: "nestedList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "nested" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    { type: "paragraph", attrs: { id: "empty" } },
  ],
};

describe("blockTextById", () => {
  it("extracts the block's plain text by id", () => {
    expect(blockTextById(DOC, "b1")).toBe("the selected words and more");
    expect(blockTextById(DOC, "empty")).toBe("");
  });

  it("concatenates nested block text without separators", () => {
    expect(blockTextById(DOC, "list")).toBe("first itemnested");
  });

  it("returns null for a missing, blank or foreign id", () => {
    expect(blockTextById(DOC, "ghost")).toBeNull();
    expect(blockTextById(DOC, "")).toBeNull();
    expect(blockTextById({ type: "doc", content: [] }, "b1")).toBeNull();
  });
});

describe("normalizeAnchorSelection", () => {
  it("trims the selection and returns the exact slice as the quote", () => {
    const text = "  the selected words and more  ";
    expect(normalizeAnchorSelection(text, 0, 20)).toEqual({
      from: 2,
      to: 20,
      quote: "the selected words",
    });
  });

  it("caps the range at the quote limit without splitting a code unit", () => {
    const text = "x".repeat(MAX_ANCHOR_QUOTE + 40);
    const range = normalizeAnchorSelection(text, 0, text.length);
    expect(range?.from).toBe(0);
    expect(range?.to).toBe(MAX_ANCHOR_QUOTE);
    expect(range?.quote).toHaveLength(MAX_ANCHOR_QUOTE);
  });

  it("rejects empty, inverted and non-integer ranges", () => {
    expect(normalizeAnchorSelection("text", 2, 2)).toBeNull();
    expect(normalizeAnchorSelection("text", 3, 2)).toBeNull();
    expect(normalizeAnchorSelection("text", Number.NaN, 2)).toBeNull();
  });
});

describe("validateCommentAnchor", () => {
  const blockText = "the selected words and more";

  it("accepts a range whose quote matches the current block text", () => {
    expect(
      validateCommentAnchor({
        blockId: "b1",
        blockText,
        from: 4,
        to: 18,
        quote: "selected words",
      }),
    ).toEqual({
      ok: true,
      anchor: { from: 4, to: 18, quote: "selected words" },
    });
  });

  it("accepts no range for a legacy block/quote or page comment", () => {
    expect(
      validateCommentAnchor({ blockId: "b1", blockText, quote: "the" }),
    ).toEqual({ ok: true, anchor: null });
    expect(validateCommentAnchor({ blockText: null })).toEqual({
      ok: true,
      anchor: null,
    });
  });

  it("fails closed for a half range, missing block, or foreign id", () => {
    expect(
      validateCommentAnchor({ blockId: "b1", blockText, from: 4, quote: "x" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCommentAnchor({ blockId: "b1", blockText: null, from: 0, to: 3, quote: "the" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCommentAnchor({ blockId: "ghost", blockText: null, from: 0, to: 3, quote: "the" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCommentAnchor({ blockId: "", blockText, from: 0, to: 3, quote: "the" }),
    ).toMatchObject({ ok: false });
  });

  it("rejects out-of-bounds, inverted and mismatched quotes", () => {
    expect(
      validateCommentAnchor({ blockId: "b1", blockText, from: 0, to: 999, quote: "the" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCommentAnchor({ blockId: "b1", blockText, from: 5, to: 4, quote: "the" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCommentAnchor({
        blockId: "b1",
        blockText,
        from: 4,
        to: 12,
        quote: "select", // the slice is "selected"
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCommentAnchor({ blockId: "b1", blockText, from: 4, to: 12, quote: "" }),
    ).toMatchObject({ ok: false });
  });
});

describe("commentAnchorState", () => {
  const blockText = "the selected words and more";

  it("distinguishes a live range from a stale one", () => {
    expect(
      commentAnchorState({
        blockId: "b1",
        blockText,
        from: 4,
        to: 18,
        quote: "selected words",
      }),
    ).toBe("valid");
    expect(
      commentAnchorState({
        blockId: "b1",
        blockText: "the edited words and more",
        from: 4,
        to: 18,
        quote: "selected words",
      }),
    ).toBe("stale");
  });

  it("marks an out-of-bounds range stale, not valid", () => {
    expect(
      commentAnchorState({
        blockId: "b1",
        blockText: "short",
        from: 0,
        to: 999,
        quote: "short",
      }),
    ).toBe("stale");
  });

  it("keeps legacy block/quote anchors as block anchors and reports a missing block", () => {
    expect(commentAnchorState({ blockId: "b1", blockText, quote: "the" })).toBe(
      "block",
    );
    expect(commentAnchorState({ blockId: "b1", blockText: null })).toBe(
      "missing",
    );
    expect(commentAnchorState({ blockId: null, blockText: null })).toBe("none");
  });
});

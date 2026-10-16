import { describe, expect, it } from "vitest";
import type { RichNode } from "@/lib/blocks";
import {
  clearSelection,
  clipboardPayload,
  deletePlan,
  extendSelection,
  isSelected,
  resolveRange,
  selectAll,
  selectionBounds,
  selectionSummary,
  shiftSelect,
  toggleSelect,
  type BlockRange,
} from "./block-selection";

/**
 * Multi-block range selection engine (docs/specs/editor-deep.md R84.10-R84.12).
 *
 * Red-first: `src/lib/block-selection.ts` does not exist when this file is
 * written, so the whole suite fails on the missing module until the helpers
 * land. The engine is the pure, editor-agnostic model behind a shift-range
 * across top-level blocks: a `{anchorId, headId}` range that resolves to whole
 * block ids in document order, normalises a reversed anchor/head, tolerates
 * endpoints that have since disappeared, and plans the range actions
 * (delete + focus, copy payload) the editor wires up.
 *
 * The order-aware helpers (`resolveRange`, `selectAll`, `extendSelection`,
 * `selectionBounds`, `selectionSummary`, `deletePlan`) take the flat document
 * `blockIds` so every answer is anchored in document order. The pointer
 * helpers (`toggleSelect`, `shiftSelect`, `isSelected`) are order-free and
 * treat `{anchorId, headId}` as the two selected endpoints.
 */

/** The canonical top-level block order used throughout (order matters). */
const DOC: readonly string[] = ["a", "b", "c", "d", "e"];

const paragraph = (text: string): RichNode => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("resolveRange — document order, inclusive, missing-id tolerant", () => {
  it("returns the inclusive span when the anchor precedes the head", () => {
    expect(resolveRange(DOC, { anchorId: "b", headId: "d" })).toEqual(["b", "c", "d"]);
  });

  it("normalises a reversed range to document order", () => {
    expect(resolveRange(DOC, { anchorId: "d", headId: "b" })).toEqual(["b", "c", "d"]);
  });

  it("collapses to the single block when anchor === head", () => {
    expect(resolveRange(DOC, { anchorId: "c", headId: "c" })).toEqual(["c"]);
  });

  it("falls back to the surviving endpoint when the anchor is missing", () => {
    expect(resolveRange(DOC, { anchorId: "ghost", headId: "c" })).toEqual(["c"]);
  });

  it("falls back to the surviving endpoint when the head is missing", () => {
    expect(resolveRange(DOC, { anchorId: "c", headId: "ghost" })).toEqual(["c"]);
  });

  it("returns [] when both endpoints are unknown", () => {
    expect(resolveRange(DOC, { anchorId: "ghost", headId: "phantom" })).toEqual([]);
  });

  it("returns [] for a null range", () => {
    expect(resolveRange(DOC, null)).toEqual([]);
  });

  it("returns a fresh array and never mutates the input", () => {
    const frozen = Object.freeze(["a", "b", "c", "d"]) as readonly string[];
    const first = resolveRange(frozen, { anchorId: "a", headId: "c" });
    const second = resolveRange(frozen, { anchorId: "a", headId: "c" });
    expect(first).toEqual(["a", "b", "c"]);
    expect(first).not.toBe(second);
  });
});

describe("selectAll — whole document, empty edge case", () => {
  it("selects from the first to the last block", () => {
    expect(selectAll(DOC)).toEqual({ anchorId: "a", headId: "e" });
  });

  it("selects the only block in a single-block document", () => {
    expect(selectAll(["only"])).toEqual({ anchorId: "only", headId: "only" });
  });

  it("returns null for an empty document", () => {
    expect(selectAll([])).toBeNull();
  });

  it("round-trips through resolveRange to every id", () => {
    const range = selectAll(DOC);
    expect(resolveRange(DOC, range)).toEqual([...DOC]);
  });

  it("returns a fresh object each call", () => {
    expect(selectAll(DOC)).not.toBe(selectAll(DOC));
  });
});

describe("extendSelection — keep the anchor, move the head", () => {
  it("keeps the anchor and moves the head to the extend target", () => {
    expect(extendSelection(DOC, { anchorId: "b", headId: "c" }, { extendId: "e" })).toEqual({
      anchorId: "b",
      headId: "e",
    });
  });

  it("starts a single-block selection when there is no range", () => {
    expect(extendSelection(DOC, null, { extendId: "c" })).toEqual({
      anchorId: "c",
      headId: "c",
    });
  });

  it("re-anchors at the current head when the stored anchor is missing", () => {
    expect(extendSelection(DOC, { anchorId: "ghost", headId: "b" }, { extendId: "d" })).toEqual({
      anchorId: "b",
      headId: "d",
    });
  });

  it("leaves the range untouched when the extend target is unknown", () => {
    const range: BlockRange = { anchorId: "b", headId: "c" };
    expect(extendSelection(DOC, range, { extendId: "ghost" })).toEqual(range);
  });

  it("returns null for an unknown target with no existing range", () => {
    expect(extendSelection(DOC, null, { extendId: "ghost" })).toBeNull();
  });

  it("extends backwards while preserving the anchor", () => {
    const range = extendSelection(DOC, { anchorId: "d", headId: "c" }, { extendId: "a" });
    expect(range).toEqual({ anchorId: "d", headId: "a" });
    expect(resolveRange(DOC, range)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns null for an empty document", () => {
    expect(extendSelection([], null, { extendId: "a" })).toBeNull();
  });
});

describe("toggleSelect — meta-click endpoints on and off", () => {
  it("starts a single-block selection from nothing", () => {
    expect(toggleSelect(null, "b")).toEqual({ anchorId: "b", headId: "b" });
  });

  it("clears the selection when the only selected block is toggled off", () => {
    expect(toggleSelect({ anchorId: "b", headId: "b" }, "b")).toBeNull();
  });

  it("drops the anchor and keeps the head", () => {
    expect(toggleSelect({ anchorId: "b", headId: "d" }, "b")).toEqual({
      anchorId: "d",
      headId: "d",
    });
  });

  it("drops the head and keeps the anchor", () => {
    expect(toggleSelect({ anchorId: "b", headId: "d" }, "d")).toEqual({
      anchorId: "b",
      headId: "b",
    });
  });

  it("adds an unselected block as the new head", () => {
    expect(toggleSelect({ anchorId: "b", headId: "b" }, "d")).toEqual({
      anchorId: "b",
      headId: "d",
    });
  });
});

describe("shiftSelect — shift extends, meta toggles, plain click resets", () => {
  it("plain click resets to the clicked block", () => {
    expect(shiftSelect({ anchorId: "b", headId: "d" }, { focusId: "e" })).toEqual({
      anchorId: "e",
      headId: "e",
    });
  });

  it("shift extends while preserving the anchor", () => {
    expect(shiftSelect({ anchorId: "b", headId: "c" }, { focusId: "e", shift: true })).toEqual({
      anchorId: "b",
      headId: "e",
    });
  });

  it("shift with no range starts the selection at the focus", () => {
    expect(shiftSelect(null, { focusId: "c", shift: true })).toEqual({
      anchorId: "c",
      headId: "c",
    });
  });

  it("meta toggles an already-selected endpoint off", () => {
    expect(shiftSelect({ anchorId: "b", headId: "d" }, { focusId: "b", meta: true })).toEqual({
      anchorId: "d",
      headId: "d",
    });
  });

  it("meta adds an unselected focus", () => {
    expect(shiftSelect({ anchorId: "b", headId: "b" }, { focusId: "d", meta: true })).toEqual({
      anchorId: "b",
      headId: "d",
    });
  });

  it("meta takes precedence when both modifiers are held", () => {
    expect(
      shiftSelect({ anchorId: "b", headId: "d" }, { focusId: "d", shift: true, meta: true }),
    ).toEqual({ anchorId: "b", headId: "b" });
  });
});

describe("clearSelection / isSelected", () => {
  it("clearSelection yields no selection", () => {
    expect(clearSelection()).toBeNull();
  });

  it("isSelected is true only for the range endpoints", () => {
    expect(isSelected({ anchorId: "b", headId: "d" }, "b")).toBe(true);
    expect(isSelected({ anchorId: "b", headId: "d" }, "d")).toBe(true);
    expect(isSelected({ anchorId: "b", headId: "d" }, "c")).toBe(false);
  });

  it("isSelected is false with no range", () => {
    expect(isSelected(null, "b")).toBe(false);
    expect(isSelected(clearSelection(), "b")).toBe(false);
  });
});

describe("selectionBounds — inclusive index bounds", () => {
  it("returns the inclusive index span", () => {
    expect(selectionBounds({ anchorId: "b", headId: "d" }, DOC)).toEqual({ start: 1, end: 3 });
  });

  it("normalises a reversed range", () => {
    expect(selectionBounds({ anchorId: "d", headId: "b" }, DOC)).toEqual({ start: 1, end: 3 });
  });

  it("tolerates a missing endpoint", () => {
    expect(selectionBounds({ anchorId: "ghost", headId: "c" }, DOC)).toEqual({ start: 2, end: 2 });
  });

  it("returns null when nothing resolves", () => {
    expect(selectionBounds({ anchorId: "ghost", headId: "phantom" }, DOC)).toBeNull();
    expect(selectionBounds(null, DOC)).toBeNull();
  });
});

describe("selectionSummary — count and ends", () => {
  it("counts the span and reports its ends", () => {
    expect(selectionSummary({ anchorId: "b", headId: "d" }, DOC)).toEqual({
      count: 3,
      first: "b",
      last: "d",
    });
  });

  it("reports a single selected block", () => {
    expect(selectionSummary({ anchorId: "c", headId: "c" }, DOC)).toEqual({
      count: 1,
      first: "c",
      last: "c",
    });
  });

  it("reports an empty summary for no selection", () => {
    expect(selectionSummary(null, DOC)).toEqual({ count: 0, first: null, last: null });
  });
});

describe("deletePlan — blocks to remove plus the focus target", () => {
  it("removes the range and focuses the next surviving block", () => {
    expect(deletePlan({ anchorId: "b", headId: "c" }, DOC)).toEqual({
      removed: ["b", "c"],
      focusId: "d",
    });
  });

  it("focuses the previous block when the range reaches the end", () => {
    expect(deletePlan({ anchorId: "d", headId: "e" }, DOC)).toEqual({
      removed: ["d", "e"],
      focusId: "c",
    });
  });

  it("returns a null focus when the whole document is removed", () => {
    expect(deletePlan({ anchorId: "a", headId: "e" }, DOC)).toEqual({
      removed: ["a", "b", "c", "d", "e"],
      focusId: null,
    });
  });

  it("returns an empty plan when nothing is selected", () => {
    expect(deletePlan(null, DOC)).toEqual({ removed: [], focusId: null });
  });

  it("tolerates a missing endpoint and still picks a sound focus", () => {
    expect(deletePlan({ anchorId: "ghost", headId: "c" }, DOC)).toEqual({
      removed: ["c"],
      focusId: "d",
    });
  });
});

describe("clipboardPayload — normalised copy subset", () => {
  it("deep-clones the copied blocks", () => {
    const source = paragraph("Hello");
    const payload = clipboardPayload([source]);
    expect(payload.blocks).toEqual([source]);
    expect(payload.blocks[0]).not.toBe(source);
    (payload.blocks[0].content?.[0] as { text: string }).text = "changed";
    expect(source.content?.[0]?.text).toBe("Hello");
  });

  it("trims blank edge paragraphs but keeps interior blanks", () => {
    const payload = clipboardPayload([
      { type: "paragraph" },
      paragraph("Alpha"),
      { type: "paragraph" },
      paragraph("Beta"),
      { type: "paragraph" },
    ]);
    expect(payload.blocks).toEqual([paragraph("Alpha"), { type: "paragraph" }, paragraph("Beta")]);
  });

  it("treats whitespace-only textblocks as blank at the edges", () => {
    const payload = clipboardPayload([
      { type: "paragraph", content: [{ type: "text", text: "   " }] },
      paragraph("Alpha"),
    ]);
    expect(payload.blocks).toEqual([paragraph("Alpha")]);
  });

  it("keeps atoms such as images and rules", () => {
    const image: RichNode = { type: "image", attrs: { src: "x", alt: "pic" } };
    const rule: RichNode = { type: "horizontalRule" };
    const payload = clipboardPayload([image, rule]);
    expect(payload.blocks).toEqual([image, rule]);
  });

  it("returns an empty payload when everything is blank", () => {
    expect(clipboardPayload([{ type: "paragraph" }, { type: "paragraph" }])).toEqual({
      blocks: [],
      markdown: "",
    });
  });

  it("renders a markdown flavour of the subset", () => {
    const payload = clipboardPayload([paragraph("Alpha"), paragraph("Beta")]);
    expect(payload.markdown).toBe("Alpha\n\nBeta");
  });
});

/**
 * ProseMirror adapter for inline-comment anchors.
 *
 * The persisted anchor is `{ blockId, from, to, quote }`, where the offsets are
 * text offsets inside the block (see `src/lib/comment-anchors.ts`). This module
 * converts between the editor's document positions and those offsets:
 *
 *  - `anchorFromSelection` captures the real range under the user's selection;
 *  - `rangeFromAnchor` maps a stored anchor back to positions, but only when the
 *    current block text still matches the stored quote;
 *  - `blockContentStart` is the conservative fallback for a stale anchor, so
 *    "jump" still lands on the right block.
 *
 * Pure: reads a document, never mutates it.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  MAX_ANCHOR_QUOTE,
  normalizeAnchorSelection,
  type CommentAnchorRange,
} from "@/lib/comment-anchors";

export type EditorCommentAnchor = CommentAnchorRange & { readonly blockId: string };

type BlockPath = {
  readonly node: PMNode;
  /** Document position of the top-level node itself. */
  readonly start: number;
  readonly blockId: string;
};

/** Find the top-level block carrying `blockId`; ids live on top-level nodes. */
function findBlock(doc: PMNode, blockId: string): BlockPath | null {
  if (typeof blockId !== "string" || blockId.trim() === "") return null;
  let found: BlockPath | null = null;
  doc.forEach((node, offset) => {
    if (found !== null) return;
    const id = node.attrs?.id;
    if (typeof id === "string" && id === blockId) {
      found = { node, start: offset, blockId };
    }
  });
  return found;
}

/** The top-level block containing document position `pos`. */
function blockAt(doc: PMNode, pos: number): BlockPath | null {
  let found: BlockPath | null = null;
  doc.forEach((node, offset) => {
    if (found !== null) return;
    const end = offset + node.nodeSize;
    if (pos >= offset && pos <= end) {
      const id = node.attrs?.id;
      if (typeof id === "string" && id !== "") {
        found = { node, start: offset, blockId: id };
      }
    }
  });
  return found;
}

/** First document position of a top-level block's inline content. */
function contentStart(block: BlockPath): number {
  return block.start + 1;
}

/** Last document position of a top-level block's inline content. */
function contentEnd(block: BlockPath): number {
  return block.start + block.node.nodeSize - 1;
}

/** Plain text of the top-level block with `blockId`, or `null`. */
export function blockTextAt(doc: PMNode, blockId: string): string | null {
  return findBlock(doc, blockId)?.node.textContent ?? null;
}

/**
 * Document position where a stale/anchor-less jump should land: the start of
 * the block's text. `null` when the block is gone.
 */
export function blockContentStart(doc: PMNode, blockId: string): number | null {
  const block = findBlock(doc, blockId);
  return block === null ? null : contentStart(block);
}

/**
 * Convert a ProseMirror selection to a block-relative text range. A selection
 * that crosses blocks is clamped to the block where it starts; that is the
 * honest anchor the composer can submit.
 */
export function anchorFromSelection(
  doc: PMNode,
  from: number,
  to: number,
): EditorCommentAnchor | null {
  const block = blockAt(doc, from);
  if (block === null) return null;
  const blockStart = contentStart(block);
  const blockEnd = contentEnd(block);
  const selectionFrom = Math.max(blockStart, Math.min(from, blockEnd));
  const selectionTo = Math.max(blockStart, Math.min(to, blockEnd));
  if (selectionTo <= selectionFrom) return null;
  const text = block.node.textContent;
  const relativeFrom = doc.textBetween(blockStart, selectionFrom, "", "").length;
  const relativeTo = doc.textBetween(blockStart, selectionTo, "", "").length;
  const range = normalizeAnchorSelection(text, relativeFrom, relativeTo, MAX_ANCHOR_QUOTE);
  if (range === null) return null;
  return { blockId: block.blockId, ...range };
}

/**
 * A whole-block anchor for the block context menu. It is still an exact range
 * (`0`..`text.length`, capped at the quote limit), just one whose selection was
 * the block rather than a drag.
 */
export function wholeBlockAnchor(
  doc: PMNode,
  blockId: string,
): EditorCommentAnchor | null {
  const block = findBlock(doc, blockId);
  if (block === null) return null;
  const text = block.node.textContent;
  const range = normalizeAnchorSelection(text, 0, text.length, MAX_ANCHOR_QUOTE);
  return range === null ? null : { blockId, ...range };
}

/**
 * Map a text offset inside `block` to a document position. Only text nodes
 * count, matching `node.textContent` and the server's JSON extraction; inline
 * atoms contribute nothing to the quote and are skipped. An offset equal to
 * the block text length resolves to the end of the block's content.
 */
function positionAtOffset(doc: PMNode, block: BlockPath, offset: number): number | null {
  if (offset < 0) return null;
  const total = block.node.textContent.length;
  if (offset > total) return null;
  if (offset === total) return contentEnd(block);

  let remaining = offset;
  let resolved: number | null = null;
  doc.nodesBetween(contentStart(block), contentEnd(block), (node, pos) => {
    if (resolved !== null) return false;
    if (!node.isText) return true;
    const length = node.nodeSize;
    if (remaining <= length) {
      resolved = pos + remaining;
      return false;
    }
    remaining -= length;
    return false;
  });
  return resolved;
}

/**
 * Comment ids whose persisted range can no longer be mapped to the live
 * document (block deleted, text edited, offsets moved). Block-only anchors are
 * not reported: they never claimed an exact range.
 */
export function staleAnchorIds(
  doc: PMNode,
  anchors: readonly {
    commentId: string;
    blockId: string;
    from?: number | null;
    to?: number | null;
    quote?: string | null;
  }[],
): string[] {
  return anchors
    .filter(
      (anchor) =>
        anchor.from !== undefined &&
        anchor.from !== null &&
        anchor.to !== undefined &&
        anchor.to !== null &&
        rangeFromAnchor(doc, anchor) === null,
    )
    .map((anchor) => anchor.commentId);
}

/**
 * Map a stored anchor to document positions, but only while the block's text
 * still equals the stored quote. `null` is the stale case: the caller must not
 * paint a range it cannot trust.
 */
export function rangeFromAnchor(
  doc: PMNode,
  anchor: {
    blockId: string;
    from?: number | null;
    to?: number | null;
    quote?: string | null;
  },
): { from: number; to: number } | null {
  if (
    anchor.from === undefined ||
    anchor.from === null ||
    anchor.to === undefined ||
    anchor.to === null ||
    typeof anchor.from !== "number" ||
    typeof anchor.to !== "number" ||
    !Number.isInteger(anchor.from) ||
    !Number.isInteger(anchor.to) ||
    anchor.from < 0 ||
    anchor.to <= anchor.from
  ) {
    return null;
  }
  const block = findBlock(doc, anchor.blockId);
  if (block === null) return null;
  const text = block.node.textContent;
  if (anchor.to > text.length) return null;
  const quote = anchor.quote ?? "";
  if (quote === "" || text.slice(anchor.from, anchor.to) !== quote) return null;
  const from = positionAtOffset(doc, block, anchor.from);
  const to = positionAtOffset(doc, block, anchor.to);
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}

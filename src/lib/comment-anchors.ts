/**
 * Pure inline-comment anchor helpers.
 *
 * A root comment may carry an exact range inside one block:
 *
 *   { blockId, from, to, quote }
 *
 * `from`/`to` are UTF-16 offsets into the block's *plain text* (the same string
 * ProseMirror's `node.textContent` returns and the read-only renderer emits).
 * They are not document positions: block identity plus a text offset survives
 * block moves, so the server can re-validate the range against the page's
 * current content without knowing the editor's schema.
 *
 * Validation is deliberately fail-closed. An anchor whose offsets are outside
 * the block, whose quote no longer equals the slice, or whose block is missing
 * is rejected before a row is written - a wrong range is worse than a plain
 * block anchor, because it would paint an unrelated sentence.
 */

/** Longest quoted range we persist (mirrors `commentSchema.quote`). */
export const MAX_ANCHOR_QUOTE = 500;

export type CommentAnchorState = "none" | "block" | "valid" | "stale" | "missing";

export type CommentAnchorRange = {
  readonly from: number;
  readonly to: number;
  readonly quote: string;
};

export type CommentAnchorValidation =
  | { readonly ok: true; readonly anchor: CommentAnchorRange | null }
  | { readonly ok: false; readonly error: string };

type JsonNode = {
  type?: unknown;
  text?: unknown;
  attrs?: unknown;
  content?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nodeText(node: unknown): string {
  if (!isRecord(node)) return "";
  const text = (node as JsonNode).text;
  if (typeof text === "string") return text;
  const content = (node as JsonNode).content;
  if (!Array.isArray(content)) return "";
  return content.map(nodeText).join("");
}

function findBlock(node: unknown, blockId: string): unknown | null {
  if (!isRecord(node)) return null;
  const attrs = (node as JsonNode).attrs;
  if (isRecord(attrs) && attrs.id === blockId) return node;
  const content = (node as JsonNode).content;
  if (!Array.isArray(content)) return null;
  for (const child of content) {
    const found = findBlock(child, blockId);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The plain text of the block with `blockId` in a stored TipTap/ProseMirror
 * JSON document. `null` means the block is absent (deleted, or an id from a
 * different page), which every caller treats as an unusable anchor.
 */
export function blockTextById(doc: unknown, blockId: string): string | null {
  if (typeof blockId !== "string" || blockId.trim() === "") return null;
  let root = doc;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      return null;
    }
  }
  const block = findBlock(root, blockId);
  return block === null ? null : nodeText(block);
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Trim a selected range to its visible text and cap it at `maxLength`. The
 * returned `quote` is byte-for-byte the block-text slice (`from`..`to`), so the
 * server can re-check it with a simple equality test.
 */
export function normalizeAnchorSelection(
  blockText: string,
  from: number,
  to: number,
  maxLength: number = MAX_ANCHOR_QUOTE,
): CommentAnchorRange | null {
  if (!isOffset(from) || !isOffset(to) || to <= from) return null;
  const start = Math.min(from, blockText.length);
  const cappedEnd = Math.min(to, blockText.length, start + maxLength);
  if (cappedEnd <= start) return null;
  const raw = blockText.slice(start, cappedEnd);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const trimmedFrom = start + leading;
  const trimmedTo = cappedEnd - trailing;
  if (trimmedTo <= trimmedFrom) return null;
  return {
    from: trimmedFrom,
    to: trimmedTo,
    quote: blockText.slice(trimmedFrom, trimmedTo),
  };
}

/**
 * Validate an anchor supplied by a client against the page's current text.
 * Both offsets absent is a valid "no range" anchor (a page or block comment).
 * One offset, non-integer offsets, an out-of-bounds range, a missing block or a
 * quote that does not match the current slice are all rejected.
 */
export function validateCommentAnchor(input: {
  blockId?: string | null;
  blockText: string | null;
  from?: number | null;
  to?: number | null;
  quote?: string | null;
}): CommentAnchorValidation {
  const hasFrom = input.from !== undefined && input.from !== null;
  const hasTo = input.to !== undefined && input.to !== null;
  if (!hasFrom && !hasTo) return { ok: true, anchor: null };
  if (hasFrom !== hasTo) {
    return { ok: false, error: "The selected range is incomplete. Select the text again." };
  }
  const blockId = input.blockId?.trim() ?? "";
  if (blockId === "") {
    return { ok: false, error: "The selected range has no block to anchor to." };
  }
  if (input.blockText === null) {
    return { ok: false, error: "The selected text is no longer available." };
  }
  const from = input.from as number;
  const to = input.to as number;
  if (!isOffset(from) || !isOffset(to) || to <= from) {
    return { ok: false, error: "The selected range is invalid. Select the text again." };
  }
  if (to > input.blockText.length) {
    return { ok: false, error: "The selected range is outside its block." };
  }
  const quote = input.quote ?? "";
  if (quote.trim() === "") {
    return { ok: false, error: "The selected range has no quoted text." };
  }
  if (quote.length > MAX_ANCHOR_QUOTE) {
    return { ok: false, error: "The quoted selection is too long." };
  }
  if (input.blockText.slice(from, to) !== quote) {
    return { ok: false, error: "The selected text changed. Select it again." };
  }
  return { ok: true, anchor: { from, to, quote } };
}

/**
 * How an existing anchor relates to the current document. The panel uses this
 * to keep the quote but mark a range stale instead of implying it still points
 * at the same words. `block` is a legacy anchor that only names a block.
 */
export function commentAnchorState(input: {
  blockId?: string | null;
  blockText: string | null;
  from?: number | null;
  to?: number | null;
  quote?: string | null;
}): CommentAnchorState {
  const blockId = input.blockId?.trim() ?? "";
  if (blockId === "") return "none";
  if (input.blockText === null) return "missing";
  const hasRange =
    input.from !== undefined &&
    input.from !== null &&
    input.to !== undefined &&
    input.to !== null;
  if (!hasRange) return "block";
  const from = input.from as number;
  const to = input.to as number;
  const quote = input.quote ?? "";
  if (
    !isOffset(from) ||
    !isOffset(to) ||
    to <= from ||
    to > input.blockText.length ||
    quote === ""
  ) {
    return "stale";
  }
  return input.blockText.slice(from, to) === quote ? "valid" : "stale";
}

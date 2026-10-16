/**
 * Multi-block range selection engine (docs/specs/editor-deep.md R84.10-R84.12).
 *
 * Pure, editor-agnostic model of the shift-range selection the editor paints
 * across *whole top-level blocks*: a range is `{anchorId, headId}`, two block
 * ids (the fixed anchor and the moving head) that resolve to the inclusive
 * slice of the flat document order. Columns, atoms and table boundaries never
 * half-select — the caller has already reduced every selection to top-level
 * ids, and this module only orders and expands them.
 *
 * Two layers, deliberately split:
 *  - **Order-aware** helpers take the flat `blockIds` so they can answer in
 *    document order and tolerate an endpoint that has since disappeared
 *    (`{@link resolveRange}`, `{@link selectAll}`,
 *    `{@link extendSelection}`, `{@link selectionBounds}`,
 *    `{@link selectionSummary}`, `{@link deletePlan}`).
 *  - **Pointer** helpers are order-free and treat `{anchorId, headId}` as the
 *    two selected endpoints: shift-click extends (keeping the anchor),
 *    meta-click toggles an endpoint, a plain click resets
 *    (`{@link toggleSelect}`, `{@link shiftSelect}`, `{@link isSelected}`).
 *
 * Nothing here touches ProseMirror, React or the DOM, and no input is mutated;
 * every helper returns fresh values.
 *
 * R84.12 exclusions: this engine does not own select-all *staging* (block text
 * → block → document, B18) — {@link selectAll} is the explicit whole-document
 * shortcut only. A range delete is an ordinary transaction, so
 * {@link deletePlan} is a pure plan, not a special collaboration path.
 */

import { docToMarkdown, prosemirrorToText, type RichNode } from "@/lib/blocks";

/** A selection span between two top-level block ids; the ends are inclusive. */
export type BlockRange = {
  /** The fixed end of the selection (where the range started). */
  anchorId: string;
  /** The moving end of the selection (where the range currently reaches). */
  headId: string;
};

/** Selection is optional; `null` means "nothing selected". */
export type MaybeRange = BlockRange | null;

/**
 * Resolve a range to the ordered ids it covers, inclusive of both ends.
 *
 * - The span is always returned in **document order**, so a reversed range
 *   (`anchorId` after `headId`) reads the same as the forward one.
 * - A missing endpoint is tolerated rather than throwing: if only one end is
 *   still in `blockIds`, the range degrades to that single block; if neither
 *   survives, the result is `[]`.
 * - A `null` range yields `[]`. A fresh array is always returned.
 */
export function resolveRange(blockIds: readonly string[], range: MaybeRange): string[] {
  if (!range) return [];
  const anchor = blockIds.indexOf(range.anchorId);
  const head = blockIds.indexOf(range.headId);
  if (anchor === -1 && head === -1) return [];
  if (anchor === -1) return [blockIds[head]];
  if (head === -1) return [blockIds[anchor]];
  const start = Math.min(anchor, head);
  const end = Math.max(anchor, head);
  return blockIds.slice(start, end + 1);
}

/**
 * The range covering the whole document (first block → last block), or `null`
 * for an empty document. This is the explicit select-all shortcut; it does not
 * stage through block text (R84.12).
 */
export function selectAll(blockIds: readonly string[]): BlockRange | null {
  if (blockIds.length === 0) return null;
  return { anchorId: blockIds[0], headId: blockIds[blockIds.length - 1] };
}

/**
 * The shift+arrow / shift-click extension: keep the current anchor and move the
 * head to `extendId`. An unknown `extendId` (not in `blockIds`) leaves the
 * existing range untouched, or stays empty when there was none. A missing
 * stored anchor re-anchors at the current head (falling back to `extendId`), so
 * a range whose anchor block was deleted keeps extending from where it is.
 */
export function extendSelection(
  blockIds: readonly string[],
  range: MaybeRange,
  { extendId }: { extendId: string },
): BlockRange | null {
  if (blockIds.length === 0) return null;
  if (!blockIds.includes(extendId)) return range ? { ...range } : null;
  if (!range) return { anchorId: extendId, headId: extendId };
  const anchor = blockIds.includes(range.anchorId)
    ? range.anchorId
    : blockIds.includes(range.headId)
      ? range.headId
      : extendId;
  return { anchorId: anchor, headId: extendId };
}

/**
 * Meta-click toggle (order-free). Treats `{anchorId, headId}` as the two
 * selected endpoints:
 *  - no selection → select `id`;
 *  - `id` is the only selected block → clear the selection (`null`);
 *  - `id` is one endpoint of a pair → drop it, keeping the other endpoint;
 *  - `id` is unselected → add it as the new head.
 *
 * Because a range is only two ids, dropping an endpoint of a longer span
 * collapses to the remaining endpoint rather than the next id — the
 * order-aware helpers cover the full-span cases.
 */
export function toggleSelect(range: MaybeRange, id: string): BlockRange | null {
  if (!range) return { anchorId: id, headId: id };
  if (range.anchorId === id && range.headId === id) return null;
  if (range.anchorId === id) return { anchorId: range.headId, headId: range.headId };
  if (range.headId === id) return { anchorId: range.anchorId, headId: range.anchorId };
  return { anchorId: range.anchorId, headId: id };
}

/**
 * The click handler behind range selection:
 *  - `meta` (regardless of `shift`) toggles `focusId` via {@link toggleSelect};
 *  - otherwise `shift` extends, preserving the anchor (or starting at
 *    `focusId` when there is no range);
 *  - otherwise a plain click resets the selection to `focusId`.
 */
export function shiftSelect(
  range: MaybeRange,
  { focusId, shift, meta }: { focusId: string; shift?: boolean; meta?: boolean },
): BlockRange | null {
  if (meta) return toggleSelect(range, focusId);
  if (shift) return { anchorId: range?.anchorId ?? focusId, headId: focusId };
  return { anchorId: focusId, headId: focusId };
}

/** Clear the selection. A constant `null`, for a uniform reducer API. */
export function clearSelection(): null {
  return null;
}

/**
 * Whether `id` is one of the range's endpoints (order-free). Use
 * {@link resolveRange} for full-span membership.
 */
export function isSelected(range: MaybeRange, id: string): boolean {
  if (!range) return false;
  return range.anchorId === id || range.headId === id;
}

/** Inclusive index bounds of a range within `blockIds`. */
export type SelectionBounds = {
  start: number;
  end: number;
};

/**
 * The inclusive `{ start, end }` indices of a range in `blockIds`, or `null`
 * when neither endpoint resolves. A single missing endpoint falls back to the
 * surviving one, mirroring {@link resolveRange}.
 */
export function selectionBounds(
  range: MaybeRange,
  blockIds: readonly string[],
): SelectionBounds | null {
  if (!range || blockIds.length === 0) return null;
  const anchor = blockIds.indexOf(range.anchorId);
  const head = blockIds.indexOf(range.headId);
  if (anchor === -1 && head === -1) return null;
  const a = anchor === -1 ? head : anchor;
  const h = head === -1 ? anchor : head;
  return { start: Math.min(a, h), end: Math.max(a, h) };
}

/** Count plus first/last ids of a resolved range (all `null` when empty). */
export type SelectionSummary = {
  count: number;
  first: string | null;
  last: string | null;
};

/** Summarise a range for a status bar / context menu label. */
export function selectionSummary(range: MaybeRange, blockIds: readonly string[]): SelectionSummary {
  const selected = resolveRange(blockIds, range);
  return {
    count: selected.length,
    first: selected[0] ?? null,
    last: selected[selected.length - 1] ?? null,
  };
}

/** What a range delete removes, and where focus should land afterwards. */
export type DeletePlan = {
  /** The ids to remove, in document order. */
  removed: string[];
  /** The surviving block to focus, or `null` when the document empties. */
  focusId: string | null;
};

/**
 * Plan a range delete: the ids to remove plus the block that should receive
 * focus. Focus prefers the first surviving block *after* the range, falling
 * back to the nearest survivor *before* it, and is `null` only when the range
 * removes everything. An unselected range yields an empty plan.
 */
export function deletePlan(range: MaybeRange, blockIds: readonly string[]): DeletePlan {
  const removed = resolveRange(blockIds, range);
  if (removed.length === 0) return { removed: [], focusId: null };

  const bounds = selectionBounds(range, blockIds);
  const removedSet = new Set(removed);
  let focusId: string | null = null;
  if (bounds) {
    for (let i = bounds.end + 1; i < blockIds.length; i += 1) {
      if (!removedSet.has(blockIds[i])) {
        focusId = blockIds[i];
        break;
      }
    }
    if (focusId === null) {
      for (let i = bounds.start - 1; i >= 0; i -= 1) {
        if (!removedSet.has(blockIds[i])) {
          focusId = blockIds[i];
          break;
        }
      }
    }
  }
  return { removed, focusId };
}

/** The clipboard shape for a copied block subset. */
export type ClipboardPayload = {
  /** The normalised, deep-cloned blocks (blank edge placeholders trimmed). */
  blocks: RichNode[];
  /** A markdown flavour of `blocks`, for plain-text paste targets. */
  markdown: string;
};

/**
 * Textblock types whose emptiness is cosmetic: a blank one is dropped from the
 * *edges* of a copied range (interior blanks are intentional and kept). Atoms
 * (image, embed, rule, …) are never blank even without text.
 */
const BLANK_TEXTBLOCK_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/** True for an empty/whitespace-only textblock (a trimmable placeholder). */
function isBlankTextblock(node: RichNode): boolean {
  if (!BLANK_TEXTBLOCK_TYPES.has(node.type ?? "")) return false;
  return prosemirrorToText({ type: "doc", content: [node] }) === "";
}

/**
 * Normalise a copied block subset for the clipboard: deep-clone every block
 * (so later edits never alias the copy), trim blank leading/trailing
 * placeholders (interior blanks survive), and render a markdown flavour. An
 * all-blank subset yields `{ blocks: [], markdown: "" }`.
 */
export function clipboardPayload(blocks: readonly RichNode[]): ClipboardPayload {
  const cloned = blocks.map((block) => JSON.parse(JSON.stringify(block)) as RichNode);
  let start = 0;
  let end = cloned.length;
  while (start < end && isBlankTextblock(cloned[start])) start += 1;
  while (end > start && isBlankTextblock(cloned[end - 1])) end -= 1;
  const normalised = cloned.slice(start, end);
  return {
    blocks: normalised,
    markdown: docToMarkdown({ type: "doc", content: normalised }),
  };
}

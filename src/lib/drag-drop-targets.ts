/**
 * Drag-and-drop target resolution (docs/MISSING_FEATURES.md, "Drag & drop").
 *
 * A drag interaction needs one pure decision: given the laid-out rows (or
 * cards) and the pointer, *where* would a drop land? This module turns that
 * question into data — a `{ index, mode }` target where `mode` is `before`,
 * `after` or `inside`. It is deliberately DOM-free: the caller measures the
 * rects however it likes (getBoundingClientRect, a virtualised row map, a
 * test fixture) and passes plain `{ id, top, height }` values in.
 *
 * The three pieces mirror the rest of the drag code:
 * - {@link resolveDropTarget} is the vertical hit-test, with an optional
 *   horizontal `indentOffset` that promotes a hover to `inside` — the gesture
 *   that re-parents a row in a tree instead of reordering siblings.
 * - {@link canDrop} is the cycle guard (never drop an item onto itself or one
 *   of its descendants), shared by list and tree drops.
 * - {@link moveWithinList} reorders an id/row sequence, and
 *   {@link dropIndicatorStyle} turns a resolved target into the CSS a React
 *   drop indicator renders.
 *
 * Everything is deterministic and immutable: inputs are never mutated, and the
 * same arguments always produce the same value.
 */

/** A laid-out row: where it starts vertically and how tall it is. */
export type DropRect = {
  id: string;
  /** Top edge, in the same coordinate space as the pointer. */
  top: number;
  /** Height in that same space. */
  height: number;
};

/** Where a drop lands relative to the target row. */
export type DropMode = "before" | "after" | "inside";

/** A resolved drop: the target row and the edge/inside it maps to. */
export type DropTarget = {
  /** Index of the target row; `0` for an empty list. */
  index: number;
  mode: DropMode;
};

/** Tuning for {@link resolveDropTarget}. */
export type ResolveDropOptions = {
  /**
   * Vertical band (px) at each edge of a row that counts as `before`/`after`;
   * the middle band is `inside`. Defaults to {@link DROP_THRESHOLD_PX}.
   */
  threshold?: number;
  /**
   * Horizontal distance (px) that promotes a hover to `inside` — the
   * drag-right-to-nest gesture. Defaults to {@link DROP_INDENT_WIDTH_PX}.
   */
  indentWidth?: number;
  /**
   * Horizontal distance the pointer has travelled from the drag origin.
   * Defaults to `0` (a purely vertical drag never nests).
   */
  indentOffset?: number;
};

/** Default before/after edge band, in px. */
export const DROP_THRESHOLD_PX = 4;

/** Default horizontal travel that resolves a drop to `inside`, in px. */
export const DROP_INDENT_WIDTH_PX = 24;

/** Looks up the parent id of a row (`null`/`undefined` = top level). */
export type ParentLookup = (id: string) => string | null | undefined;

/**
 * Resolve the drop target under `y`.
 *
 * - An empty list yields `{ index: 0, mode: "inside" }` — the only sensible
 *   target when there are no rows.
 * - Above the first row (or on its top edge) → `{ index: 0, mode: "before" }`;
 *   at or below the last row's bottom → `{ index: last, mode: "after" }`.
 * - Inside a row, `y` within `threshold` px of an edge is `before`/`after`;
 *   the middle band is `inside`.
 * - A gap between two rows resolves to `before` the following row.
 * - When `indentOffset >= indentWidth` and the pointer is vertically inside a
 *   row, the mode becomes `inside` regardless of the vertical band (the
 *   drag-right-to-nest gesture). `threshold`/`indentWidth` are clamped so
 *   degenerate values (`0`, negative) stay well defined.
 *
 * The rects are never mutated.
 */
export function resolveDropTarget(
  rects: readonly DropRect[],
  y: number,
  options: ResolveDropOptions = {},
): DropTarget {
  if (rects.length === 0) return { index: 0, mode: "inside" };

  const threshold = options.threshold ?? DROP_THRESHOLD_PX;
  const indentWidth = options.indentWidth ?? DROP_INDENT_WIDTH_PX;
  const indentOffset = options.indentOffset ?? 0;

  const first = rects[0];
  if (y <= first.top) return { index: 0, mode: "before" };

  const lastIndex = rects.length - 1;
  const last = rects[lastIndex];
  if (y >= last.top + last.height) return { index: lastIndex, mode: "after" };

  // First row whose bottom is below `y`; a gap floors to the following row.
  let index = lastIndex;
  for (let i = 0; i < rects.length; i += 1) {
    if (y < rects[i].top + rects[i].height) {
      index = i;
      break;
    }
  }

  const rect = rects[index];
  const inRow = y >= rect.top && y <= rect.top + rect.height;
  const wantsInside = indentWidth > 0 && indentOffset >= indentWidth;
  if (inRow && wantsInside) return { index, mode: "inside" };

  const band = Math.max(0, Math.min(threshold, rect.height / 2));
  if (y < rect.top + band) return { index, mode: "before" };
  if (y > rect.top + rect.height - band) return { index, mode: "after" };
  return { index, mode: "inside" };
}

/**
 * Whether `draggedId` may be dropped onto `targetId`.
 *
 * Rejects a drop onto itself and onto any descendant of the dragged item
 * (which would close a parent cycle). `parentOf` walks the current tree from
 * the target upward; a malformed cycle terminates the walk instead of
 * hanging. Ancestors, siblings and unrelated rows are all allowed, as is any
 * target whose chain reaches the top level.
 */
export function canDrop(draggedId: string, targetId: string, parentOf: ParentLookup): boolean {
  if (draggedId === targetId) return false;
  const seen = new Set<string>([targetId]);
  let current = parentOf(targetId);
  while (current != null) {
    if (current === draggedId) return false; // target sits inside the dragged subtree
    if (seen.has(current)) break; // malformed parent cycle — stop
    seen.add(current);
    current = parentOf(current);
  }
  return true;
}

/**
 * Move the item at `fromIndex` to `toIndex`, returning a new array.
 *
 * - An out-of-range or fractional `fromIndex` leaves the sequence unchanged —
 *   still a fresh array, so the result never aliases the input.
 * - `toIndex` is truncated and clamped into `[0, length - 1]`; `0` moves to
 *   the front and any index past the end moves to the back.
 * - Generic over the element type, so the drag UI can reorder live row objects
 *   for an optimistic update and persist the result afterwards.
 * - The input array is never mutated.
 */
export function moveWithinList<T>(ids: readonly T[], fromIndex: number, toIndex: number): T[] {
  const next = [...ids];
  if (
    !Number.isInteger(fromIndex) ||
    fromIndex < 0 ||
    fromIndex >= next.length ||
    !Number.isFinite(toIndex)
  ) {
    return next;
  }
  const target = Math.min(Math.max(Math.trunc(toIndex), 0), next.length - 1);
  const [moved] = next.splice(fromIndex, 1);
  next.splice(target, 0, moved);
  return next;
}

/** The CSS a resolved target maps to; absent keys mean "leave as is". */
export type DropIndicatorStyle = {
  borderTop?: string;
  borderBottom?: string;
  outline?: string;
  outlineOffset?: string;
};

/** The accent line every drop indicator draws. */
const INDICATOR_LINE = "2px solid var(--accent)";

/**
 * The indicator styles for a resolved target: a line above for `before`, a
 * line below for `after`, and an inset outline around the row for `inside`.
 */
export function dropIndicatorStyle(target: DropTarget): DropIndicatorStyle {
  if (target.mode === "before") return { borderTop: INDICATOR_LINE };
  if (target.mode === "after") return { borderBottom: INDICATOR_LINE };
  return { outline: INDICATOR_LINE, outlineOffset: "-2px" };
}

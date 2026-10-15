/**
 * Scroll anchor preservation — the pure math behind keeping a scrolled list
 * visually stable while its content changes.
 *
 * Long documents re-measure as they load, sync or edit: rows above the viewport
 * grow, shrink or appear, and a naive list keeps its raw `scrollTop` and so
 * visibly jumps. An anchor sidesteps that by remembering *what the reader is
 * looking at* instead of where they scrolled to: the index of the row under the
 * viewport's top edge and how many pixels into that row the edge sits
 * ({@link captureAnchor}). When rows change, the caller recomputes each row's
 * offset and asks {@link restoreScrollTop} for the new `scrollTop` that pins the
 * same content, using {@link adjustForInsertions} to keep the anchor valid across
 * structural edits and {@link nearestVisibleIndex} to find the row under an
 * arbitrary offset in the first place.
 *
 * Everything here is pure and deterministic: inputs are never mutated, equal
 * inputs always produce equal outputs, and no DOM, DB or React is involved.
 */

/** A remembered viewport-top position, expressed relative to content. */
export type ScrollAnchor = {
  /** Index of the row containing the viewport's top edge. Never negative. */
  anchorIndex: number;
  /** Pixels from the top of `anchorIndex` down to the viewport's top edge. */
  anchorOffset: number;
  /** The raw scroll offset when the anchor was captured, for fallback. */
  scrollTop: number;
};

/** Raw inputs for {@link captureAnchor}; the trailing fields default to `0`. */
export type CaptureAnchorInput = {
  /** Index of the row under the viewport's top edge. */
  anchorIndex: number;
  /** Pixels into that row where the viewport starts. Default `0`. */
  anchorOffset?: number;
  /** The current scroll offset. Default `0`. */
  scrollTop?: number;
};

/** A freshly measured absolute offset for the anchor's row. */
export type RestoreScrollTopInput = {
  /** Top offset (in pixels) the anchor's row now sits at in the content. */
  newOffsetOfIndex: number;
};

/** A structural edit measured at a row, for {@link adjustForInsertions}. */
export type InsertionInput = {
  /** Index the height change begins at, in the pre-edit content. */
  atIndex: number;
  /** Signed pixels added at `atIndex`: positive grows, negative shrinks. */
  deltaHeight: number;
};

/** Coerce a value to a finite, non-negative integer, falling back when absent. */
function toNonNegativeInt(value: number | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Coerce a value to a finite, non-negative number (fractions preserved). */
function toNonNegativeNumber(value: number | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/**
 * Record the viewport-top position as an anchor.
 *
 * `anchorIndex`, `anchorOffset` and `scrollTop` are floored to whole pixels and
 * clamped to `>= 0`; missing optional fields and non-finite values become `0`.
 * The input is never mutated.
 */
export function captureAnchor(input: CaptureAnchorInput): ScrollAnchor {
  return {
    anchorIndex: toNonNegativeInt(input.anchorIndex),
    anchorOffset: toNonNegativeInt(input.anchorOffset),
    scrollTop: toNonNegativeInt(input.scrollTop),
  };
}

/**
 * The `scrollTop` that re-pins an anchor after its row has been re-measured.
 *
 * The result is the row's new absolute offset plus the intra-row offset captured
 * in {@link captureAnchor}, clamped to `>= 0`. When `newOffsetOfIndex` is not a
 * finite number (the row could not be measured) the anchor's own `scrollTop` is
 * returned as a best-effort fallback.
 */
export function restoreScrollTop(
  anchor: ScrollAnchor,
  input: RestoreScrollTopInput,
): number {
  const offset = input.newOffsetOfIndex;
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    return anchor.scrollTop;
  }
  return Math.max(0, offset + anchor.anchorOffset);
}

/**
 * Rebase an anchor after content above it is inserted or removed.
 *
 * `deltaHeight` is signed: positive means a row of that height appeared, negative
 * that a row of that height disappeared. A change starting strictly below the
 * anchor leaves it untouched. A change starting at or above the anchor moves the
 * anchor's row down (insertion) or up (removal), so the index shifts by one and
 * `scrollTop` shifts by the raw `deltaHeight`; the intra-row `anchorOffset` is
 * unchanged because the row and the viewport edge move together.
 *
 * `scrollTop` is shifted arithmetically and may therefore go negative — that is
 * intentional; {@link restoreScrollTop} is the clamp point when a real scroll
 * position is materialised. A zero or non-finite `deltaHeight` is a no-op, and
 * the index never drops below `0`.
 */
export function adjustForInsertions(
  anchor: ScrollAnchor,
  input: InsertionInput,
): ScrollAnchor {
  const delta = input.deltaHeight;
  const change =
    typeof delta === "number" && Number.isFinite(delta) ? delta : 0;
  if (change === 0) {
    return {
      anchorIndex: anchor.anchorIndex,
      anchorOffset: anchor.anchorOffset,
      scrollTop: anchor.scrollTop,
    };
  }

  const atIndex = toNonNegativeInt(input.atIndex);
  if (atIndex > anchor.anchorIndex) {
    return {
      anchorIndex: anchor.anchorIndex,
      anchorOffset: anchor.anchorOffset,
      scrollTop: anchor.scrollTop,
    };
  }

  const shift = change > 0 ? 1 : -1;
  return {
    anchorIndex: Math.max(0, anchor.anchorIndex + shift),
    anchorOffset: anchor.anchorOffset,
    scrollTop: anchor.scrollTop + change,
  };
}

/**
 * Index of the row that contains `scrollTop`, assuming rows are laid out
 * consecutively from the top with the given `heights`.
 *
 * Returns the last row whose cumulative start is at or before `scrollTop`, so an
 * offset on a row boundary belongs to the row beginning there. Offsets before the
 * list clamp to `0`, offsets past the end clamp to the last row, and an empty
 * list returns `-1`. A non-finite `scrollTop` is treated as `0`; non-finite or
 * negative heights are treated as `0`. The `heights` array is read but never
 * mutated.
 */
export function nearestVisibleIndex(
  scrollTop: number,
  heights: readonly number[],
): number {
  if (heights.length === 0) return -1;

  const target = toNonNegativeNumber(scrollTop, 0);
  const last = heights.length - 1;
  let start = 0;

  for (let index = 0; index < heights.length; index += 1) {
    const next = start + toNonNegativeNumber(heights[index], 0);
    if (target < next || index === last) return index;
    start = next;
  }

  return last;
}

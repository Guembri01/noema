/**
 * H1 — pure virtual-list geometry.
 *
 * Windowing math for long lists, with no DOM, timers, or measurement. Callers
 * own the scroll element and pass plain numbers in; every function here is
 * deterministic and never mutates its inputs. The vocabulary matches the DOM
 * `scrollIntoView` block alignments ("start" | "center" | "end" | "nearest").
 *
 * Two layout modes share one implementation:
 *  - Fixed rows: give `itemHeight`. {@link visibleRange} and
 *    {@link indexAtOffset} take an O(1) arithmetic shortcut.
 *  - Variable rows: also pass `heightOf(index)`. Rows are walked by cumulative
 *    height, so the two are consistent as long as `heightOf` is stable for the
 *    duration of a call (a real virtualizer caches measurements upstream).
 *
 * Bounds are always safe: non-finite / zero / negative geometry degrades to an
 * empty window on top of the list rather than throwing or producing negative
 * offsets. `end` from {@link visibleRange} is exclusive, so `end - start` is the
 * render count.
 *
 * Consistency contract across the helpers:
 *  - `indexAtOffset(offsetForIndex(i)) === i` for `i` in `[0, itemCount)`.
 *  - `totalHeight(n) === offsetForIndex(n)`.
 *  - {@link scrollToIndex} returns a `scrollTop` already clamped to
 *    `[0, max(0, totalHeight - viewportSize)]`.
 */

/** Half-open render window: `[start, end)` over item indices. */
export type VirtualListRange = {
  start: number;
  end: number;
};

/** Row height lookup for variable-height lists. Should return a positive length. */
export type HeightOf = (index: number) => number;

/** Geometry for {@link visibleRange}. */
export type VisibleRangeInput = {
  /** Current scroll offset of the viewport's top edge (negative clamps to 0). */
  scrollTop: number;
  /** Height of the scroll viewport; zero/negative yields an empty window. */
  viewportSize: number;
  /** Fixed row height, used when `heightOf` is absent. */
  itemHeight: number;
  /** Total number of rows in the list. */
  itemCount: number;
  /** Extra rows rendered above and below the visible slice (default 0). */
  overscan?: number;
  /** Variable row heights; when given, takes precedence over `itemHeight`. */
  heightOf?: HeightOf;
};

/** DOM-style block alignment for {@link scrollToIndex}. */
export type ScrollAlign = "start" | "center" | "end" | "nearest";

/** Geometry for {@link scrollToIndex}. */
export type ScrollToIndexOptions = {
  /** Where to place the row (default "nearest" — no-op when already visible). */
  align?: ScrollAlign;
  /** Fixed row height, used when `heightOf` is absent. */
  itemHeight: number;
  /** Total number of rows in the list. */
  itemCount: number;
  /** Height of the scroll viewport. */
  viewportSize: number;
  /** Current scroll offset, required for "nearest" (default 0). */
  scrollTop?: number;
  /** Space kept between the row and the viewport edge (default 0). */
  padding?: number;
  /** Variable row heights; when given, takes precedence over `itemHeight`. */
  heightOf?: HeightOf;
};

/** Upper bound on variable-height walks, so a pathological `heightOf` cannot hang. */
const MAX_INDEX = 10_000_000;

/** `value` if finite, otherwise `fallback`. */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** `value` when finite and positive, otherwise `0`. */
function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Normalised per-row height reader: prefers a valid `heightOf(index)` and falls
 * back to `itemHeight` for invalid entries, so a partial `heightOf` still lays
 * out the whole list.
 */
function heightReader(itemHeight: number, heightOf?: HeightOf): (index: number) => number {
  const fallback = positive(itemHeight);
  if (!heightOf) return () => fallback;
  return (index) => {
    const measured = positive(heightOf(index));
    return measured > 0 ? measured : fallback;
  };
}

/**
 * The half-open index window intersecting `[scrollTop, scrollTop + viewportSize)`,
 * widened by `overscan` and clamped to `[0, itemCount]`. Returns `{ start, end }`
 * with `start <= end`; an empty window is `{ start: end }`.
 */
export function visibleRange(input: VisibleRangeInput): VirtualListRange {
  const itemCount = Math.max(0, Math.floor(finite(input.itemCount, 0)));
  if (itemCount === 0) return { start: 0, end: 0 };

  const viewportSize = positive(input.viewportSize);
  if (viewportSize === 0) return { start: 0, end: 0 };

  const fixedHeight = positive(input.itemHeight);
  // No measurable row height at all — nothing can be windowed.
  if (!input.heightOf && fixedHeight === 0) return { start: 0, end: 0 };

  const scrollTop = Math.max(0, finite(input.scrollTop, 0));
  const overscan = Math.max(0, Math.floor(finite(input.overscan ?? 0, 0)));
  const viewportBottom = scrollTop + viewportSize;
  const height = heightReader(input.itemHeight, input.heightOf);

  let first: number;
  let lastVisibleEnd: number;

  if (!input.heightOf && fixedHeight > 0) {
    first = Math.floor(scrollTop / fixedHeight);
    lastVisibleEnd = Math.ceil(viewportBottom / fixedHeight);
  } else {
    first = itemCount;
    lastVisibleEnd = itemCount;
    let offset = 0;
    for (let i = 0; i < itemCount; i += 1) {
      const bottom = offset + height(i);
      if (first === itemCount && bottom > scrollTop) first = i;
      if (first !== itemCount && offset >= viewportBottom) {
        lastVisibleEnd = i;
        break;
      }
      offset = bottom;
    }
  }

  const clampedFirst = Math.min(itemCount, first);
  const start = Math.max(0, clampedFirst - overscan);
  const end = Math.max(start, Math.min(itemCount, lastVisibleEnd + overscan));
  return { start, end };
}

/**
 * Full height of `itemCount` rows. Zero/negative counts and non-positive heights
 * contribute nothing, so the result is never negative.
 */
export function totalHeight(itemCount: number, itemHeight: number, heightOf?: HeightOf): number {
  const count = Math.max(0, Math.floor(finite(itemCount, 0)));
  if (count === 0) return 0;
  if (!heightOf) return count * positive(itemHeight);

  const height = heightReader(itemHeight, heightOf);
  let total = 0;
  for (let i = 0; i < count; i += 1) total += height(i);
  return total;
}

/**
 * Top offset of row `index` — the sum of all preceding heights. Negative indices
 * and non-finite input clamp to `0`; fractional indices floor to a row.
 */
export function offsetForIndex(index: number, itemHeight: number, heightOf?: HeightOf): number {
  const target = Math.floor(finite(index, 0));
  if (target <= 0) return 0;
  if (!heightOf) return target * positive(itemHeight);

  const height = heightReader(itemHeight, heightOf);
  let offset = 0;
  for (let i = 0; i < target; i += 1) offset += height(i);
  return offset;
}

/**
 * Index of the row containing `offset` — the inverse of {@link offsetForIndex}.
 * Negative offsets clamp to row `0`. For a variable list the walk stops at the
 * first row whose bottom passes `offset`, or where heights run out.
 */
export function indexAtOffset(offset: number, itemHeight: number, heightOf?: HeightOf): number {
  const target = finite(offset, 0);
  if (target <= 0) return 0;

  if (!heightOf) {
    const unit = positive(itemHeight);
    return unit === 0 ? 0 : Math.floor(target / unit);
  }

  const height = heightReader(itemHeight, heightOf);
  let cumulative = 0;
  for (let i = 0; i < MAX_INDEX; i += 1) {
    const h = height(i);
    if (h <= 0) return i;
    if (cumulative + h > target) return i;
    cumulative += h;
  }
  return MAX_INDEX;
}

/**
 * The `scrollTop` that brings row `index` into view per `align`, clamped to the
 * scrollable range. Out-of-range indices clamp into the list, and an empty list
 * yields `0`. `nearest` (the default) only moves the viewport when the row is
 * outside it, matching `Element.scrollIntoView({ block: "nearest" })`.
 */
export function scrollToIndex(index: number, options: ScrollToIndexOptions): number {
  const itemCount = Math.max(0, Math.floor(finite(options.itemCount, 0)));
  if (itemCount === 0) return 0;

  const viewportSize = positive(options.viewportSize);
  const total = totalHeight(itemCount, options.itemHeight, options.heightOf);
  const maxScroll = Math.max(0, total - viewportSize);
  const padding = Math.max(0, finite(options.padding ?? 0, 0));
  const height = heightReader(options.itemHeight, options.heightOf);

  const target = Math.min(itemCount - 1, Math.max(0, Math.floor(finite(index, 0))));
  const top = offsetForIndex(target, options.itemHeight, options.heightOf);
  const bottom = top + height(target);
  const current = Math.max(0, finite(options.scrollTop ?? 0, 0));
  const viewportBottom = current + viewportSize;

  const align = options.align ?? "nearest";
  let desired: number;
  if (align === "start") {
    desired = top - padding;
  } else if (align === "end") {
    desired = bottom + padding - viewportSize;
  } else if (align === "center") {
    desired = top - (viewportSize - (bottom - top)) / 2;
  } else if (top - padding < current) {
    desired = top - padding;
  } else if (bottom + padding > viewportBottom) {
    desired = bottom + padding - viewportSize;
  } else {
    desired = current;
  }

  return Math.min(maxScroll, Math.max(0, finite(desired, 0)));
}

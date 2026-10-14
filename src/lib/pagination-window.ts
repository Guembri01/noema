/**
 * Pagination window — the pure "page numbers" shaping behind a numbered pager.
 *
 * A pager rarely wants every page link for a large collection: it wants the
 * first/last pages pinned, a small run of pages around the current one, and an
 * ellipsis wherever pages are skipped. This module computes exactly that
 * (deterministically, with no DB, DOM or React) plus the small helpers a caller
 * needs to wire it up — {@link pageCount}, {@link clampPage},
 * {@link hasPrev}/{@link hasNext} and {@link rangeForPage}.
 *
 * The window follows the widely-used MUI/`usePagination` layout: `boundary`
 * pages are always shown at each end, `siblings` pages flank the current page,
 * and a gap of a single page is filled in rather than replaced by an ellipsis
 * (so a short document never shows a pointless `1 … 3`).
 *
 * Everything is pure: inputs are never mutated and equal inputs always produce
 * the same output.
 */

/** The ellipsis slot used for a gap in the page run. */
export const PAGINATION_ELLIPSIS = "…";

/** The marker type for a skipped run of pages. */
export type PaginationEllipsis = typeof PAGINATION_ELLIPSIS;

/** One slot in a rendered pager: a concrete page number or an ellipsis. */
export type PaginationSlot = number | PaginationEllipsis;

/** Options for {@link paginationWindow}. `siblings` and `boundary` default to 1. */
export type PaginationWindowOptions = {
  /** The active page (1-based). Out-of-range values are clamped. */
  current: number;
  /** Total number of pages (must be finite). `<= 0` yields `[]`. */
  total: number;
  /** Pages shown immediately on each side of the current page. Default 1. */
  siblings?: number;
  /** Pages always pinned at the start and the end. Default 1. */
  boundary?: number;
};

/** An end-exclusive, 0-based slice range — feed straight to `Array#slice`. */
export type PageRange = { start: number; end: number };

/** Coerce a count to a finite, non-negative integer, falling back when absent. */
function normalizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  if (value === Number.POSITIVE_INFINITY) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Coerce a total/item count to a finite, non-negative integer. */
function normalizeTotal(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Inclusive integer range `start..end`; empty when `start > end`. */
function range(start: number, end: number): number[] {
  if (start > end) return [];
  const out: number[] = [];
  for (let value = start; value <= end; value += 1) out.push(value);
  return out;
}

/**
 * Number of pages needed to hold `totalItems` at `perPage` per page:
 * `ceil(totalItems / perPage)`. Returns `0` when either input is non-positive
 * (nothing to paginate), so an empty collection reports zero pages.
 */
export function pageCount(totalItems: number, perPage: number): number {
  const items = normalizeTotal(totalItems);
  const size = normalizeTotal(perPage);
  if (items === 0 || size === 0) return 0;
  return Math.ceil(items / size);
}

/**
 * Clamp a requested page into `1..total`, flooring fractions and treating a
 * missing/non-numeric page as `1`. When `total <= 0` (no pages) the result is
 * still `1`: the conventional "the first page" value that keeps a pager's
 * previous/next links inert rather than undefined.
 */
export function clampPage(page: number, total: number): number {
  const totalPageCount = normalizeTotal(total);
  const max = totalPageCount > 0 ? totalPageCount : 1;
  const value = typeof page === "number" && Number.isFinite(page) ? Math.floor(page) : 1;
  if (value < 1) return 1;
  if (value > max) return max;
  return value;
}

/** True when moving to the previous page is possible. */
export function hasPrev(page: number, total: number): boolean {
  return clampPage(page, total) > 1;
}

/** True when moving to the next page is possible. */
export function hasNext(page: number, total: number): boolean {
  return clampPage(page, total) < normalizeTotal(total);
}

/**
 * The 0-based, end-exclusive slice range for `page` at `perPage` items per page
 * — i.e. `items.slice(range.start, range.end)`. Page 2 of 10 spans items
 * `10..20`. A page below 1 clamps to the first page; a non-positive `perPage`
 * collapses to the empty range `{ start: 0, end: 0 }`.
 */
export function rangeForPage(page: number, perPage: number): PageRange {
  const size = normalizeTotal(perPage);
  if (size === 0) return { start: 0, end: 0 };
  const safePage = clampPage(page, Number.MAX_SAFE_INTEGER);
  const start = (safePage - 1) * size;
  return { start, end: start + size };
}

/**
 * Build the ordered page-number run for a pager, with {@link PAGINATION_ELLIPSIS}
 * marking any skipped span.
 *
 * `boundary` pages are pinned at each end, `siblings` pages flank `current`, and
 * `current` itself is always included. A gap that hides exactly one page is
 * filled with that page instead of an ellipsis. A `total <= 0` yields `[]`, and
 * `total === 1` yields `[1]`. Out-of-range `current` values are clamped, and
 * negative `siblings`/`boundary` are treated as `0`.
 */
export function paginationWindow(options: PaginationWindowOptions): PaginationSlot[] {
  const totalPageCount = normalizeTotal(options.total);
  if (totalPageCount === 0) return [];

  const boundaryCount = Math.min(normalizeCount(options.boundary, 1), totalPageCount);
  const siblingCount = Math.min(normalizeCount(options.siblings, 1), totalPageCount);
  const currentPage = clampPage(options.current, totalPageCount);

  const startPages = range(1, Math.min(boundaryCount, totalPageCount));
  const endPages = range(
    Math.max(totalPageCount - boundaryCount + 1, boundaryCount + 1),
    totalPageCount,
  );

  const siblingsStart = Math.max(
    Math.min(currentPage - siblingCount, totalPageCount - boundaryCount - siblingCount * 2 - 1),
    boundaryCount + 2,
  );
  const siblingsEnd = Math.min(
    Math.max(currentPage + siblingCount, boundaryCount + siblingCount * 2 + 2),
    endPages.length > 0 ? endPages[0] - 2 : totalPageCount - 1,
  );

  const slots: PaginationSlot[] = [...startPages];

  if (siblingsStart > boundaryCount + 2) {
    slots.push(PAGINATION_ELLIPSIS);
  } else if (boundaryCount + 1 < totalPageCount - boundaryCount) {
    // Only one page is hidden here — show it rather than an ellipsis.
    slots.push(boundaryCount + 1);
  }

  for (const page of range(siblingsStart, siblingsEnd)) slots.push(page);

  if (siblingsEnd < totalPageCount - boundaryCount - 1) {
    slots.push(PAGINATION_ELLIPSIS);
  } else if (totalPageCount - boundaryCount > boundaryCount) {
    // Only one page is hidden here — show it rather than an ellipsis.
    slots.push(totalPageCount - boundaryCount);
  }

  for (const page of endPages) slots.push(page);

  return slots;
}

/**
 * Pure helpers for the manual row-order property (MISSING_FEATURES §3;
 * database-deep R89.19 "Move row / manual order").
 *
 * Rows already carry a persisted `Page.position`, and the rest of the codebase
 * numbers it on a sparse **1000-step integer scale**: a fresh row gets
 * `(last?.position ?? 0) + 1000` and a full reorder rewrites positions to
 * `(index + 1) * 1000` (`server/actions/database.ts:171`). The generous step is
 * deliberate — it leaves room to drop an insert between two neighbours by
 * midpoint without touching the rows around it. This module is that arithmetic
 * made provable, with no DB, route or React in sight.
 *
 * The structural blueprint mirrors `src/lib/favorites.ts` (the sidebar's
 * equivalent manual order): a generic `reorder*` returning a fresh array, a
 * dense `renumber*`, a stable display comparator, and an order-preserving
 * comparator. The numbering convention follows `Page.position` (1000-steps),
 * not favorites' 0..n-1 index scale.
 */

/** Spacing between adjacent orders on the persisted scale. */
export const ORDER_STEP = 1000;

/** The order a row receives when it is the first in an empty list. */
export const FIRST_ORDER = ORDER_STEP;

export type OrderedRowLike = {
  id: string;
  /**
   * Manual order. Missing, `null` or non-finite rows rank after every
   * positioned row and are candidates for `normalizeOrders`.
   */
  order?: number | null;
};

/** A usable order is a finite number; `null`/`undefined`/`NaN` are not. */
function isUsableOrder(order: number | null | undefined): order is number {
  return typeof order === "number" && Number.isFinite(order);
}

/**
 * Move the row at `fromIndex` to `toIndex`, returning a new array.
 *
 * - `fromIndex` must be an in-bounds integer; anything else (out of range,
 *   fractional, `NaN`) leaves the order unchanged — still a fresh array, so
 *   callers may rely on the result never aliasing the input.
 * - `toIndex` is truncated and clamped into `[0, length - 1]`, so `0` is
 *   move-to-front and any index past the end is move-to-back.
 * - Generic over the element type: the drag UI can reorder live row objects
 *   for an optimistic update and persist the renumbered result afterwards.
 * - The input array is never mutated.
 */
export function reorderRows<T>(rows: readonly T[], fromIndex: number, toIndex: number): T[] {
  const next = [...rows];
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

/**
 * Assign dense 1000-step orders in the array's current sequence:
 * element 0 → 1000, element 1 → 2000, element 2 → 3000…
 *
 * The caller decides the sequence (e.g. the output of `reorderRows` or of
 * `sortByOrder`); this function does not sort. Use it to persist an order
 * after a drag — the same dense rewrite `reorderPropertiesAction` performs for
 * columns. New objects are returned; the input array and its rows are never
 * mutated.
 */
export function renumberOrders<T extends OrderedRowLike>(rows: readonly T[]): Array<T & { order: number }> {
  return rows.map((row, index) => ({ ...row, order: (index + 1) * ORDER_STEP }));
}

/**
 * The order to give a row inserted between `beforeOrder` and `afterOrder`.
 *
 * - Between two orders → the integer midpoint (`1000` & `2000` → `1500`).
 * - Before the first row (`afterOrder` only) → half the first order
 *   (`undefined` & `1000` → `500`).
 * - After the last row (`beforeOrder` only) → one step later
 *   (`1000` & `undefined` → `2000`).
 * - Empty scale (neither) → `1000` (`FIRST_ORDER`).
 * - Missing, `null` or non-finite neighbours are treated as absent.
 *
 * When two neighbours are only one unit apart there is no integer strictly
 * between them; the floor midpoint then collides with `beforeOrder`. That is
 * expected — `needsRenumber` detects it and `normalizeOrders` repairs the list.
 */
export function orderForInsertBetween(
  beforeOrder?: number | null,
  afterOrder?: number | null,
): number {
  const before = isUsableOrder(beforeOrder) ? beforeOrder : undefined;
  const after = isUsableOrder(afterOrder) ? afterOrder : undefined;

  if (before === undefined && after === undefined) return FIRST_ORDER;
  if (before === undefined) return Math.floor((after as number) / 2);
  if (after === undefined) return before + ORDER_STEP;
  return Math.floor((before + after) / 2);
}

/** Stable ascending comparator by order; missing orders rank last, ties by id. */
export function compareByOrder(a: OrderedRowLike, b: OrderedRowLike): number {
  const rank = (row: OrderedRowLike): number =>
    isUsableOrder(row.order) ? row.order : Number.MAX_SAFE_INTEGER;
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * A copy of `rows` sorted by manual order ascending, with rows whose order is
 * missing / `null` / `NaN` last and a deterministic `id` ascending tiebreak.
 *
 * The tiebreak makes the sequence independent of the input permutation, so any
 * duplicate or unpositioned rows still render in one canonical order. The input
 * array is never mutated.
 */
export function sortByOrder<T extends OrderedRowLike>(rows: readonly T[]): T[] {
  return [...rows].sort(compareByOrder);
}

/**
 * Rewrite duplicate and gapped orders into a dense 1000-step sequence while
 * preserving the relative order the rows already had.
 *
 * - Rows are ranked by their current order (usable values ascending, missing
 *   last). Sorting is **stable**, so rows that share an order — or that all
 *   lack one — keep their input relative order.
 * - The output is `(index + 1) * 1000` in that sequence, so `1000, 5000, 9000`
 *   compacts to `1000, 2000, 3000` and two rows at `1000` become `1000, 2000`.
 * - New objects are returned; the input array and its rows are never mutated.
 */
export function normalizeOrders<T extends OrderedRowLike>(rows: readonly T[]): Array<T & { order: number }> {
  // Stable by construction: equal ranks compare 0 and Array#sort keeps input order.
  const ranked = [...rows].sort((a, b) => {
    const ra = isUsableOrder(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
    const rb = isUsableOrder(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
  return ranked.map((row, index) => ({ ...row, order: (index + 1) * ORDER_STEP }));
}

/**
 * Whether a row list should be renumbered before further inserts are trusted.
 *
 * Returns `true` when any of these hold:
 * - a row has no usable order (missing / `null` / `NaN`);
 * - two rows share an order (adjacent gap `0`);
 * - adjacent usable orders in ascending rank are closer than `minGap`
 *   (default `1`, i.e. only exact duplicates / fractional collisions trip it).
 *
 * An empty list, or any list of distinct orders spaced at least `minGap`
 * apart, needs no renumber — regardless of the array's current sequence.
 */
export function needsRenumber(
  rows: readonly OrderedRowLike[],
  { minGap = 1 }: { minGap?: number } = {},
): boolean {
  const usable = rows.filter((row) => isUsableOrder(row.order)).map((row) => row.order as number);
  if (usable.length !== rows.length) return true; // an unpositioned row needs the scale rebuilt
  if (usable.length < 2) return false;

  const gap = Number.isFinite(minGap) ? Math.max(0, minGap) : 0;
  usable.sort((a, b) => a - b);
  for (let i = 1; i < usable.length; i += 1) {
    if (usable[i] - usable[i - 1] < gap) return true;
  }
  return false;
}

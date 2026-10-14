/**
 * Pure helpers for the sidebar Favorites section (B44) plus the pure core of
 * manual pin management (MISSING_FEATURES §9: favorites reorder).
 *
 * The section renders whatever `getFavorites()` returns, but the render order
 * must be deterministic: dedupe first (defensive — the DB already enforces
 * `@@unique([userId, pageId])`, but a race during a toggle must never produce
 * two `<li>` keys for one page), then apply an optional explicit ranking.
 * On top of that, `reorderFavorites` / `renumberFavorites` /
 * `sortFavoritesForDisplay` / `favoritePositionMap` let the sidebar move a
 * favorite to an arbitrary rank without a round-trip: the persisted order
 * model is an id sequence whose positions are array indices, so renumbering
 * compacts onto exactly that 0..n-1 index scale.
 */

export type FavoritePageLike = { id: string };
export type FavoriteRowLike = { page: FavoritePageLike };
export type PositionedFavoriteLike = FavoriteRowLike & {
  /** Manual ranking; absent, `null` or non-finite ranks after every explicit position. */
  position?: number | null;
};

/**
 * Drop keyless rows and collapse duplicates by `page.id`, keeping the first
 * occurrence of each. Pure: the input array is never mutated.
 *
 * This is the shared guard every other helper in this file builds on —
 * idempotent favorite-add means a double star can never render twice or
 * receive two different manual positions.
 */
export function dedupeFavorites<T extends FavoriteRowLike>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const id = row?.page?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(row);
  }
  return deduped;
}

/**
 * Sequence the favorites rows for rendering.
 *
 * - Rows with a missing/empty `page.id` are dropped (never render a keyless row).
 * - Duplicates collapse to their first occurrence.
 * - `order`, when it lists page ids, ranks those rows first **in that exact
 *   sequence**; rows it does not mention keep their relative input order after
 *   the ranked block (Array.sort is stable, so unrated rows stay put).
 * - Order ids absent from `rows` are ignored.
 * - The input array is never mutated.
 *
 * With no `order` (the current data path: `Favorite.id asc`, a time-sortable
 * cuid, so insertion order) the result is simply the deduped input order —
 * which is why the sidebar sequence survives a reload.
 */
export function orderFavorites<T extends FavoriteRowLike>(
  rows: readonly T[],
  order?: readonly string[] | null,
): T[] {
  const deduped = dedupeFavorites(rows);

  if (!order || order.length === 0) return deduped;

  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (id && !rank.has(id)) rank.set(id, index);
  });
  if (rank.size === 0) return deduped;

  const unrated = Number.MAX_SAFE_INTEGER;
  // Stable sort: unrated rows keep their input order among themselves.
  return [...deduped].sort(
    (a, b) => (rank.get(a.page.id) ?? unrated) - (rank.get(b.page.id) ?? unrated),
  );
}

/**
 * Move the entry at `fromIndex` to `toIndex`, returning a new array.
 *
 * - `fromIndex` must be an in-bounds integer; anything else (out of range,
 *   fractional, `NaN`) leaves the order unchanged — still a fresh array, so
 *   callers may rely on the result never aliasing the input.
 * - `toIndex` is truncated and clamped into `[0, length - 1]`, so `0` is
 *   move-to-front and any index past the end is move-to-back.
 * - Generic over the element type on purpose: it reorders rows for optimistic
 *   sidebar updates *and* `page.id` sequences for the persisted `order` field.
 * - The input array is never mutated.
 */
export function reorderFavorites<T>(
  list: readonly T[],
  fromIndex: number,
  toIndex: number,
): T[] {
  const next = [...list];
  if (
    !Number.isInteger(fromIndex) ||
    fromIndex < 0 ||
    fromIndex >= next.length ||
    !Number.isFinite(toIndex)
  ) {
    return next;
  }
  const target = Math.min(Math.max(Math.trunc(toIndex), 0), next.length - 1);
  const [entry] = next.splice(fromIndex, 1);
  next.splice(target, 0, entry);
  return next;
}

/**
 * Comparator for the sidebar: explicit manual `position` first (ascending),
 * then a deterministic tiebreak on `page.id` ascending.
 *
 * Rows without a usable position (absent, `null`, `NaN`, `±Infinity`) rank
 * after every positioned row; among themselves — like equal-position rows —
 * they are ordered by `page.id`, so any input permutation of the same
 * favorites renders in the same sequence even though `Array.prototype.sort`
 * only guarantees stability for equal keys.
 */
export function sortFavoritesForDisplay(
  a: PositionedFavoriteLike,
  b: PositionedFavoriteLike,
): number {
  const rank = (row: PositionedFavoriteLike): number =>
    typeof row.position === "number" && Number.isFinite(row.position)
      ? row.position
      : Number.MAX_SAFE_INTEGER;
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  if (a.page.id === b.page.id) return 0;
  return a.page.id < b.page.id ? -1 : 1;
}

/**
 * Return the rows with their `position` renumbered into a gap-free `0..n-1`
 * sequence — the array-index scale `orderFavorites` ranks by — so an
 * insert/remove that leaves gaps (positions 0, 1, 7 → 0, 1, 2) is compacted
 * before the order is persisted.
 *
 * - Rows are deduped/keyless-dropped first (same rules as `dedupeFavorites`).
 * - Current positions only decide the sequence (`sortFavoritesForDisplay`);
 *   the returned values are always `0..n-1` in display order.
 * - New objects are returned; the input array and its rows are never mutated.
 */
export function renumberFavorites<T extends PositionedFavoriteLike>(
  rows: readonly T[],
): Array<T & { position: number }> {
  return dedupeFavorites(rows)
    .sort(sortFavoritesForDisplay)
    .map((row, index) => ({ ...row, position: index }));
}

/**
 * Page id → index within `rows` (after the usual keyless-drop/dedupe), for
 * O(1) lookups — e.g. the sidebar locating a dragged favorite without
 * scanning. First occurrence wins, matching `orderFavorites`; feed it a
 * display-sorted list (see `sortFavoritesForDisplay`) to get display indices.
 */
export function favoritePositionMap<T extends FavoriteRowLike>(
  rows: readonly T[],
): Map<string, number> {
  const map = new Map<string, number>();
  dedupeFavorites(rows).forEach((row, index) => {
    map.set(row.page.id, index);
  });
  return map;
}

/**
 * Pure helpers for the sidebar Favorites section (B44).
 *
 * The section renders whatever `getFavorites()` returns, but the render order
 * must be deterministic: dedupe first (defensive — the DB already enforces
 * `@@unique([userId, pageId])`, but a race during a toggle must never produce
 * two `<li>` keys for one page), then apply an optional explicit ranking.
 */

export type FavoritePageLike = { id: string };
export type FavoriteRowLike = { page: FavoritePageLike };

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
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const id = row?.page?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(row);
  }

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

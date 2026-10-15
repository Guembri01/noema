/**
 * Recently viewed pages — the pure, deterministic core behind the sidebar
 * "Recent" section.
 *
 * A history is an ordered list of {@link RecentPage} records, most-recently
 * visited first. Everything here is **pure and immutable**: functions take a
 * list and return a new one, never mutating the argument or its entries. No
 * timers, no storage, no React — callers own the clock and the persistence, and
 * pass `now` in so ranking is reproducible under test.
 *
 * Two ideas compose:
 *
 * - {@link recordVisit} keeps the list a deduped, move-to-front, size-capped
 *   log — the cheap "most recent first" view.
 * - {@link recentPages} ranks through {@link recencyScore}, an exponential
 *   half-life decay, so a caller can weight, threshold or, in future, blend
 *   freshness with other signals instead of trusting raw timestamps.
 *
 * With a positive half-life the decayed score is monotonic in `visitedAt`, so
 * `recentPages` orders exactly like the log; the decay matters when the score
 * is read directly. A blank id or a corrupt timestamp is dropped rather than
 * rendered, keeping a broken row from shadowing a good one.
 */

/** One visited page. */
export type RecentPage = {
  /** The page's identity; blank/whitespace ids are rejected. */
  pageId: string;
  /** Epoch milliseconds of the most recent visit. */
  visitedAt: number;
};

/** How many entries a recorded/merged history keeps. */
export const MAX_RECENT_PAGES = 20;

/** Default half-life for {@link recentPages}: one week. */
export const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Options controlling {@link recencyScore} / {@link recentPages}. */
export type RecentPagesOptions = {
  /** Maximum number of pages to return. Non-finite means "all". */
  limit: number;
  /** The comparison instant (epoch ms). */
  now: number;
  /** Age at which a visit's score halves. Defaults to no decay. */
  halfLifeMs?: number;
};

/**
 * Drop entries with a blank id, trim ids, coerce a non-finite `visitedAt` to
 * `0`, and collapse duplicates by id keeping the most recent timestamp.
 * Always returns a fresh array of fresh objects.
 */
function clean(list: readonly RecentPage[] | null | undefined): RecentPage[] {
  const source = Array.isArray(list) ? list : [];
  const byId = new Map<string, RecentPage>();
  for (const entry of source) {
    const id = typeof entry?.pageId === "string" ? entry.pageId.trim() : "";
    if (!id) continue;
    const visitedAt =
      typeof entry?.visitedAt === "number" && Number.isFinite(entry.visitedAt)
        ? entry.visitedAt
        : 0;
    const existing = byId.get(id);
    if (!existing || visitedAt > existing.visitedAt) {
      byId.set(id, { pageId: id, visitedAt });
    }
  }
  return [...byId.values()];
}

/**
 * Record a visit to `pageId` at `now` and return a new, most-recent-first list.
 *
 * - A repeat visit **moves** the page to the front and re-stamps `visitedAt`
 *   (no duplicate row).
 * - A blank id is ignored; the list is still copied.
 * - A non-finite `now` is coerced to `0` so the history stays orderable.
 * - The result is capped at {@link MAX_RECENT_PAGES}, dropping the oldest tail.
 * - The input array and its entries are never mutated.
 */
export function recordVisit(
  list: readonly RecentPage[] | null | undefined,
  pageId: string,
  now: number,
): RecentPage[] {
  const id = typeof pageId === "string" ? pageId.trim() : "";
  const rest = clean(list);
  if (!id) return rest;

  const visitedAt = Number.isFinite(now) ? now : 0;
  const without = rest.filter((entry) => entry.pageId !== id);
  return [{ pageId: id, visitedAt }, ...without].slice(0, MAX_RECENT_PAGES);
}

/**
 * The decayed freshness of one visit, in `(0, 1]`: `2 ^ (-age / halfLifeMs)`,
 * where `age = max(0, now - visitedAt)`.
 *
 * - A page seen right now scores `1`, one half-life old scores `0.5`, etc.
 * - A future timestamp (negative age) is clamped, so a skewed clock cannot
 *   exceed `1`.
 * - A non-positive or non-finite `halfLifeMs` disables decay and scores `1`.
 * - An entry whose `visitedAt` is not a finite number scores `0`.
 */
export function recencyScore(
  entry: Partial<RecentPage> | null | undefined,
  options: { now: number; halfLifeMs?: number } | null | undefined,
): number {
  const visitedAt = entry?.visitedAt;
  if (typeof visitedAt !== "number" || !Number.isFinite(visitedAt)) return 0;

  const halfLifeMs = options?.halfLifeMs;
  if (typeof halfLifeMs !== "number" || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    return 1;
  }

  const rawNow = options?.now;
  const now = typeof rawNow === "number" && Number.isFinite(rawNow) ? rawNow : 0;
  const age = Math.max(0, now - visitedAt);
  return Math.pow(2, -age / halfLifeMs);
}

/**
 * The history ranked for display: at most `limit` entries, freshest first.
 *
 * Equivalent to deduping by id (keeping the most recent visit) and sorting by
 * {@link recencyScore} descending; ties fall back to `visitedAt` descending
 * and then `pageId` ascending, so any permutation of the same rows renders in
 * the same sequence. `limit` is floored and clamped at `0`; a non-finite
 * `limit` means "everything". Pure — the input is not mutated.
 */
export function recentPages(
  list: readonly RecentPage[] | null | undefined,
  options: RecentPagesOptions | null | undefined,
): RecentPage[] {
  const cleaned = clean(list);
  const rawLimit = options?.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.max(0, Math.floor(rawLimit))
      : cleaned.length;
  const rawNow = options?.now;
  const now = typeof rawNow === "number" && Number.isFinite(rawNow) ? rawNow : 0;
  const halfLifeMs = options?.halfLifeMs;

  return cleaned
    .map((entry) => ({ entry, score: recencyScore(entry, { now, halfLifeMs }) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.entry.visitedAt !== a.entry.visitedAt) {
        return b.entry.visitedAt - a.entry.visitedAt;
      }
      if (a.entry.pageId === b.entry.pageId) return 0;
      return a.entry.pageId < b.entry.pageId ? -1 : 1;
    })
    .slice(0, limit)
    .map((ranked) => ranked.entry);
}

/** Forget every visited page. Returns a fresh empty list. */
export function clearRecent(): RecentPage[] {
  return [];
}

/**
 * Drop `pageId` from the history, returning a new list. A blank id, or one not
 * present, leaves the cleaned list unchanged (still a fresh array). The input
 * is never mutated.
 */
export function removePage(
  list: readonly RecentPage[] | null | undefined,
  pageId: string,
): RecentPage[] {
  const id = typeof pageId === "string" ? pageId.trim() : "";
  const cleaned = clean(list);
  if (!id) return cleaned;
  return cleaned.filter((entry) => entry.pageId !== id);
}

/**
 * Combine two histories (e.g. an anonymous local list and the server list) into
 * one, most-recent-first and capped at {@link MAX_RECENT_PAGES}.
 *
 * A page present in both keeps its more recent `visitedAt`; exact ties fall
 * back to `pageId` ascending for a deterministic order. The result contains
 * fresh objects and neither input is mutated.
 */
export function mergeRecent(
  a: readonly RecentPage[] | null | undefined,
  b: readonly RecentPage[] | null | undefined,
): RecentPage[] {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  return clean([...left, ...right])
    .sort((x, y) => {
      if (y.visitedAt !== x.visitedAt) return y.visitedAt - x.visitedAt;
      if (x.pageId === y.pageId) return 0;
      return x.pageId < y.pageId ? -1 : 1;
    })
    .slice(0, MAX_RECENT_PAGES);
}

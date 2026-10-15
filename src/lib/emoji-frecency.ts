/**
 * Recently-used emoji ranking (frecency).
 *
 * The emoji picker shows a "frequently used" strip: entries the user reaches
 * for often *and* recently should float to the top. This is the pure core of
 * that strip, kept clock-free and DOM-free — every mutator is handed the
 * instant it records (`recordUse(..., now)`) and every ranker the instant it
 * measures against (`rankRecent(list, { now, halfLifeMs })`), so the picker,
 * a test and a persistence layer all derive the same order.
 *
 * Ranking is the classic frecency score:
 *
 *     score = count * 2 ** -((now - lastUsedAt) / halfLifeMs)
 *
 * i.e. a usage loses half its weight every `halfLifeMs`. When `halfLifeMs`
 * is not positive the decay is skipped and the score is just the count. Ties
 * are broken deterministically — higher count, then more recent, then the
 * emoji itself — so any input permutation of the same usages ranks the same.
 *
 * A usage list is a small LRU-ish store: `recordUse` increments the counter,
 * restamps the entry and caps the list (`MAX_USAGES`), evicting the least
 * recently used entry. `mergeUsages` folds a persisted list and a session
 * list together without a clock.
 *
 * Red-first unit-pinned by `src/lib/emoji-frecency.test.ts`.
 */

/** One emoji's usage record. `count` is monotonic; `lastUsedAt` is a ms epoch. */
export type EmojiUsage = {
  emoji: string;
  count: number;
  lastUsedAt: number;
};

/** A usage plus its computed frecency score. */
export type RankedEmojiUsage = EmojiUsage & {
  score: number;
};

/** Default cap on the stored usage list. */
export const MAX_USAGES = 64;

/** Default decay half-life (7 days) when a caller omits one. */
export const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default `topRecent` limit when a caller omits one. */
export const DEFAULT_TOP_LIMIT = 10;

/** Frecency score for one entry at `now`. Non-positive half-life = no decay. */
function scoreOf(
  entry: EmojiUsage,
  now: number,
  halfLifeMs: number,
): number {
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return entry.count;
  return entry.count * Math.pow(2, -(now - entry.lastUsedAt) / halfLifeMs);
}

/** Order: score desc, then recency desc, then emoji asc (all deterministic). */
function compareRanked(a: RankedEmojiUsage, b: RankedEmojiUsage): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
  return a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0;
}

/**
 * Collapse a list into copies keyed by emoji, preserving first-seen order:
 * counts sum and `lastUsedAt` takes the max. Entries without an emoji are
 * dropped. Shared by `recordUse`, `mergeUsages` and `rankRecent` so a list
 * carrying duplicate rows can never produce two entries for one emoji.
 */
function normalize(list: readonly EmojiUsage[] | null | undefined): {
  order: string[];
  byEmoji: Map<string, EmojiUsage>;
} {
  const order: string[] = [];
  const byEmoji = new Map<string, EmojiUsage>();
  if (!Array.isArray(list)) return { order, byEmoji };
  for (const entry of list) {
    if (!entry || !entry.emoji) continue;
    const existing = byEmoji.get(entry.emoji);
    if (existing) {
      existing.count += entry.count;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, entry.lastUsedAt);
    } else {
      byEmoji.set(entry.emoji, {
        emoji: entry.emoji,
        count: entry.count,
        lastUsedAt: entry.lastUsedAt,
      });
      order.push(entry.emoji);
    }
  }
  return { order, byEmoji };
}

/**
 * Trim `order`/`byEmoji` to `cap` entries, dropping the least recently used
 * first (ties: lower count, then larger emoji). Survivors keep their original
 * relative order. Returns fresh objects.
 */
function capList(order: string[], byEmoji: Map<string, EmojiUsage>, cap: number): EmojiUsage[] {
  const keep: string[] = [...order];
  if (keep.length > cap) {
    const byRecency = [...keep].sort((a, b) => {
      const ea = byEmoji.get(a) as EmojiUsage;
      const eb = byEmoji.get(b) as EmojiUsage;
      if (ea.lastUsedAt !== eb.lastUsedAt) return eb.lastUsedAt - ea.lastUsedAt;
      if (ea.count !== eb.count) return eb.count - ea.count;
      return ea.emoji < eb.emoji ? -1 : ea.emoji > eb.emoji ? 1 : 0;
    });
    const survivors = new Set(byRecency.slice(0, cap));
    keep.length = 0;
    for (const emoji of order) if (survivors.has(emoji)) keep.push(emoji);
  }
  return keep.map((emoji) => ({ ...(byEmoji.get(emoji) as EmojiUsage) }));
}

/**
 * Record one use of `emoji` at `now`: increment its count, restamp it, and
 * append it if unseen. The result is capped to `cap` entries (`MAX_USAGES` by
 * default), evicting the least recently used entry to make room. Pure — the
 * input list and its rows are never mutated. An empty `emoji` is a no-op that
 * still returns a fresh copy.
 */
export function recordUse(
  list: readonly EmojiUsage[],
  emoji: string,
  now: number,
  cap: number = MAX_USAGES,
): EmojiUsage[] {
  const limit = Number.isInteger(cap) && cap > 0 ? cap : MAX_USAGES;
  const { order, byEmoji } = normalize(list);
  if (!emoji) return capList(order, byEmoji, limit);

  const existing = byEmoji.get(emoji);
  if (existing) {
    existing.count += 1;
    existing.lastUsedAt = now;
  } else {
    byEmoji.set(emoji, { emoji, count: 1, lastUsedAt: now });
    order.push(emoji);
  }
  return capList(order, byEmoji, limit);
}

/**
 * Rank usages by frecency at `now` (`halfLifeMs` defaults to a week). Returns
 * fresh `{ emoji, count, lastUsedAt, score }` rows in descending score order;
 * ties break on recency, then emoji. The input is never mutated.
 */
export function rankRecent(
  list: readonly EmojiUsage[],
  options: { now: number; halfLifeMs?: number },
): RankedEmojiUsage[] {
  const now = options?.now ?? 0;
  const halfLifeMs = options?.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const { order, byEmoji } = normalize(list);
  return order
    .map((emoji) => {
      const entry = byEmoji.get(emoji) as EmojiUsage;
      return { ...entry, score: scoreOf(entry, now, halfLifeMs) };
    })
    .sort(compareRanked);
}

/**
 * The `limit` highest-frecency usages at `now`, in ranked order. `limit`
 * defaults to `DEFAULT_TOP_LIMIT`; a negative/non-finite limit yields `[]` and
 * a fractional limit is floored.
 */
export function topRecent(
  list: readonly EmojiUsage[],
  options: { limit?: number; now: number; halfLifeMs?: number },
): RankedEmojiUsage[] {
  const raw = options?.limit ?? DEFAULT_TOP_LIMIT;
  const limit = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (limit === 0) return [];
  return rankRecent(list, {
    now: options?.now ?? 0,
    halfLifeMs: options?.halfLifeMs,
  }).slice(0, limit);
}

/**
 * Merge two usage lists: shared emoji sum their counts and keep the latest
 * stamp; emoji unique to `b` are appended after `a`'s (both preserving
 * first-seen order). Used to fold a persisted list back into a session list
 * without a clock. Pure — neither input is mutated.
 */
export function mergeUsages(
  a: readonly EmojiUsage[],
  b: readonly EmojiUsage[],
): EmojiUsage[] {
  const { order, byEmoji } = normalize(a);
  for (const entry of Array.isArray(b) ? b : []) {
    if (!entry || !entry.emoji) continue;
    const existing = byEmoji.get(entry.emoji);
    if (existing) {
      existing.count += entry.count;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, entry.lastUsedAt);
    } else {
      byEmoji.set(entry.emoji, {
        emoji: entry.emoji,
        count: entry.count,
        lastUsedAt: entry.lastUsedAt,
      });
      order.push(entry.emoji);
    }
  }
  return order.map((emoji) => ({ ...(byEmoji.get(emoji) as EmojiUsage) }));
}

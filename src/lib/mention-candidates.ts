/**
 * F6 — pure `@`-mention candidate shaping for the picker.
 *
 * The editor already knows how to *parse* a live `@query` (`parseMentionQuery`
 * in `mentions.ts`) and how to scope suggestions to visible pages
 * (`scopeMentionSuggestions`). This module is the next layer down, over plain
 * candidate rows a server call would hand back:
 *
 *  - {@link filterCandidates} — narrow by query, drop the page itself and ids
 *    already mentioned, optionally restrict to one or more kinds, cap.
 *  - {@link rankCandidates} — order what survives: prefix hits first, recent
 *    items before stale ones, the caller's order as a stable tiebreak.
 *  - {@link highlightRanges} — the spans of a title a row renderer underlines.
 *  - {@link splitByKind} — the pages/people sections the menu draws.
 *
 * Everything is plain rows in / plain rows out: no DB, no DOM, deterministic,
 * and the caller's arrays and objects are never mutated. A blank query means
 * "everything" (ranked by recency) rather than "nothing".
 */

/** A candidate is either a page (link) or a person (notification target). */
export type MentionCandidateKind = "page" | "user";

/** One picker row. Extra fields beyond these are ignored. */
export type Candidate = {
  id: string;
  title: string;
  kind: MentionCandidateKind;
  /** Secondary line, e.g. a parent page or the user's handle. Display only. */
  subtitle?: string;
  /** Recency flag; recent rows outrank stale ones on an equal match. */
  recent?: boolean;
};

export type FilterCandidatesOptions = {
  /** Ids to drop — the page itself and any target already mentioned. */
  excludeIds?: Iterable<string>;
  /** Keep only these kinds; omitted or empty means "all kinds". */
  kinds?: readonly MentionCandidateKind[];
  /** Maximum rows to return (default `10`); non-positive means none. */
  limit?: number;
};

/** Rows returned when `limit` is omitted. */
const DEFAULT_LIMIT = 10;

/** A `[start, end)` span into a title, ready for a highlight renderer. */
export type HighlightRange = {
  start: number;
  end: number;
};

/** Normalize a query: trim, lowercase. `null`/`undefined` become `""`. */
function normalizeQuery(query: string): string {
  return (query ?? "").trim().toLowerCase();
}

/**
 * Does `title` match `query`? Case-insensitive substring — a word prefix, a
 * mid-word hit and an exact title all count; a blank `query` matches every
 * title. Ranking (not matching) is what prefers prefixes.
 */
function titleMatches(title: string, query: string): boolean {
  if (query === "") return true;
  return (title ?? "").toLowerCase().includes(query);
}

/**
 * Narrow candidate rows for the picker. A row survives when its title matches
 * the (trimmed, case-insensitive) `query`, its id is not in `excludeIds`, and
 * its kind is allowed by `kinds`. Input order is preserved; the result is
 * capped at `limit` (default `10`, non-positive → `[]`). Neither `candidates`
 * nor the excluded/kind collections are mutated.
 */
export function filterCandidates(
  candidates: readonly Candidate[],
  query: string,
  options: FilterCandidatesOptions = {},
): Candidate[] {
  const q = normalizeQuery(query);
  const excluded = options.excludeIds ? new Set(options.excludeIds) : null;
  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
  const requested = options.limit;
  const limit =
    typeof requested === "number" && Number.isInteger(requested) ? Math.max(0, requested) : DEFAULT_LIMIT;

  const out: Candidate[] = [];
  for (const candidate of candidates) {
    if (out.length >= limit) break;
    if (excluded?.has(candidate.id)) continue;
    if (kinds && !kinds.has(candidate.kind)) continue;
    if (!titleMatches(candidate.title, q)) continue;
    out.push(candidate);
  }
  return out;
}

/**
 * Match tiers, best (highest) first: exact title, title prefix, word prefix,
 * any substring. Used only by {@link rankCandidates}.
 */
const TIER_EXACT = 4;
const TIER_PREFIX = 3;
const TIER_WORD_PREFIX = 2;
const TIER_SUBSTRING = 1;
const TIER_NONE = 0;

/** How well a title matches a normalized query (higher is better). */
function matchTier(title: string, query: string): number {
  if (query === "") return TIER_NONE; // blank → every row ties; recency decides
  const label = (title ?? "").toLowerCase();
  if (label === query) return TIER_EXACT;
  if (label.startsWith(query)) return TIER_PREFIX;
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return TIER_WORD_PREFIX;
  if (label.includes(query)) return TIER_SUBSTRING;
  return TIER_NONE;
}

/**
 * Order candidate rows best-first:
 *  1. match tier — exact > prefix > word prefix > substring (prefix boost);
 *  2. recency — `recent: true` before stale (recency boost);
 *  3. the caller's input order (stable tiebreak).
 *
 * A blank `query` makes every row share the top tier, so the list is ordered by
 * recency then input order — the usual "recently opened" menu. The input array
 * is not mutated; a fresh array is returned.
 */
export function rankCandidates(candidates: readonly Candidate[], query: string): Candidate[] {
  const q = normalizeQuery(query);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      tier: matchTier(candidate.title, q),
      recent: candidate.recent === true ? 1 : 0,
    }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return b.tier - a.tier;
      if (a.recent !== b.recent) return b.recent - a.recent;
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);
}

/**
 * Every non-overlapping `[start, end)` span of `title` matching `query`,
 * case-insensitively, left to right. A blank `query` or no match yields `[]`.
 * Occurrences that would overlap a prior span are skipped, so the spans can be
 * painted directly. `title` is never sliced or modified.
 */
export function highlightRanges(title: string, query: string): HighlightRange[] {
  const needle = normalizeQuery(query);
  if (needle === "") return [];
  const haystack = (title ?? "").toLowerCase();
  const ranges: HighlightRange[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    ranges.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return ranges;
}

/**
 * Group rows into the pages/people sections the menu renders, each preserving
 * the incoming order. Returns two fresh arrays; the row objects are reused and
 * never mutated.
 */
export function splitByKind(candidates: readonly Candidate[]): {
  pages: Candidate[];
  users: Candidate[];
} {
  const pages: Candidate[] = [];
  const users: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "user") users.push(candidate);
    else pages.push(candidate);
  }
  return { pages, users };
}

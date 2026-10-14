/**
 * Fuzzy matcher for the command palette (B43).
 *
 * Subsequence matching (every query char appears in order) with a scoring
 * scheme tuned so the palette's keyboard-nav ordering feels right:
 *
 *  - word-start and string-start hits beat mid-word hits,
 *  - consecutive runs beat scattered hits,
 *  - an exact full-string match outranks a prefix of a longer string,
 *  - case-exact matches get a small nudge above case-insensitive ones.
 *
 * An empty (or whitespace-only) query matches everything with score 0 and no
 * highlighted indices, so callers can render the unfiltered list in its
 * natural order.
 *
 * Also home to the pure, unit-tested search helpers extracted for §11
 * (Search): type-scope filters (`parseTypeScope`/`filterByType`), keyboard
 * navigation indices (`nextIndex`/`prevIndex`/`firstIndex`/`lastIndex`) and
 * preview snippets (`highlightSnippet`).
 */

export type FuzzyMatch = { score: number; indices: number[] };

const SCORE = {
  /** Every matched character. */
  base: 1,
  /** Match landed at index 0 of the text. */
  startOfText: 10,
  /** Match landed right after a space / dash / slash / underscore. */
  wordStart: 6,
  /** Match continues the previous match (run of consecutive chars). */
  consecutive: 7,
  /** Query char and text char agree on case. */
  exactCase: 1,
  /** The whole (lowercased) string equals the query. */
  fullString: 12,
} as const;

const WORD_SEPARATOR = /[\s\-_/.]/;

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const trimmed = query.trim();
  if (trimmed === "") return { score: 0, indices: [] };

  const lowerQuery = trimmed.toLowerCase();
  const lowerText = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let cursor = 0;

  for (const char of lowerQuery) {
    const at = lowerText.indexOf(char, cursor);
    if (at === -1) return null;
    indices.push(at);
    score += SCORE.base;
    if (at === 0) score += SCORE.startOfText;
    else if (WORD_SEPARATOR.test(lowerText[at - 1])) score += SCORE.wordStart;
    const previous = indices[indices.length - 2];
    if (previous !== undefined && at === previous + 1) score += SCORE.consecutive;
    if (text[at] === trimmed[indices.length - 1]) score += SCORE.exactCase;
    cursor = at + 1;
  }

  if (lowerText === lowerQuery) score += SCORE.fullString;
  return { score, indices };
}

export type FuzzyFilterResult<T> = { item: T; score: number; indices: number[] };

/**
 * Filter `items` by `query`, best match first. Equal scores keep their
 * original relative order (stable), and an empty query returns every item
 * untouched (score 0, no indices).
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
): FuzzyFilterResult<T>[] {
  const results: (FuzzyFilterResult<T> & { index: number })[] = [];
  items.forEach((item, index) => {
    const match = fuzzyMatch(query, textOf(item));
    if (match) results.push({ item, score: match.score, indices: match.indices, index });
  });
  // Stable order: explicit index tiebreak so equal scores never flip.
  results.sort((a, b) => b.score - a.score || a.index - b.index);
  return results.map(({ item, score, indices }) => ({ item, score, indices }));
}

/* ------------------------------------------------------------------ *
 * Type-scope filters (§11: Search filters / Search by type).
 * ------------------------------------------------------------------ */

/** Item types a search can be narrowed to. */
export const SEARCH_TYPES = ["page", "database", "ticket", "comment"] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

export type TypeScope = {
  /** The scope parsed from the query, or `null` when there is no usable one. */
  type: SearchType | null;
  /** The query with the `type:` token removed (untouched when there is no scope). */
  query: string;
};

function isSearchType(value: string): value is SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(value);
}

/** Match a scope value to a `SearchType`, tolerating plurals ("Pages" → "page"). */
function normalizeSearchType(value: string): SearchType | null {
  const candidate = value.trim().toLowerCase();
  if (isSearchType(candidate)) return candidate;
  const singular = candidate.endsWith("s") ? candidate.slice(0, -1) : candidate;
  return isSearchType(singular) ? singular : null;
}

const TYPE_SCOPE_PATTERN = /^\s*type\s*:\s*(\S+)/i;

/**
 * Split a leading `type:<value>` token off a search query so results can be
 * narrowed by item type (`type:page roadmap`, `type:databases`).
 *
 * The value is normalised to a `SearchType`. A query without a usable scope
 * is returned untouched (`type: null`) so it still runs as plain text instead
 * of being swallowed by an unrecognised token.
 */
export function parseTypeScope(query: string): TypeScope {
  const match = TYPE_SCOPE_PATTERN.exec(query);
  if (!match) return { type: null, query };
  const type = normalizeSearchType(match[1]);
  if (!type) return { type: null, query };
  const rest = query.slice(0, match.index) + query.slice(match.index + match[0].length);
  return { type, query: rest };
}

/**
 * Keep only `items` whose type equals `type` (§11 Search by type).
 *
 * Pure and order-preserving: `items` is never mutated and scores are not
 * involved, so it composes in front of ranking —
 * `fuzzyFilter(filterByType(items, "database", typeOf), query, textOf)`.
 */
export function filterByType<T>(
  items: readonly T[],
  type: string,
  typeOf: (item: T) => string,
): T[] {
  const wanted = type.trim().toLowerCase();
  return items.filter((item) => typeOf(item).trim().toLowerCase() === wanted);
}

/* ------------------------------------------------------------------ *
 * Keyboard navigation (§11: Search keyboard nav).
 * ------------------------------------------------------------------ */

export type NavOptions = {
  /** Wrap around at the ends of the list (default `true`). */
  wrap?: boolean;
};

/** Pin `index` into `[0, count - 1]`; an empty list always resolves to 0. */
function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Index for ArrowDown: one row down, wrapping to the first result at the
 * end (pass `{ wrap: false }` to clamp instead). An out-of-range cursor is
 * pinned into the list before stepping, and an empty list returns 0.
 */
export function nextIndex(count: number, current: number, options: NavOptions = {}): number {
  if (count <= 0) return 0;
  const index = clampIndex(current, count);
  if (index + 1 < count) return index + 1;
  return options.wrap === false ? index : 0;
}

/** Index for ArrowUp: one row up, wrapping to the last result at the top. */
export function prevIndex(count: number, current: number, options: NavOptions = {}): number {
  if (count <= 0) return 0;
  const index = clampIndex(current, count);
  if (index > 0) return index - 1;
  return options.wrap === false ? index : count - 1;
}

/** Index for Home: the first result (0 when the list is empty). */
export function firstIndex(count: number): number {
  return clampIndex(0, count);
}

/** Index for End: the last result (0 when the list is empty). */
export function lastIndex(count: number): number {
  return clampIndex(count - 1, count);
}

/* ------------------------------------------------------------------ *
 * Preview snippets (§11: Search preview snippets).
 * ------------------------------------------------------------------ */

export type Snippet = {
  /** The excerpt: matched region plus `radius` chars of context each side. */
  text: string;
  /** Offset of the excerpt's first character within the original text. */
  start: number;
  /** Match start/end within `text` (end exclusive), ready for highlighting. */
  matchStart: number;
  matchEnd: number;
  /** Offset of every matched character within `text`. */
  indices: number[];
};

/**
 * Build the preview snippet for a search hit: the fuzzy match surrounded by
 * `radius` characters of context, clamped to the text bounds.
 *
 * All offsets are relative to the returned excerpt, so callers can highlight
 * the match without re-running the matcher. Returns `null` when the query is
 * empty or does not match — there is no region to highlight.
 */
export function highlightSnippet(text: string, query: string, radius: number): Snippet | null {
  const match = fuzzyMatch(query, text);
  if (!match || match.indices.length === 0) return null;

  const context = Number.isFinite(radius) ? Math.max(0, Math.trunc(radius)) : 0;
  const matchStart = match.indices[0];
  const matchEnd = match.indices[match.indices.length - 1] + 1;
  const start = Math.max(0, matchStart - context);
  const end = Math.min(text.length, matchEnd + context);

  return {
    text: text.slice(start, end),
    start,
    matchStart: matchStart - start,
    matchEnd: matchEnd - start,
    indices: match.indices.map((index) => index - start),
  };
}

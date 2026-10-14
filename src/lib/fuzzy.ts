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

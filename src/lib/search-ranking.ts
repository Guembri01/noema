/**
 * Full-text search ranking (docs top gap #8).
 *
 * A dependency-free, BM25-style scorer that complements the Postgres FTS path
 * (`Page.searchText` mirror + GIN/`tsvector` + `ts_rank`): the SQL engine ranks
 * rows it can see, while this gives callers a pure, unit-testable way to rank
 * a small in-memory set of docs (command palette, AI grounding, fixtures).
 *
 * ## Scoring formula
 *
 * For a document `D` and a query `Q`, with `T` the folded query terms:
 *
 *   score(D, Q) = recencyBonus(D)
 *               + Σ_{t ∈ T} [ titleWeight · BM25(t, D.title)
 *                            +              BM25(t, D.body) ]
 *
 * where the per-field BM25 term is the classic Robertson–Spärck Jones form:
 *
 *   BM25(t, f) = IDF(t) · (tf · (k1 + 1))
 *                        / (tf + k1 · (1 − b + b · len(f) / avgLen(f)))
 *
 *   IDF(t)     = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
 *   tf         = occurrences of `t` in the field
 *   df(t)      = number of docs whose field contains `t`
 *   len(f)     = field length (token count)
 *   avgLen(f)  = mean field length over the corpus
 *   N          = corpus size
 *   k1 = 1.2 (term-frequency saturation), b = 0.75 (length normalisation)
 *
 * `titleWeight` (default `1`) scales the title contribution, so a title hit
 * outranks an equally frequent body hit when raised. `recencyBonus` is
 * `recencyBoost · freshness`, where `freshness ∈ [0, 1]` is the document's
 * position between the oldest and newest `updatedAt` in the corpus; docs
 * without a timestamp get `0`. A `recencyBoost` of `0` (the default) disables
 * the term entirely.
 *
 * Missing query terms contribute nothing (their `tf` is `0`) and never divide
 * by zero: the denominator is `≥ tf > 0` for any matched term, and `avgLen` of
 * an empty corpus is guarded. Results are sorted by score descending, then
 * `updatedAt` descending, then `id` ascending (code-unit order) so ranking is
 * fully deterministic across runs.
 */

/** English function words dropped before indexing so they cannot dominate. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "what", "that", "this", "these", "those",
  "from", "your", "you", "our", "their", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "how", "why", "when", "who", "whom", "which",
  "into", "about", "only", "just", "then", "than", "there", "here", "does",
  "did", "can", "could", "should", "would", "will", "shall", "may", "might",
  "must", "not", "but", "its", "it", "they", "them", "we", "us", "of", "to",
  "in", "on", "at", "by", "as", "or", "an", "a", "i", "me", "my", "he", "she",
  "him", "her", "his", "do", "so", "no", "if", "up", "all", "any",
  "some", "one", "two", "also", "more", "most", "very",
]);

/** Runs of unicode letters/digits; everything else is a separator. */
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * Reduce an English token to a light stem by folding simple plurals:
 * `roadmaps → roadmap`, `policies → policy`, `boxes → box`,
 * `classes → class`, `dishes → dish`. Words of three characters or fewer and
 * sibilant endings that are not plurals (`focus`, `analysis`, `status`) are
 * left alone. This is deliberately conservative, not a full Porter stemmer.
 */
function fold(token: string): string {
  if (token.length <= 3) return token;
  if (/(?:x|ch|sh|ss|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Normalise text into indexable terms: lowercase, split on non-alphanumerics,
 * fold simple plurals, and drop stopwords and single-character tokens.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().match(WORD_PATTERN) ?? []) {
    const folded = fold(raw);
    if (folded.length < 2 || STOPWORDS.has(folded)) continue;
    tokens.push(folded);
  }
  return tokens;
}

/** Term frequencies for one field. */
function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  return frequency;
}

/** A document supplied to {@link buildIndex}. */
export type SearchDoc = {
  /** Stable identifier; used as the final sort tiebreak and returned in results. */
  id: string;
  fields: {
    title: string;
    body: string;
  };
  /** Optional epoch-ms timestamp feeding the `recencyBoost` term. */
  updatedAt?: number;
};

/** A document inside a built index, with its per-field frequencies. */
export type IndexedDoc = {
  id: string;
  updatedAt?: number;
  titleLength: number;
  bodyLength: number;
  titleFreq: ReadonlyMap<string, number>;
  bodyFreq: ReadonlyMap<string, number>;
};

/** Immutable BM25 statistics for a corpus, produced by {@link buildIndex}. */
export type SearchIndex = {
  readonly docs: readonly IndexedDoc[];
  readonly docCount: number;
  readonly avgTitleLength: number;
  readonly avgBodyLength: number;
  /** Per-term number of docs whose title contains the term. */
  readonly titleDocFreq: ReadonlyMap<string, number>;
  /** Per-term number of docs whose body contains the term. */
  readonly bodyDocFreq: ReadonlyMap<string, number>;
};

/** Index a corpus of documents for {@link rank}. Pure; inputs are not mutated. */
export function buildIndex(docs: readonly SearchDoc[]): SearchIndex {
  const indexed: IndexedDoc[] = [];
  const titleDocFreq = new Map<string, number>();
  const bodyDocFreq = new Map<string, number>();
  let titleTotal = 0;
  let bodyTotal = 0;

  for (const doc of docs) {
    const titleTokens = tokenize(doc.fields?.title ?? "");
    const bodyTokens = tokenize(doc.fields?.body ?? "");
    const titleFreq = termFrequencies(titleTokens);
    const bodyFreq = termFrequencies(bodyTokens);
    for (const term of titleFreq.keys()) titleDocFreq.set(term, (titleDocFreq.get(term) ?? 0) + 1);
    for (const term of bodyFreq.keys()) bodyDocFreq.set(term, (bodyDocFreq.get(term) ?? 0) + 1);
    titleTotal += titleTokens.length;
    bodyTotal += bodyTokens.length;
    indexed.push({
      id: doc.id,
      updatedAt: doc.updatedAt,
      titleLength: titleTokens.length,
      bodyLength: bodyTokens.length,
      titleFreq,
      bodyFreq,
    });
  }

  const docCount = indexed.length;
  return {
    docs: indexed,
    docCount,
    avgTitleLength: docCount > 0 ? titleTotal / docCount : 0,
    avgBodyLength: docCount > 0 ? bodyTotal / docCount : 0,
    titleDocFreq,
    bodyDocFreq,
  };
}

/** Query-time scoring knobs. Every option has a safe default. */
export type RankOptions = {
  /** Multiplier on the title BM25 term (default `1`). `0` ignores titles. */
  titleWeight?: number;
  /** Additive recency bonus scaled by freshness in `[0, 1]` (default `0`). */
  recencyBoost?: number;
  /** Maximum results to return (default `10`); non-positive/non-finite means all. */
  limit?: number;
};

/** One ranked document. */
export type RankedResult = {
  id: string;
  score: number;
  /** Folded query terms found in the title or body, for highlighting. */
  matched: string[];
};

/** BM25 term-frequency saturation. */
const K1 = 1.2;
/** BM25 length-normalisation strength. */
const B = 0.75;
/** Results returned when `limit` is omitted. */
const DEFAULT_LIMIT = 10;

/** Return `value` when it is a finite number, otherwise `fallback`. */
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * BM25 score for one term in one field. Returns `0` when the term is absent,
 * so missing terms cost nothing and the denominator stays strictly positive.
 */
function bm25(tf: number, df: number, length: number, avgLength: number, docCount: number): number {
  if (tf <= 0) return 0;
  const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
  const norm = avgLength > 0 ? length / avgLength : 1;
  const denominator = tf + K1 * (1 - B + B * norm);
  return (idf * tf * (K1 + 1)) / denominator;
}

/**
 * Rank the docs in `index` against `query`, best first.
 *
 * An empty query (or one made only of stopwords) matches nothing, and docs
 * sharing no term with the query are omitted. See the module header for the
 * full scoring formula.
 */
export function rank(index: SearchIndex, query: string, options: RankOptions = {}): RankedResult[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || index.docCount === 0) return [];

  const titleWeight = finiteOr(options.titleWeight, 1);
  const recencyBoost = finiteOr(options.recencyBoost, 0);

  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  for (const doc of index.docs) {
    if (typeof doc.updatedAt === "number" && Number.isFinite(doc.updatedAt)) {
      if (doc.updatedAt < oldest) oldest = doc.updatedAt;
      if (doc.updatedAt > newest) newest = doc.updatedAt;
    }
  }
  const hasTimestamps = Number.isFinite(oldest) && Number.isFinite(newest);

  const scored: (RankedResult & { updatedAt: number })[] = [];
  for (const doc of index.docs) {
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const tfTitle = doc.titleFreq.get(term) ?? 0;
      const tfBody = doc.bodyFreq.get(term) ?? 0;
      if (tfTitle === 0 && tfBody === 0) continue;
      matched.push(term);
      score +=
        titleWeight *
        bm25(tfTitle, index.titleDocFreq.get(term) ?? 0, doc.titleLength, index.avgTitleLength, index.docCount);
      score += bm25(tfBody, index.bodyDocFreq.get(term) ?? 0, doc.bodyLength, index.avgBodyLength, index.docCount);
    }
    if (matched.length === 0) continue;

    const updatedAt = typeof doc.updatedAt === "number" && Number.isFinite(doc.updatedAt)
      ? doc.updatedAt
      : Number.NEGATIVE_INFINITY;
    if (recencyBoost !== 0 && hasTimestamps && Number.isFinite(updatedAt)) {
      const freshness = newest > oldest ? (updatedAt - oldest) / (newest - oldest) : 1;
      score += recencyBoost * freshness;
    }
    scored.push({ id: doc.id, score, matched, updatedAt });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const limit = finiteOr(options.limit, DEFAULT_LIMIT);
  const capped = limit > 0 ? scored.slice(0, Math.trunc(limit)) : scored;
  return capped.map(({ id, score, matched }) => ({ id, score, matched }));
}

/**
 * The shape {@link refineByRelevance} reads by default: a stable `id`, the
 * `title` to weight, and the `body` (snippet/description) to match against.
 */
export type RelevanceRow = {
  id: string;
  title: string;
  body: string;
};

/** Query-time knobs for {@link refineByRelevance}. */
export type RefineByRelevanceOptions<T> = {
  /** Multiplier on the title BM25 term (default `1`, via {@link rank}). */
  titleWeight?: number;
  /** Override how a row's stable id is read (default `row.id`). */
  getId?: (row: T) => string;
  /** Override how a row's title text is read (default `row.title`). */
  getTitle?: (row: T) => string;
  /** Override how a row's body/snippet text is read (default `row.body`). */
  getBody?: (row: T) => string;
};

/** Read a string field from a row without assuming its concrete type. */
function readTextField(row: unknown, key: string): string {
  if (typeof row !== "object" || row === null) return "";
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * Re-order already-filtered rows by the shared BM25 scorer ({@link rank}),
 * weighting title matches, so a title hit surfaces above an equally frequent
 * body hit. This is the pure core shared by the search page, the v1 search
 * API, `search-results.tsx`, and `quick-find.tsx`.
 *
 * The pass is **lossless**: every row is returned and the input is never
 * mutated. Rows the scorer recognises are ordered best-first; rows it does
 * not (prefix/substring-fallback hits, or an empty/stopword query) keep their
 * incoming relative order and follow the scored rows, so result counts and any
 * surrounding pagination are unchanged. Ties among scored rows also keep the
 * incoming order via a stable sort on the ranked positions.
 *
 * Rows are read through `row.id` / `row.title` / `row.body` by default; pass
 * the `getId` / `getTitle` / `getBody` accessors for a different shape (for
 * example `snippet` in place of `body`).
 */
export function refineByRelevance<T = RelevanceRow>(
  rows: readonly T[],
  query: string,
  options: RefineByRelevanceOptions<T> = {},
): T[] {
  const ordered = [...rows];
  if (ordered.length <= 1) return ordered;

  const getId = options.getId ?? ((row: T) => readTextField(row, "id"));
  const getTitle = options.getTitle ?? ((row: T) => readTextField(row, "title"));
  const getBody = options.getBody ?? ((row: T) => readTextField(row, "body"));

  const index = buildIndex(
    ordered.map((row) => ({
      id: getId(row),
      fields: { title: getTitle(row), body: getBody(row) },
    })),
  );
  const ranked = rank(index, query, { titleWeight: options.titleWeight, limit: ordered.length });
  if (ranked.length === 0) return ordered;

  const position = new Map(ranked.map((result, i) => [result.id, i]));
  ordered.sort((a, b) => {
    const left = position.get(getId(a));
    const right = position.get(getId(b));
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
  return ordered;
}

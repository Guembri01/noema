/**
 * Postgres full-text search query builder (docs top gap #8, spec §11
 * "Full-text search at Postgres level").
 *
 * The FTS path in `queries.ts` ranks pages with `ts_rank`/`ts_rank_cd` and
 * renders `ts_headline` snippets, but the tsquery/ranking logic is entangled
 * with the Prisma call and therefore untestable in isolation. This module is
 * the **pure** core of that path: it turns arbitrary user input into a safe
 * `to_tsquery` expression, composes a deterministic ranked/`ts_headline` SQL
 * string with bound parameters, and adds the `pg_trgm` typo tier, headline
 * parsing, plan selection and prefix/exact merging as pure helpers.
 *
 * Nothing here performs I/O or touches an existing module: it is additive so it
 * can be adopted by `queries.ts` without changing the current query shape
 * (see `src/lib/search.ts` for the existing query vocabulary).
 *
 * ## Safety
 *
 * `toTsQuery` works on unicode word runs only (`\p{L}\p{N}_`), so tsquery
 * operators (`& | ! <-> ( ) : *`), quotes and any SQL punctuation are stripped
 * before a value is ever bound. Every SQL placeholder is numbered `$n` and
 * every user-derived value is passed in `params` — no string interpolation.
 */

/** A SQL fragment plus the ordered parameter values for its placeholders. */
export type SqlFragment = {
  /** SQL text with `$1`…`$n` placeholders; empty when there is nothing to run. */
  text: string;
  /** Values for `$1`…`$n`, in placeholder order. */
  params: unknown[];
};

/** A single unicode word character (letters, digits, underscore). */
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** Whole word runs used to split queries and phrases into lexemes. */
const WORD_RUN = /[\p{L}\p{N}_]+/gu;
/** Hard cap on query terms so a huge paste cannot build a giant tsquery. */
const MAX_TERMS = 16;
/** Bound the raw input length before parsing (cheap denial-of-service guard). */
const MAX_INPUT = 4096;

/**
 * Group a raw query into terms: quoted spans become multi-word phrases,
 * everything else is a run of word characters. Non-word characters (including
 * every tsquery operator) are separators and are dropped.
 */
function queryGroups(input: string): string[][] {
  const source = (input ?? "").slice(0, MAX_INPUT);
  const groups: string[][] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '"') {
      const close = source.indexOf('"', i + 1);
      const inner = close === -1 ? source.slice(i + 1) : source.slice(i + 1, close);
      const words = inner.toLowerCase().match(WORD_RUN) ?? [];
      if (words.length > 0) groups.push(words);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    if (WORD_CHAR.test(char)) {
      let end = i + 1;
      while (end < source.length && WORD_CHAR.test(source[end])) end += 1;
      groups.push([source.slice(i, end).toLowerCase()]);
      i = end;
      continue;
    }
    i += 1;
  }
  return groups;
}

/**
 * Sanitise arbitrary user input into a `to_tsquery`-compatible expression.
 *
 * Word runs are lowercased and joined with `&`; a quoted span becomes a
 * `<->` (followed-by) phrase; the final word gets the `:*` prefix operator so
 * type-ahead ("road" → "roadmap") works. All tsquery syntax in the input is
 * stripped, so the result is always a well-formed `lexeme (& lexeme)*` string
 * and never contains a quote. An empty or punctuation-only input yields `""`.
 */
export function toTsQuery(input: string): string {
  const groups = queryGroups(input).slice(0, MAX_TERMS);
  if (groups.length === 0) return "";
  const expressions = groups.map((words, groupIndex) =>
    words
      .map((word, wordIndex) => {
        const isLast = groupIndex === groups.length - 1 && wordIndex === words.length - 1;
        return isLast ? `${word}:*` : word;
      })
      .join(" <-> "),
  );
  return expressions.join(" & ");
}

/** The `tsvector`/`tsvector` pair that both the match and the rank share. */
const TSVECTOR = `to_tsvector('english', coalesce(p."searchText", p."title"))`;
/** The `$1`-bound tsquery call, repeated wherever Postgres needs it. */
const TSQUERY_CALL = `to_tsquery('english', $1)`;
/** Cover-density rank expression, aliased to `"rank"` in the SELECT list. */
const RANK = `ts_rank_cd(${TSVECTOR}, ${TSQUERY_CALL})`;
/** The `ts_headline` markers React renders as `<b>` (never as raw HTML). */
const HEADLINE_OPTIONS = `'StartSel=<b>, StopSel=</b>, MaxWords=18, MinWords=6, ShortWord=3'`;

/** Default result window when `limit` is omitted. */
const DEFAULT_LIMIT = 50;
/** Upper bound on the window so one caller cannot ask for an unbounded scan. */
const MAX_LIMIT = 200;

/** A page scope: the workspace plus an optional guest-visible id allow-list. */
export type SearchScope = {
  /** Workspace the search is bound to (isolation boundary). */
  workspaceId: string;
  /**
   * `null`/omitted for members (no id predicate); an array for guests, where an
   * empty array deliberately matches nothing.
   */
  visiblePageIds?: readonly string[] | null;
};

/** Keyset cursor holding the last row of the previous page. */
export type SearchCursor = {
  /** `ts_rank_cd` value of the last row. */
  rank: number;
  /** `updatedAt` of the last row. */
  updatedAt: string | number | Date;
  /** `id` of the last row (final tie-break). */
  id: string;
};

/** Input for {@link buildSearchSql}. */
export type BuildSearchSqlOptions = {
  /** Raw, untrusted user query. */
  query: string;
  /** Workspace + optional guest-visible page ids. */
  scope: SearchScope;
  /** Maximum rows to return (default `50`, clamped to `200`). */
  limit?: number;
  /** Continue after this row (keyset pagination). */
  cursor?: SearchCursor;
};

/** Coerce a caller-supplied limit into `[1, MAX_LIMIT]`, defaulting when absent. */
function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit), MAX_LIMIT);
}

/**
 * Compose the ranked full-text query: `to_tsvector(…) @@ to_tsquery(…)` with
 * `ts_rank_cd` ordering (tie-broken by `updatedAt` desc, `id` asc) and a
 * `ts_headline` snippet marked with `<b>`/`</b>`.
 *
 * Returns `{ text: "", params: [] }` for a blank query. The SQL text is a pure
 * function of its options, so identical input yields byte-identical output and
 * every user-derived value travels in `params`, never in `text`.
 */
export function buildSearchSql(options: BuildSearchSqlOptions): SqlFragment {
  const tsquery = toTsQuery(options.query ?? "");
  if (!tsquery) return { text: "", params: [] };

  const scope = options.scope;
  const params: unknown[] = [tsquery, scope.workspaceId];
  const where: string[] = [
    `WHERE p."workspaceId" = $2`,
    `  AND p."deletedAt" IS NULL`,
    `  AND ${TSVECTOR} @@ ${TSQUERY_CALL}`,
  ];

  if (scope.visiblePageIds != null) {
    params.push([...scope.visiblePageIds]);
    where.push(`  AND p."id" = ANY($${params.length})`);
  }

  if (options.cursor) {
    params.push(options.cursor.rank, options.cursor.updatedAt, options.cursor.id);
    const last = params.length;
    where.push(
      `  AND (${RANK}, p."updatedAt", p."id") < ($${last - 2}, $${last - 1}, $${last})`,
    );
  }

  params.push(normalizeLimit(options.limit));
  const limitIndex = params.length;

  const text = [
    `SELECT p."id",`,
    `       ts_headline('english', coalesce(p."searchText", p."title"), ${TSQUERY_CALL},`,
    `         ${HEADLINE_OPTIONS}) AS "snippet",`,
    `       ${RANK} AS "rank"`,
    `FROM "Page" p`,
    ...where,
    `ORDER BY "rank" DESC, p."updatedAt" DESC, p."id" ASC`,
    `LIMIT $${limitIndex}`,
  ].join("\n");

  return { text, params };
}

/**
 * Similarity threshold for the typo tier.
 *
 * The tier used to be `pg_trgm`'s `similarity(…) >= 0.3` in SQL. It is now
 * computed in TypeScript (see {@link trigramSimilarity}) for one decisive reason:
 * `pg_trgm` is an extension, and the desktop build runs on an embedded Postgres
 * (PGlite) that does not ship it — a search feature must not decide whether the
 * installer can work with nothing installed.
 */
export const TRIGRAM_THRESHOLD = 0.3;

/**
 * How many pages the typo tier will look at.
 *
 * The tier only runs when the full-text passes found nothing (a typo, a term that
 * does not appear, or a page whose mirror predates the index), so a bounded scan
 * of the workspace's most recently updated pages is a fair trade for dropping an
 * extension dependency. Raise it for very large workspaces; the exact and prefix
 * passes are unaffected.
 */
export const TRIGRAM_CANDIDATE_LIMIT = 400;

/** Character trigrams of a string, in pg_trgm's padded-word style. */
function trigrams(value: string): Set<string> {
  const words = (value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const set = new Set<string>();
  for (const word of words) {
    // pg_trgm pads each word with two leading and one trailing space, so word
    // boundaries produce their own trigrams ("  cat ", " cat", "cat ").
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) set.add(padded.slice(i, i + 3));
  }
  return set;
}

/**
 * Sørensen–Dice similarity over character trigrams — the same metric and the same
 * `0…1` range `pg_trgm`'s `similarity()` reports, computed locally.
 *
 * Pure and deterministic: identical strings are `1`, strings with no shared
 * trigram are `0`, and a single-character typo in a word of any length stays well
 * above {@link TRIGRAM_THRESHOLD}.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) {
    // Nothing to compare trigram-wise; fall back to exact (case-insensitive) match.
    return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase() ? 1 : 0;
  }
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** A page the typo tier may score. */
export type TrigramCandidate = {
  id: string;
  /** Title + plain-text mirror, exactly what the SQL tier compared. */
  text: string;
  updatedAt?: string | number | Date;
};

/**
 * Rank candidates by trigram similarity, dropping those below the threshold.
 * Returns the same {@link RankedInput} shape the other tiers produce, so the
 * caller merges them identically.
 */
export function scoreTrigramCandidates(
  input: string,
  candidates: readonly TrigramCandidate[],
  options: { threshold?: number; limit?: number } = {},
): RankedInput[] {
  const query = (input ?? "").trim();
  if (!query) return [];
  const threshold =
    typeof options.threshold === "number" && Number.isFinite(options.threshold)
      ? options.threshold
      : TRIGRAM_THRESHOLD;
  const scored: RankedInput[] = [];
  for (const candidate of candidates) {
    const rank = trigramSimilarity(query, candidate.text);
    if (rank >= threshold) {
      scored.push({ id: candidate.id, rank, updatedAt: candidate.updatedAt });
    }
  }
  const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : undefined;
  return limit ? scored.slice(0, limit) : scored;
}

/** A `ts_headline` snippet split into plain text and its matched terms. */
export type ParsedHeadline = {
  /** Snippet text with the `<b>`/`</b>` markers removed. */
  text: string;
  /** Matched substrings, in document order; empty spans are dropped. */
  matches: string[];
};

/**
 * Split `ts_headline` output into `{ text, matches }` without interpreting any
 * HTML. Only a balanced `<b>…</b>` pair is treated as a marker; an unmatched
 * opening marker is left as literal text exactly as Postgres returned it, so a
 * page that literally contains `<b>` cannot lose characters.
 */
export function parseHeadline(marked: string): ParsedHeadline {
  const input = marked ?? "";
  const matches: string[] = [];
  let text = "";
  let i = 0;
  while (i < input.length) {
    const open = input.indexOf("<b>", i);
    if (open === -1) {
      text += input.slice(i);
      break;
    }
    const close = input.indexOf("</b>", open + 3);
    if (close === -1) {
      text += input.slice(i);
      break;
    }
    text += input.slice(i, open);
    const inner = input.slice(open + 3, close);
    if (inner) matches.push(inner);
    text += inner;
    i = close + 4;
  }
  return { text, matches };
}

/** A ranked SQL row as returned by {@link buildSearchSql}. */
export type SearchRow = {
  id: string;
  snippet: string;
  rank: number;
};

/** A row with a normalised score and its parsed headline attached. */
export type HighlightedRow = SearchRow & {
  /** `rank / maxRank` in `[0, 1]`; `0` when no row has a positive rank. */
  score: number;
  headline: ParsedHeadline;
};

/** Fold a rank to a non-negative finite number (`0` for missing/invalid). */
function finiteRank(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Normalise the rank column of SQL rows and parse their snippets, best first.
 * Each row gets `score = rank / maxRank` (so the top row is `1`), a parsed
 * `headline`, and is sorted by rank desc then `id` asc for determinism. Pure:
 * the input rows are never mutated.
 */
export function highlightRanks(rows: readonly SearchRow[]): HighlightedRow[] {
  const ranked = rows.map((row) => ({ row, rank: finiteRank(row.rank) }));
  let max = 0;
  for (const entry of ranked) if (entry.rank > max) max = entry.rank;
  ranked.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });
  return ranked.map(({ row, rank }) => ({
    id: row.id,
    snippet: row.snippet,
    rank: row.rank,
    score: max > 0 ? rank / max : 0,
    headline: parseHeadline(row.snippet),
  }));
}

/** Which engine {@link planSearch} should use. */
export type SearchStrategy = "fts" | "ilike" | "none";

/** The chosen strategy plus why it was chosen and whether to prefix. */
export type SearchPlan = {
  strategy: SearchStrategy;
  /** Whether the type-ahead prefix pass is worthwhile for this strategy. */
  prefix: boolean;
  /** Stable machine-readable rationale (handy for logs/tests). */
  reason: string;
};

/** Largest estimated table size that still favours an un-indexed `ILIKE` scan. */
export const ILIKE_MAX_ROWS = 5_000;

/** Input for {@link planSearch}. */
export type PlanSearchInput = {
  /** Raw user query. */
  query: string;
  /** Whether the `to_tsvector(…)` GIN index is present. */
  hasIndex: boolean;
  /** Planner's estimated row count for the target table. */
  estimatedRows: number;
};

/**
 * Choose between the full-text and `ILIKE` engines.
 *
 * A blank query plans `none`. When the GIN index exists, FTS (with the prefix
 * pass) is always cheapest. Without an index, a **bounded** `ILIKE` scan is the
 * only option — there is no longer a SQL trigram tier to prefer for large tables,
 * because the typo tier now scores candidates in TypeScript (see
 * {@link scoreTrigramCandidates}) so the app does not depend on the `pg_trgm`
 * extension. Missing, negative or non-finite estimates are treated as `0`.
 */
export function planSearch(input: PlanSearchInput): SearchPlan {
  const query = (input?.query ?? "").trim();
  if (!query) return { strategy: "none", prefix: false, reason: "empty-query" };
  if (input.hasIndex) return { strategy: "fts", prefix: true, reason: "gin-index-available" };
  const rows =
    typeof input.estimatedRows === "number" &&
    Number.isFinite(input.estimatedRows) &&
    input.estimatedRows > 0
      ? input.estimatedRows
      : 0;
  if (rows <= ILIKE_MAX_ROWS) {
    return { strategy: "ilike", prefix: true, reason: "small-unindexed-table" };
  }
  return { strategy: "ilike", prefix: true, reason: "large-unindexed-table" };
}

/** A hit fed to {@link mergeRanked}: a stable id, a rank and an optional time. */
export type RankedInput = {
  id: string;
  rank: number;
  updatedAt?: string | number | Date;
};

/** A merged hit with its blended score and which pass produced it. */
export type MergedHit = {
  id: string;
  score: number;
  source: "exact" | "prefix";
};

/** Default discount applied to prefix-only hits when blending (spec Dec5). */
export const PREFIX_DISCOUNT = 0.5;

/** Read an optional timestamp as epoch-ms; missing/invalid sorts last. */
function toTimestamp(value: string | number | Date | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Blend an exact-hit list with a prefix-only list so typing "road" does not
 * drown an exact "roadmap" hit (spec R78.8 / Dec5).
 *
 * Prefix-only hits are scored at `rank · discount` (default `0.5`); an id that
 * appears in both lists appears once, keeping the exact hit. The merged list is
 * ordered by score desc, `updatedAt` desc, `id` asc for a fully deterministic
 * result. Pure: neither input array is mutated.
 */
export function mergeRanked(
  exact: readonly RankedInput[],
  prefix: readonly RankedInput[],
  options: { discount?: number } = {},
): MergedHit[] {
  const discount =
    typeof options.discount === "number" && Number.isFinite(options.discount)
      ? options.discount
      : PREFIX_DISCOUNT;

  const seen = new Set<string>();
  const entries: { hit: MergedHit; updatedAt: number }[] = [];
  const collect = (rows: readonly RankedInput[], source: "exact" | "prefix") => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const rank = typeof row.rank === "number" && Number.isFinite(row.rank) ? row.rank : 0;
      entries.push({
        hit: { id: row.id, score: source === "exact" ? rank : rank * discount, source },
        updatedAt: toTimestamp(row.updatedAt),
      });
    }
  };
  collect(exact, "exact");
  collect(prefix, "prefix");

  entries.sort((a, b) => {
    if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0;
  });
  return entries.map((entry) => entry.hit);
}

/**
 * Workspace search and AI prompt retrieval.
 *
 * Extracted from src/server/queries.ts: the search tier selection, FTS/typo/
 * substring passes, hit projection and paging are one seam. Callers keep
 * importing them from @/server/queries through the re-export barrel.
 */
import { prisma } from "@/lib/db";
import { makeSnippet } from "@/lib/search";
import { prosemirrorToText } from "@/lib/blocks";
import { promptTerms, scorePage, snippetAround } from "@/lib/retrieval";
import { paginateSlice, type PaginateResult } from "@/lib/cursor-pagination";
import type { SummaryBlock } from "@/lib/page-summary";
import {
  buildSearchSql,
  mergeRanked,
  parseHeadline,
  planSearch,
  scoreTrigramCandidates,
  TRIGRAM_CANDIDATE_LIMIT,
  type RankedInput,
  type SqlFragment,
} from "@/lib/fts";

/** Fields every search hit carries (the select shape all callers share). */
type SearchHitBase = {
  id: string;
  title: string;
  icon: string | null;
  type: "PAGE" | "DATABASE";
  updatedAt: Date;
};

/**
 * Map one stored ProseMirror node onto the summariser's minimal block shape,
 * renaming the doc's `content` key to `children` at every level so
 * `summarizeBlocks` can walk real page content without the editor. Pure and
 * total: junk, arrays and primitives yield `null`.
 */
function toSummaryNode(node: unknown): SummaryBlock | null {
  if (!node || typeof node !== "object") return null;
  const source = node as { type?: unknown; text?: unknown; content?: unknown };
  const block: SummaryBlock = {};
  if (typeof source.type === "string") block.type = source.type;
  if (typeof source.text === "string") block.text = source.text;
  if (Array.isArray(source.content)) {
    const children: SummaryBlock[] = [];
    for (const child of source.content) {
      const mapped = toSummaryNode(child);
      if (mapped) children.push(mapped);
    }
    if (children.length > 0) block.children = children;
  }
  return block;
}

/**
 * A stored document's top-level content as summary blocks (empty for junk or a
 * doc that is not `{ content: [...] }`), ready for the client teaser renderer.
 */
function toSummaryBlocks(doc: unknown): SummaryBlock[] {
  const root = doc as { content?: unknown } | null;
  if (!root || !Array.isArray(root.content)) return [];
  const blocks: SummaryBlock[] = [];
  for (const node of root.content) {
    const block = toSummaryNode(node);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Project a selected page row onto the search-hit shape. `snippet` is always
 * present; `blocks` (the preferred teaser source) is attached only when the
 * caller opted in, so other callers' return shapes stay unchanged.
 */
function toSearchHit(
  page: SearchHitBase & { content?: unknown },
  snippet: string,
  includeBlocks: boolean,
): SearchHitBase & { snippet: string; blocks?: SummaryBlock[] } {
  const hit: SearchHitBase & { snippet: string; blocks?: SummaryBlock[] } = {
    id: page.id,
    title: page.title,
    icon: page.icon,
    type: page.type,
    updatedAt: page.updatedAt,
    snippet,
  };
  if (includeBlocks) hit.blocks = toSummaryBlocks(page.content);
  return hit;
}

// ---------------------------------------------------------------------------
// Search engine — the pure Postgres FTS builder (`src/lib/fts.ts`) is the real
// path: `planSearch` picks the tier, `buildSearchSql` composes the ranked
// `to_tsquery`/`ts_rank_cd`/`ts_headline` SQL, `mergeRanked` blends the exact
// and type-ahead passes, with a local trigram typo tier for misspellings.
// ---------------------------------------------------------------------------

/** The row shape a `buildSearchSql` pass returns (its `SELECT` list). */
type RankedSearchRow = { id: string; snippet: string; rank: number };

/** A window over the ranked set, in `searchPages`' offset/take dialect. */
type SearchWindow = { offset: number; take: number };

/**
 * Whether the FTS GIN index (`Page_searchText_idx`) exists, probed once per
 * process. `setup:search` creates it; when missing, `planSearch` routes the
 * search to the bounded ILIKE and local-typo tiers instead of an unindexed
 * `to_tsvector` scan. A probe failure is not cached, so a transient error can
 * never permanently disable the fast path.
 */
let fullTextIndexProbe: Promise<boolean> | null = null;

function hasFullTextIndex(): Promise<boolean> {
  fullTextIndexProbe ??= prisma
    .$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'Page' AND indexname = 'Page_searchText_idx'
    `
    .then((rows) => rows.length > 0)
    .catch(() => {
      fullTextIndexProbe = null;
      return false;
    });
  return fullTextIndexProbe;
}

/**
 * Resolve the tier `planSearch` recommends. The planner's row estimate is only
 * consulted on the un-indexed path, so a count is avoided on every normal
 * (indexed) search.
 */
async function planFor(query: string, workspaceId: string) {
  const hasIndex = await hasFullTextIndex();
  const estimatedRows = hasIndex
    ? 0
    : await prisma.page.count({ where: { workspaceId, deletedAt: null } });
  return planSearch({ query, hasIndex, estimatedRows });
}

/**
 * Widen every lexeme of a builder tsquery to a prefix match, e.g.
 * `quarterly & roadmap:*` → `quarterly:* & roadmap:*`. The builder's tsquery
 * only prefixes its final term; this wider form powers the type-ahead pass that
 * `mergeRanked` blends beneath the exact hits (spec R78.8 / Dec5). Safe because
 * the tsquery is already sanitised to lexemes plus `&`/`<->`/`:*`.
 */
function prefixEveryTerm(tsquery: string): string {
  return tsquery
    .replace(/:\*/g, "")
    .replace(/[\p{L}\p{N}_]+/gu, (lexeme) => `${lexeme}:*`);
}

/**
 * Override the trailing `LIMIT` value of a `buildSearchSql` fragment.
 * `buildSearchSql` clamps its own limit to `200`; the windows here are already
 * bounded by the callers and may be larger (`SEARCH_PAGE_SCAN`), so the composed
 * SQL is kept and only the bound limit parameter is replaced.
 */
function withLimit(fragment: SqlFragment, limit: number): SqlFragment {
  const params = [...fragment.params];
  params[params.length - 1] = limit;
  return { text: fragment.text, params };
}

/**
 * Run a parameterised ranked SQL fragment, returning `[]` on any error. A
 * malformed/empty tsquery, a missing index or a dropped index must not throw
 * out of search — the caller falls through to the next tier.
 */
async function runRankedSearch(fragment: SqlFragment): Promise<RankedSearchRow[]> {
  if (!fragment.text) return [];
  try {
    return await prisma.$queryRawUnsafe<RankedSearchRow[]>(fragment.text, ...fragment.params);
  } catch {
    return [];
  }
}

/** Project the builder's rows onto `mergeRanked`'s input shape. */
function toRankedInput(rows: readonly RankedSearchRow[]): RankedInput[] {
  return rows.map((row) => ({ id: row.id, rank: row.rank }));
}

/**
 * The adopted FTS path (spec R78.8 / Dec5). `buildSearchSql` composes the
 * parameterised `to_tsquery`/`ts_rank_cd`/`ts_headline` SQL for the exact pass;
 * the same SQL is reused with an all-prefix tsquery for the type-ahead pass, and
 * the two are blended by `mergeRanked` (prefix-only hits at the builder's fixed
 * discount) so exact matches always outrank prefix-only ones.
 *
 * The builder's `<b>`/`</b>` headline markers are parsed away with
 * `parseHeadline`, keeping every caller on plain-text snippets (the UI applies
 * its own highlighting) exactly as the previous empty-`StartSel` SQL did.
 */
async function fullTextHits(
  query: string,
  workspaceId: string,
  visiblePageIds: Set<string> | null,
  window: SearchWindow,
): Promise<{ id: string; snippet: string }[]> {
  const limit = window.offset + window.take + 1;
  const exact = withLimit(
    buildSearchSql({
      query,
      scope: {
        workspaceId,
        visiblePageIds: visiblePageIds ? [...visiblePageIds] : null,
      },
      limit,
    }),
    limit,
  );
  if (!exact.text) return [];

  const prefix: SqlFragment = {
    text: exact.text,
    params: [prefixEveryTerm(String(exact.params[0])), ...exact.params.slice(1)],
  };

  const [exactRows, prefixRows] = await Promise.all([
    runRankedSearch(exact),
    runRankedSearch(prefix),
  ]);
  const merged = mergeRanked(toRankedInput(exactRows), toRankedInput(prefixRows));

  const snippetById = new Map<string, string>();
  for (const row of prefixRows) snippetById.set(row.id, parseHeadline(row.snippet).text);
  for (const row of exactRows) snippetById.set(row.id, parseHeadline(row.snippet).text);

  return merged
    .slice(window.offset, window.offset + window.take + 1)
    .map((hit) => ({ id: hit.id, snippet: snippetById.get(hit.id) ?? "" }));
}

/**
 * The typo tier (spec R78.8 / Dec5): runs only when the FTS passes come back
 * empty, ranking candidates by trigram similarity **computed in TypeScript**.
 *
 * This used to be `pg_trgm`'s `similarity(…)` in SQL. It is now local for one
 * decisive reason: the desktop build runs on an embedded Postgres (PGlite) that
 * does not ship `pg_trgm`, and a search feature must not decide whether the
 * installer can work on a machine with nothing installed. The trade is a bounded
 * candidate scan (the workspace's most recently updated pages, guest-scoped) —
 * this tier is a last resort, so the common paths are unaffected.
 */
async function trigramHits(
  query: string,
  workspaceId: string,
  visiblePageIds: Set<string> | null,
  window: SearchWindow,
): Promise<{ id: string; snippet: string }[]> {
  const candidates = await prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: TRIGRAM_CANDIDATE_LIMIT,
    select: { id: true, title: true, searchText: true, updatedAt: true },
  });
  const scored = scoreTrigramCandidates(
    query,
    candidates.map((page) => ({
      id: page.id,
      text: `${page.title} ${page.searchText ?? ""}`,
      updatedAt: page.updatedAt,
    })),
  ).sort((a, b) => b.rank - a.rank);
  const byId = new Map(candidates.map((page) => [page.id, page]));
  return scored
    .slice(window.offset, window.offset + window.take + 1)
    .map((hit) => ({
      id: hit.id,
      snippet: makeSnippet(byId.get(hit.id)?.searchText ?? byId.get(hit.id)?.title ?? "", query),
    }));
}

/**
 * Un-backfilled safety net (spec pass 3): a case-insensitive substring scan over
 * the mirror/title, run only when the FTS and typo tiers are both empty so pages
 * whose `searchText` predates the index stay findable.
 */
async function substringHits(
  query: string,
  workspaceId: string,
  visiblePageIds: Set<string> | null,
  window: SearchWindow,
): Promise<{ id: string; snippet: string }[]> {
  const fallback = await prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { searchText: { contains: query, mode: "insensitive" } },
      ],
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: window.take + 1,
    skip: window.offset,
    select: { id: true, title: true, searchText: true },
  });
  return fallback.map((page) => ({
    id: page.id,
    snippet: makeSnippet(page.searchText ?? page.title, query),
  }));
}

/**
 * Workspace search across page titles and body text. Bodies are scanned from
 * stored documents because Postgres cannot full-text index JSON portably; the
 * scan is bounded to keep it responsive for local workspaces.
 */
/**
 * Search a workspace: Postgres full-text ranking over `Page.searchText`, with a
 * prefix pass for partial words (type-ahead) and a small in-memory fallback for
 * pages whose mirror has not been backfilled yet.
 *
 * Pass `includeBlocks` to also read each hit's stored document and expose it as
 * `blocks` (the summariser's minimal shape) so the UI can render a real
 * content-derived teaser. It defaults off: the teaser payload is only wanted by
 * the search page, while the palette/API/cursor walks would otherwise read the
 * JSON of every hit.
 *
 * `visiblePageIds` narrows the result to the pages the caller may open; `null`
 * means "the whole workspace". It applies to a blank query as well: the
 * branch that lists the most recent pages is a window on the *visible* set,
 * not on the workspace — otherwise a guest could enumerate the titles of the
 * pages they may not open.
 */
export async function searchPages(
    workspaceId: string,
    query: string,
    /** Guest scoping: hide results the viewer may not open. */
    visiblePageIds: Set<string> | null = null,
    /** Window over the ranked set (the search page pages through it). */
    options: { take?: number; offset?: number; includeBlocks?: boolean } = {},
  ) {
    const take = options.take ?? 50;
    const offset = options.offset ?? 0;
    const includeBlocks = options.includeBlocks ?? false;
  const q = query.trim();
  const base = {
    id: true,
    title: true,
    icon: true,
    type: true,
    updatedAt: true,
  } as const;

  if (!q) {
    // A blank query still lists pages (the UI shows the most recent ones), so
    // the window is drawn from the caller's visible set: an unscoped caller
    // must not be able to enumerate the pages they may not open.
    const pages = await prisma.page.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take,
      skip: offset,
      select: includeBlocks ? { ...base, content: true } : base,
    });
    return pages.map((page) => toSearchHit(page, "", includeBlocks));
  }

  const plan = await planFor(q, workspaceId);
  const window: SearchWindow = { offset, take };
  let hits: { id: string; snippet: string }[] = [];

  if (plan.strategy === "fts") {
    // 1+2. Exact and type-ahead passes, blended by `mergeRanked` (Dec5).
    hits = await fullTextHits(q, workspaceId, visiblePageIds, window);
    if (hits.length === 0) {
      // 3a. Both FTS passes empty: the typo tier (trigram similarity, in TS).
      hits = await trigramHits(q, workspaceId, visiblePageIds, window);
    }
  } else if (plan.strategy === "ilike") {
    // No FTS index: a bounded, ordered substring scan (never a full-table scan),
    // then the local typo tier so a misspelling still lands.
    hits = await substringHits(q, workspaceId, visiblePageIds, window);
    if (hits.length === 0) {
      hits = await trigramHits(q, workspaceId, visiblePageIds, window);
    }
  }

  // 3b. Mirror not backfilled yet? The substring scan is the last resort.
  if (hits.length === 0 && plan.strategy !== "ilike") {
    hits = await substringHits(q, workspaceId, visiblePageIds, window);
  }

  if (visiblePageIds) hits = hits.filter((hit) => visiblePageIds.has(hit.id));
  if (hits.length === 0) return [];

  const order = new Map(hits.map((hit, index) => [hit.id, index]));
  const pages = await prisma.page.findMany({
    where: { id: { in: hits.map((hit) => hit.id) }, deletedAt: null },
    select: includeBlocks ? { ...base, content: true } : base,
  });
  const snippetById = new Map(hits.map((hit) => [hit.id, hit.snippet]));
  return pages
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((page) => toSearchHit(page, snippetById.get(page.id) ?? "", includeBlocks));
}

/**
 * Search with an explicit page window for the results list. Same ranking as
 * `searchPages`, but it reports whether another page exists so the UI can offer
 * "Load more" without re-running the whole workspace.
 */
export async function searchPagesPaged(
  workspaceId: string,
  query: string,
  visiblePageIds: Set<string> | null,
  options: { take?: number; offset?: number; includeBlocks?: boolean } = {},
): Promise<{ results: Awaited<ReturnType<typeof searchPages>>; nextOffset: number | null }> {
  const take = Math.min(Math.max(options.take ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const all = await searchPages(workspaceId, query, visiblePageIds, {
    take: take + 1,
    offset,
    includeBlocks: options.includeBlocks ?? false,
  });
  const hasMore = all.length > take;
  return {
    results: hasMore ? all.slice(0, take) : all,
    nextOffset: hasMore ? offset + take : null,
  };
}

/** Internal scan cap for cursor-paged search (see follow-up: keyset in SQL). */
const SEARCH_PAGE_SCAN = 1000;

/** Row shape of `GET /api/v1/search`. */
export type ApiSearchRow = Awaited<ReturnType<typeof searchPages>>[number];

/**
 * One keyset page of workspace search, ordered by the engine's rank with `id`
 * as the tie-break. `searchPages` already returns the ranked hits, so the page
 * assigns each row its positional rank and keysets over `(rank, id)` — stable
 * while a walk is in flight, re-ranked on each fresh query.
 */
export async function searchPagesPage(
  workspaceId: string,
  query: string,
  visiblePageIds: Set<string> | null,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<PaginateResult<ApiSearchRow>> {
  const ranked = await searchPages(workspaceId, query, visiblePageIds, {
    take: SEARCH_PAGE_SCAN,
  });
  const rankById = new Map(ranked.map((row, index) => [row.id, index]));
  return paginateSlice(ranked, {
    limit: options.limit,
    cursor: options.cursor,
    direction: "asc",
    keyOf: (row) => ({ key: rankById.get(row.id) ?? 0, tiebreaker: row.id }),
  });
}


/**
 * Ranked page retrieval for AI grounding: prompt → terms → scored pages.
 * Returns a small, relevant set (default 5) with excerpts.
 *
 * `visiblePageIds` is the guest scope, exactly like in {@link searchPages}:
 * `null` means the whole workspace (a member), a set means "only these pages"
 * (a guest). The filter is applied *in the query*, so the 500-row window is
 * taken from the visible pages and a guest's result set is never truncated by
 * pages they may not open. An empty set matches nothing.
 */
export async function searchPagesForPrompt(
  workspaceId: string,
  prompt: string,
  /** Guest scoping: only these page ids are searched; `null` = whole workspace. */
  visiblePageIds: Set<string> | null,
  take = 5,
) {
  const terms = promptTerms(prompt);
  if (terms.length === 0) return [];
  const pages = await prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
    select: { id: true, title: true, icon: true, type: true, content: true },
  });
  return pages
    .map((page) => {
      const text = prosemirrorToText(page.content);
      const { score, matched } = scorePage(terms, page.title, text);
      return { page, score, matched, text };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, take)
    .map((row) => ({
      id: row.page.id,
      title: row.page.title || "Untitled",
      icon: row.page.icon,
      type: row.page.type,
      snippet: snippetAround(row.text, row.matched[0] ?? ""),
      score: row.score,
    }));
}

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { makeSnippet } from "@/lib/search";
import { prosemirrorToText } from "@/lib/blocks";
import { docMentionsPage } from "@/lib/mentions";
import { promptTerms, scorePage, snippetAround } from "@/lib/retrieval";
import { paginateSlice, type PaginateResult } from "@/lib/cursor-pagination";
import {
  normalizeAuditEvent,
  paginateAudit,
  SYSTEM_ACTOR_ID,
  type AuditEvent,
} from "@/lib/audit-log";
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

export type PageTreeNode = {
  id: string;
  parentId: string | null;
  teamspaceId: string | null;
  title: string;
  icon: string | null;
  type: "PAGE" | "DATABASE";
  position: number;
  isFavorite: boolean;
};

/** Every workspace the user can open (owner or member). */
export async function getUserWorkspaces(userId: string) {
  return prisma.workspace.findMany({
    where: {
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true, icon: true, ownerId: true },
  });
}

/** Row shape of `GET /api/v1/workspaces`. */
export type ApiWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
};

/**
 * One keyset page of the caller's workspaces (owner or member), ordered by the
 * documented tuple `(createdAt, id)`. Mirrors `getUserWorkspaces`'s access
 * predicate but pages over the opaque cursor dialect.
 */
export async function getWorkspacesPage(
  userId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<PaginateResult<ApiWorkspaceRow>> {
  const rows = await prisma.workspace.findMany({
    where: {
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, slug: true, icon: true, createdAt: true },
  });
  const page = paginateSlice(rows, {
    limit: options.limit,
    cursor: options.cursor,
    direction: "asc",
    keyOf: (row) => ({ key: row.createdAt.toISOString(), tiebreaker: row.id }),
  });
  return {
    items: page.items.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      icon: row.icon,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getWorkspaceBySlug(slug: string) {
  return prisma.workspace.findUnique({ where: { slug } });
}

/** Live (non-trashed) pages in a workspace, ordered for tree rendering. */
export async function getPageTree(
  workspaceId: string,
  /**
   * Guest scoping: only these page ids (plus ancestors) are returned; `null`
   * returns the whole workspace. Required — like `getPagesPage` — so a caller
   * can never forget the filter and silently widen the tree.
   */
  visiblePageIds: Set<string> | null,
): Promise<PageTreeNode[]> {
  return prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      parentId: true,
      teamspaceId: true,
      title: true,
      icon: true,
      type: true,
      position: true,
      isFavorite: true,
    },
  });
}

/** Row shape of `GET /api/v1/pages` (the cursor's sort fields stay internal). */
export type ApiPageRow = {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  type: "PAGE" | "DATABASE";
  updatedAt: Date;
};

/**
 * One keyset page of a workspace's live pages, in the documented total order
 * `(position, createdAt, id)`. The opaque cursor carries `position` as its key
 * and a `createdAt|id` composite tiebreaker, so pages that share a position
 * (`Page.position` defaults to `0`) never overlap or get skipped between calls.
 *
 * `visiblePageIds` is the guest scope (see `pageScopeFor`): `null` returns the
 * whole workspace, a set returns only those pages. It is a required argument
 * so a caller can never forget the filter and silently widen the listing.
 */
export async function getPagesPage(
  workspaceId: string,
  /** Guest scoping: only these page ids are returned; `null` = the whole workspace. */
  visiblePageIds: Set<string> | null,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<PaginateResult<ApiPageRow>> {
  const rows = await prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      parentId: true,
      title: true,
      icon: true,
      type: true,
      updatedAt: true,
      position: true,
      createdAt: true,
    },
  });
  const page = paginateSlice(rows, {
    limit: options.limit,
    cursor: options.cursor,
    direction: "asc",
    keyOf: (row) => ({
      key: row.position,
      tiebreaker: `${row.createdAt.toISOString()}|${row.id}`,
    }),
  });
  return {
    items: page.items.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      title: row.title,
      icon: row.icon,
      type: row.type,
      updatedAt: row.updatedAt,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/** A teamspace as the clients see it. */
export type TeamspaceView = { id: string; name: string; icon: string | null };

/**
 * The teamspaces of a workspace, scoped for the viewer.
 *
 * `visibleTeamspaceIds` is the viewer's teamspace scope (see `viewerScopeFor`
 * in `@/lib/guest-access`): `null` returns every teamspace of the workspace, a
 * set returns only the teamspaces it names. The scope is a **required**
 * argument, so a caller can never forget it and silently widen the listing.
 *
 * The filter is applied twice on purpose: the query narrows the rows the
 * database hands over, and the filter below drops everything outside the scope
 * even if the query layer returned more. A guest's payload must never carry
 * the name of a teamspace they have no business seeing.
 */
export async function getTeamspaces(
  workspaceId: string,
  visibleTeamspaceIds: Set<string> | null,
): Promise<TeamspaceView[]> {
  const rows = await prisma.teamspace.findMany({
    where: {
      workspaceId,
      ...(visibleTeamspaceIds ? { id: { in: [...visibleTeamspaceIds] } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      icon: true,
    },
  });
  if (!visibleTeamspaceIds) return rows;
  return rows.filter((row) => visibleTeamspaceIds.has(row.id));
}

/** Only pages whose own parent chain reaches the workspace root. */
export function rootPages(tree: PageTreeNode[]): PageTreeNode[] {
  return tree.filter((p) => p.parentId === null);
}

export function childrenOf(tree: PageTreeNode[], parentId: string): PageTreeNode[] {
  return tree.filter((p) => p.parentId === parentId);
}

/**
 * The workspace trash: the pages that were archived, with restore and
 * permanent delete.
 *
 * `visiblePageIds` is the guest scope (see `pageScopeFor`): `null` returns the
 * whole trash, a set returns only the trashed pages the caller may see. It is
 * a required argument — like `getPageTree` — so a caller can never forget the
 * filter and list a title the guest was never given.
 */
export async function getTrash(
  workspaceId: string,
  visiblePageIds: Set<string> | null,
) {
  return prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: { not: null },
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
    select: { id: true, title: true, icon: true, deletedAt: true, parentId: true },
  });
}

export async function getFavorites(
  userId: string,
  workspaceId: string,
  /**
   * Guest scoping: only these page ids are returned. `null` = every page of
   * the workspace. The scope is a **required** argument, so a caller can never
   * forget the filter and silently widen the listing.
   */
  visiblePageIds: Set<string> | null,
) {
  return prisma.favorite.findMany({
    where: {
      userId,
      page: {
        workspaceId,
        deletedAt: null,
        ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
      },
    },
    orderBy: { id: "asc" },
    select: {
      page: { select: { id: true, title: true, icon: true, type: true } },
    },
  });
}

export async function getPageDetail(pageId: string) {
  return prisma.page.findUnique({
    where: { id: pageId },
    include: {
      createdBy: { select: { id: true, name: true, avatarUrl: true } },
      versions: {
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          title: true,
          summary: true,
          charDelta: true,
          createdAt: true,
          createdById: true,
          // Stored ProseMirror body, folded here so the page route can derive its
          // inline-diff plain text without a second `pageVersion.findMany`.
          content: true,
        },
      },
      shareLinks: {
        select: { id: true, token: true },
        take: 1,
      },
      comments: {
        where: { parentId: null },
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { id: true, name: true, avatarUrl: true } },
          reactions: { select: { emoji: true, userId: true } },
          replies: {
            orderBy: { createdAt: "asc" },
            include: {
              author: { select: { id: true, name: true, avatarUrl: true } },
              reactions: { select: { emoji: true, userId: true } },
            },
          },
        },
      },
    },
  });
}

export type RelationData = {
  options: { id: string; title: string; icon: string | null }[];
  valuesByRow: Record<string, Record<string, unknown>>;
  properties: { id: string; name: string; type: string }[];
};

export async function getDatabase(databasePageId: string) {
  // A database's rows are the pages that hang under it, and they belong to the
  // database's own workspace. `Page.parentId` is a plain foreign key, so a row
  // that was linked across workspaces (the unchecked `parentId` hole, B08)
  // would otherwise show up in this view and in the database exports. The rows
  // are therefore filtered by the database's workspace; an unknown database
  // resolves to a blank workspace, which matches no row.
  const database = await prisma.page.findUnique({
    where: { id: databasePageId },
    select: { workspaceId: true },
  });
  const workspaceId = database?.workspaceId ?? "";
  const [properties, views, rows, templateRows] = await Promise.all([
    prisma.property.findMany({
      where: { databasePageId },
      orderBy: { position: "asc" },
    }),
    prisma.databaseView.findMany({
      where: { databasePageId },
      orderBy: { position: "asc" },
    }),
    prisma.page.findMany({
      where: { parentId: databasePageId, workspaceId, deletedAt: null },
      orderBy: { position: "asc" },
      include: {
        propertyValues: true,
        createdBy: { select: { name: true } },
      },
    }),
    prisma.template.findMany({
      where: { databasePageId },
      orderBy: { createdAt: "asc" },
      // R31.15 — expose the planner inputs so `database-view`'s template engine
      // can read a template's property defaults (`config.values`) and body
      // (`content`) instead of showing display-only rows. `isDefault` (the
      // planner's default pick, `resolveDefaultTemplate`) and `position` (the
      // authored order, templates.md §5) are now columns on `Template`, so they
      // are projected additively for the UI/actions to consume.
      select: {
        id: true,
        name: true,
        icon: true,
        recurrence: true,
        config: true,
        content: true,
        isDefault: true,
        position: true,
      },
    }),
  ]);

  // Resolve related-database rows/values for relation + rollup properties.
  const relationData: Record<string, RelationData> = {};

  // Latest recorded editor per row, newest first, for the LAST_EDITED_BY
  // property. Rows without an activity line fall back to their creator.
  const rowIds = rows.map((row) => row.id);
  const lastEditedBy: Record<string, string> = {};
  if (rowIds.length > 0) {
    const edits = await prisma.activity.findMany({
      where: { targetType: "page", targetId: { in: rowIds }, action: "row.edited" },
      orderBy: { createdAt: "desc" },
      select: { targetId: true, actor: { select: { name: true } } },
      take: 1000,
    });
    for (const edit of edits) {
      if (edit.targetId && edit.actor && !(edit.targetId in lastEditedBy)) {
        lastEditedBy[edit.targetId] = edit.actor.name;
      }
    }
  }
  const relationProperties = properties.filter((property) => {
    if (property.type !== "RELATION") return false;
    const config = property.config as { targetDatabaseId?: string } | null;
    return Boolean(config?.targetDatabaseId);
  });
  await Promise.all(
    relationProperties.map(async (property) => {
      const targetDatabaseId = (property.config as { targetDatabaseId: string })
        .targetDatabaseId;
      // B98 — the target of a relation must be a database of the *same*
      // workspace as the database being read. Filtering the target's rows by
      // the target's own workspace would be tautological (a foreign target's
      // rows all carry the foreign workspace id and would pass), so the two
      // workspaces are compared explicitly. A relation that points outside the
      // workspace — from an old revision, an import or a direct database edit —
      // yields no options, no cell values and no schema.
      const target = await prisma.page.findFirst({
        where: { id: targetDatabaseId, type: "DATABASE", deletedAt: null },
        select: { id: true, workspaceId: true },
      });
      if (!target || target.workspaceId !== workspaceId) {
        relationData[property.id] = { options: [], valuesByRow: {}, properties: [] };
        return;
      }
      const [targetProperties, targetRows] = await Promise.all([
        prisma.property.findMany({
          where: {
            databasePageId: targetDatabaseId,
            databasePage: { workspaceId: target.workspaceId },
          },
          orderBy: { position: "asc" },
          select: { id: true, name: true, type: true },
        }),
        prisma.page.findMany({
          where: {
            parentId: targetDatabaseId,
            workspaceId: target.workspaceId,
            deletedAt: null,
          },
          orderBy: { position: "asc" },
          include: { propertyValues: true },
        }),
      ]);
      relationData[property.id] = {
        options: targetRows.map((row) => ({
          id: row.id,
          title: row.title,
          icon: row.icon,
        })),
        valuesByRow: Object.fromEntries(
          targetRows.map((row) => [
            row.id,
            Object.fromEntries(row.propertyValues.map((v) => [v.propertyId, v.value])),
          ]),
        ),
        properties: targetProperties,
      };
    }),
  );

  // Narrow each template's `config` (a Prisma `JsonValue`) to the shape
  // `database-view`'s template engine reads (`config.values` = property
  // defaults); `content` passes through untouched. Purely a type projection —
  // the stored JSON is unchanged.
  const templates = templateRows.map((template) => ({
    ...template,
    config: (template.config ?? null) as unknown as {
      values?: { propertyId: string; value: unknown }[];
    } | null,
  }));

  return { properties, views, rows, templates, relationData, lastEditedBy };
}

export type DatabaseData = Awaited<ReturnType<typeof getDatabase>>;

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

/** Pages in the workspace that @-mention the given page (linked references). */
export async function getBacklinks(
  workspaceId: string,
  pageId: string,
  visiblePageIds: Set<string> | null = null,
) {
  const pages = await prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      NOT: { id: pageId },
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 1000,
    select: { id: true, title: true, icon: true, content: true },
  });
  return pages
    .filter((page) => docMentionsPage(page.content, pageId))
    .map(({ id, title, icon }) => ({ id, title, icon }));
}

export async function getWorkspaceMembers(workspaceId: string) {  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
    },
  });
  return members.map((m) => ({ ...m.user, role: m.role }));
}

/** Ancestry trail (root → … → parent) for the breadcrumb block. */export async function getAncestorTrail(
  workspaceId: string,
  pageId: string,
): Promise<{ id: string; title: string }[]> {
  const trail: { id: string; title: string }[] = [];
  let cursor = await prisma.page.findUnique({
    where: { id: pageId },
    select: { parentId: true },
  });
  let guard = 0;
  while (cursor?.parentId && guard < 50) {
    const parent = await prisma.page.findUnique({
      where: { id: cursor.parentId },
      select: { id: true, title: true, parentId: true, workspaceId: true },
    });
    if (!parent || parent.workspaceId !== workspaceId) break;
    trail.unshift({ id: parent.id, title: parent.title });
    cursor = { parentId: parent.parentId };
    guard += 1;
  }
  return trail;
}

export async function getNotifications(userId: string, take = 50) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function getUnreadNotificationCount(userId: string) {
  return prisma.notification.count({ where: { userId, read: false } });
}

export async function getRecentWebhookDeliveries(workspaceId: string, take = 15) {
  return prisma.webhookDelivery.findMany({
    where: { webhook: { workspaceId } },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      event: true,
      ok: true,
      responseStatus: true,
      attempts: true,
      error: true,
      createdAt: true,
      webhook: { select: { url: true } },
    },
  });
}


// ---------------------------------------------------------------------------
// Chat (workspace discussions)
// ---------------------------------------------------------------------------

export async function getChatThreads(workspaceId: string, take = 50) {
  return prisma.chatThread.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    take,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      createdBy: { select: { id: true, name: true } },
      _count: { select: { messages: true } },
    },
  });
}

export async function getChatThread(threadId: string) {
  return prisma.chatThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      title: true,
      workspaceId: true,
      createdById: true,
      messages: {
        orderBy: { createdAt: "asc" },
        take: 200,
        select: {
          id: true,
          body: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Calendar (ICS subscriptions)
// ---------------------------------------------------------------------------

/**
 * The workspace's subscribed calendars, as a client sees them.
 *
 * The feed URL itself (`icsUrl`) is deliberately *not* selected: it is the
 * private address of a personal calendar and often carries a secret token in
 * its path, so it never leaves the server — the server reads the feed itself
 * (`refreshCalendarFeedsAction`).
 */
export async function getCalendarFeeds(workspaceId: string) {
  return prisma.calendarFeed.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      color: true,
      _count: { select: { events: true } },
    },
  });
}

export async function getUpcomingEvents(workspaceId: string, take = 25) {
  const from = new Date(Date.now() - 12 * 60 * 60 * 1000);
  return prisma.calendarEvent.findMany({
    where: { workspaceId, start: { gte: from } },
    orderBy: { start: "asc" },
    take,
    select: {
      id: true,
      title: true,
      start: true,
      end: true,
      allDay: true,
      location: true,
      url: true,
      notesPageId: true,
      feed: { select: { name: true, color: true } },
    },
  });
}
/** Threads with their recent messages, for the sidebar chat panel. */
export async function getChatThreadsWithMessages(workspaceId: string, take = 20) {
  return prisma.chatThread.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    take,
    select: {
      id: true,
      title: true,
      pageId: true,
      page: { select: { id: true, title: true, icon: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        take: 50,
        select: {
          id: true,
          body: true,
          role: true,
          meta: true,
          createdAt: true,
          user: { select: { name: true, email: true } },
        },
      },
    },
  });
}

/** Projects with their milestones, for the projects area. */
export async function getProjects(workspaceId: string) {
  return prisma.project.findMany({
    where: { workspaceId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      summary: true,
      description: true,
      status: true,
      color: true,
      icon: true,
      startDate: true,
      dueDate: true,
      milestones: {
        orderBy: [{ position: "asc" }],
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          dueDate: true,
          completedAt: true,
        },
      },
      _count: { select: { pages: true } },
    },
  });
}

export async function getProjectDetail(workspaceId: string, projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: {
      id: true,
      name: true,
      summary: true,
      description: true,
      status: true,
      color: true,
      icon: true,
      startDate: true,
      dueDate: true,
      createdAt: true,
      members: {
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
      },
      milestones: {
        orderBy: [{ position: "asc" }],
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          dueDate: true,
          completedAt: true,
        },
      },
      pages: {
        where: { deletedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, icon: true, type: true },
      },
    },
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
// ---------------------------------------------------------------------------
// Tickets (issues) & labels
// ---------------------------------------------------------------------------

export async function getLabels(workspaceId: string) {
  return prisma.label.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      color: true,
      description: true,
      _count: { select: { tickets: true } },
    },
  });
}

/** Columns the ticket tracker needs, shared by the list query and its pages. */
const ticketListSelect = {
  id: true,
  key: true,
  number: true,
  title: true,
  description: true,
  type: true,
  status: true,
  priority: true,
  estimate: true,
  estimateUnit: true,
  startDate: true,
  dueDate: true,
  completedAt: true,
  updatedAt: true,
  parentId: true,
  cycleId: true,
  project: { select: { id: true, name: true, icon: true } },
  milestone: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, email: true } },
  labels: { select: { label: { select: { id: true, name: true, color: true } } } },
  _count: { select: { children: true, comments: true } },
} as const;

export async function getTickets(
  workspaceId: string,
  filters: { includeArchived?: boolean } = {},
) {
  return prisma.ticket.findMany({
    where: { workspaceId, archived: filters.includeArchived ? undefined : false },
    orderBy: [{ position: "asc" }, { createdAt: "desc" }],
    take: 500,
    select: ticketListSelect,
  });
}

export async function getTicketViews(workspaceId: string) {
  return prisma.ticketView.findMany({
    where: { workspaceId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, config: true },
  });
}

/** Sprints: cycles with their tickets, newest first. */
export async function getCycles(workspaceId: string) {
  return prisma.cycle.findMany({
    where: { workspaceId },
    orderBy: { startDate: "desc" },
    select: {
      id: true,
      name: true,
      goal: true,
      startDate: true,
      endDate: true,
      tickets: {
        select: {
          id: true,
          key: true,
          title: true,
          status: true,
          priority: true,
          type: true,
          estimate: true,
          estimateUnit: true,
          startDate: true,
          dueDate: true,
          completedAt: true,
          updatedAt: true,
          assignee: { select: { id: true, name: true } },
        },
      },
    },
  });
}

/** Recent workspace activity (audit trail) for the settings view. */
export async function getRecentActivity(workspaceId: string, take = 40) {
  return prisma.activity.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      action: true,
      targetType: true,
      targetId: true,
      meta: true,
      createdAt: true,
      actor: { select: { id: true, name: true, email: true } },
    },
  });
}

/** Internal scan cap for the cursor-paged activity feed (see follow-up: keyset in SQL). */
const ACTIVITY_PAGE_SCAN = 1000;

/**
 * Optional server-side narrowing for {@link getActivityPage}: the same axes the
 * pure `AuditFilter` in `@/lib/audit-log` exposes, pushed into the Prisma query
 * rather than applied to a fetched window.
 *
 * A present-but-empty `actorIds`/`types` matches nothing; an omitted axis is
 * unconstrained; `from`/`to` are inclusive and accept a `Date` or an ISO-8601
 * string. `actorIds` follows `normalizeAuditEvent`, so `SYSTEM_ACTOR_ID` also
 * keeps authorless rows (`actorId: null`).
 */
export type ActivityPageFilters = {
  actorIds?: readonly string[];
  types?: readonly string[];
  from?: Date | string;
  to?: Date | string;
};

/**
 * Translate {@link ActivityPageFilters} into an `Activity` predicate so the
 * narrowing happens in the database: a filtered page fills its
 * `ACTIVITY_PAGE_SCAN` window from matching rows only, instead of trimming a
 * workspace-wide window after the fact (which left filtered pages sparse).
 */
function activityWhere(
  workspaceId: string,
  filters: ActivityPageFilters,
): Prisma.ActivityWhereInput {
  const where: Prisma.ActivityWhereInput = { workspaceId };

  if (filters.actorIds !== undefined) {
    // `actorId` is nullable; the normaliser reports those rows as
    // `SYSTEM_ACTOR_ID`, so a filter naming it must keep `null` rows as well.
    const ids = [...filters.actorIds];
    where.OR = [
      { actorId: { in: ids.filter((id) => id !== SYSTEM_ACTOR_ID) } },
      ...(ids.includes(SYSTEM_ACTOR_ID) ? [{ actorId: null }] : []),
    ];
  }
  if (filters.types !== undefined) {
    where.action = { in: [...filters.types] };
  }
  if (filters.from !== undefined || filters.to !== undefined) {
    where.createdAt = {
      ...(filters.from !== undefined ? { gte: filters.from } : {}),
      ...(filters.to !== undefined ? { lte: filters.to } : {}),
    };
  }

  return where;
}

/**
 * One keyset page of a workspace's activity/audit feed, newest first.
 *
 * Additive companion to {@link getRecentActivity}: the same `Activity` rows, but
 * projected through the pure `@/lib/audit-log` reference implementation and
 * walked with the shared opaque `@/lib/cursor-pagination` dialect, so "Load more"
 * never re-reads the workspace and the boundary row is never repeated or skipped.
 * A row without a `targetId` falls back to its own id and a missing actor to
 * `SYSTEM_ACTOR_ID` (both via `normalizeAuditEvent`), so the feed never silently
 * drops an event. A malformed cursor fails closed (`items: []`, `hasMore: false`).
 *
 * Optional {@link ActivityPageFilters} (`actorIds`/`types`/`from`/`to`) are
 * applied to the Prisma query, so a filtered walk pages over matching rows only
 * instead of over-fetching then discarding — see `activityWhere`.
 */
export async function getActivityPage(
  workspaceId: string,
  options: { limit?: number; cursor?: string | null } & ActivityPageFilters = {},
): Promise<PaginateResult<AuditEvent>> {
  const rows = await prisma.activity.findMany({
    where: activityWhere(workspaceId, options),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ACTIVITY_PAGE_SCAN,
    select: {
      id: true,
      actorId: true,
      action: true,
      targetType: true,
      targetId: true,
      meta: true,
      createdAt: true,
    },
  });

  const events: AuditEvent[] = [];
  for (const row of rows) {
    const event = normalizeAuditEvent({
      id: row.id,
      actorId: row.actorId,
      type: row.action,
      entityId: row.targetId ?? row.id,
      entityType: row.targetType,
      createdAt: row.createdAt,
      meta: row.meta ?? undefined,
    });
    if (event !== null) events.push(event);
  }

  return paginateAudit(events, { limit: options.limit, cursor: options.cursor });
}

/**
 * One page of tickets for the tracker, ordered by board position.
 *
 * Keyset pagination on `id` (stable while tickets move), so "Load more" never
 * re-reads the whole workspace and never skips or repeats a row.
 */
export async function getTicketsPage(
  workspaceId: string,
  options: { take?: number; cursor?: string | null } = {},
) {
  const take = Math.min(Math.max(options.take ?? 100, 1), 200);
  const rows = await prisma.ticket.findMany({
    where: { workspaceId, archived: false },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: ticketListSelect,
  });
  const hasMore = rows.length > take;
  const tickets = hasMore ? rows.slice(0, take) : rows;
  return { tickets, nextCursor: hasMore ? (tickets[tickets.length - 1]?.id ?? null) : null };
}

/** Row shape of `GET /api/tickets`. */
export type ApiTicketRow = Awaited<ReturnType<typeof getTickets>>[number];

/**
 * One keyset page of a workspace's tickets ordered by the documented tuple
 * `(id)`, for the public `GET /api/tickets`. Mirrors `getTickets`'s select and
 * archived filter, but pages on the opaque cursor dialect rather than the
 * tracker's raw-id cursor.
 */
export async function getTicketsCursorPage(
  workspaceId: string,
  options: { limit?: number; cursor?: string | null; includeArchived?: boolean } = {},
): Promise<PaginateResult<ApiTicketRow>> {
  const rows = await prisma.ticket.findMany({
    where: { workspaceId, archived: options.includeArchived ? undefined : false },
    orderBy: [{ id: "asc" }],
    select: ticketListSelect,
  });
  return paginateSlice(rows, {
    limit: options.limit,
    cursor: options.cursor,
    direction: "asc",
    keyOf: (row) => ({ key: row.id, tiebreaker: row.id }),
  });
}

/**
 * One ticket in the tracker's list shape, scoped to its workspace.
 *
 * The tracker pages by board position (`getTicketsPage`), so the *last* page
 * holds the newest tickets - exactly the ones an assignment notice names. A deep
 * link therefore cannot assume the row it points at is on the first page, and
 * this is the single-row lookup that lets the drawer open anyway.
 */
export async function getTicketListRow(workspaceId: string, ticketId: string) {
  return prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId, archived: false },
    select: ticketListSelect,
  });
}

/** Tickets belonging to one project (project page rollup + Gantt). */export async function getProjectTickets(workspaceId: string, projectId: string) {
  return prisma.ticket.findMany({
    where: { workspaceId, projectId, archived: false },
    orderBy: [{ position: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      key: true,
      title: true,
      type: true,
      status: true,
      priority: true,
      estimate: true,
      estimateUnit: true,
      startDate: true,
      dueDate: true,
      assignee: { select: { id: true, name: true } },
      labels: { select: { label: { select: { id: true, name: true, color: true } } } },
    },
  });
}

export async function getTicketDetail(ticketId: string) {
  return prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      key: true,
      number: true,
      title: true,
      description: true,
      type: true,
      status: true,
      priority: true,
      estimate: true,
      estimateUnit: true,
      startDate: true,
      dueDate: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      archived: true,
      workspaceId: true,
      project: { select: { id: true, name: true, icon: true } },
      milestone: { select: { id: true, name: true, status: true } },
      assignee: { select: { id: true, name: true, email: true } },
      reporter: { select: { id: true, name: true, email: true } },
      labels: { select: { id: true, label: { select: { id: true, name: true, color: true } } } },
      children: { select: { id: true, key: true, title: true, status: true } },
      relations: {
        select: {
          id: true,
          type: true,
          to: { select: { id: true, key: true, title: true, status: true } },
        },
      },
      relatedBy: {
        select: {
          id: true,
          type: true,
          from: { select: { id: true, key: true, title: true, status: true } },
        },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        take: 100,
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: { select: { id: true, name: true, email: true } },
        },
      },
      activity: {
        orderBy: { createdAt: "desc" },
        take: 40,
        select: {
          id: true,
          kind: true,
          detail: true,
          createdAt: true,
          actor: { select: { id: true, name: true } },
        },
      },
    },
  });
}

/** Per-project ticket counts and estimate totals (project page + chat tools). */
export async function getProjectTicketSummary(workspaceId: string) {
  const tickets = await prisma.ticket.findMany({
    where: { workspaceId, archived: false },
    select: {
      projectId: true,
      status: true,
      estimate: true,
      estimateUnit: true,
      dueDate: true,
    },
  });
  const summary = new Map<
    string,
    { total: number; open: number; estimate: number; unit: string; overdue: number }
  >();
  const now = Date.now();
  for (const ticket of tickets) {
    const key = ticket.projectId ?? "none";
    const entry =
      summary.get(key) ?? { total: 0, open: 0, estimate: 0, unit: "points", overdue: 0 };
    entry.total += 1;
    if (ticket.status !== "done" && ticket.status !== "cancelled") {
      entry.open += 1;
      if (ticket.estimate !== null) {
        entry.estimate += ticket.estimate;
        entry.unit = ticket.estimateUnit ?? "points";
      }
      if (ticket.dueDate && ticket.dueDate.getTime() < now) entry.overdue += 1;
    }
    summary.set(key, entry);
  }
  return summary;
}
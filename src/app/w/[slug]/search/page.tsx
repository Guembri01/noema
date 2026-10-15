import Link from "next/link";
import { notFound } from "next/navigation";
import { Search } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { getWorkspaceBySlug, searchPagesPaged } from "@/server/queries";
import { t } from "@/lib/i18n";
import { SearchResults } from "@/components/search-results";
import { truncate } from "@/lib/utils";
import { buildIndex, rank } from "@/lib/search-ranking";

/**
 * How strongly a title hit outranks an equally frequent body hit in the
 * client-side refinement pass below. Above `1` so the page name the user typed
 * surfaces first, matching the intent of the engine's own title-weighted rank.
 */
const SEARCH_TITLE_WEIGHT = 3;

/**
 * Refine the SQL-ranked window in memory with the shared BM25 scorer
 * (`search-ranking.ts`), weighting title matches. The Postgres `ts_rank` pass
 * already orders the corpus, but within one loaded page we can do better on
 * the fields we hold: title vs. snippet. Purely additive and lossless — rows
 * the scorer does not recognise (prefix and substring-fallback hits, whose
 * terms fold differently) keep their engine order and follow the scored rows,
 * so pagination and result counts are unchanged. A stable sort leaves the
 * engine's order intact for any remaining ties.
 */
function refineByRelevance<
  T extends { id: string; title: string; snippet: string; updatedAt: Date },
>(rows: readonly T[], query: string): T[] {
  if (rows.length <= 1) return [...rows];
  const index = buildIndex(
    rows.map((row) => ({
      id: row.id,
      fields: { title: row.title, body: row.snippet },
      updatedAt: row.updatedAt.getTime(),
    })),
  );
  const ranked = rank(index, query, {
    titleWeight: SEARCH_TITLE_WEIGHT,
    limit: rows.length,
  });
  if (ranked.length === 0) return [...rows];
  const position = new Map(ranked.map((result, index) => [result.id, index]));
  return [...rows].sort((a, b) => {
    const left = position.get(a.id);
    const right = position.get(b.id);
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { slug } = await params;
  const { q = "" } = await searchParams;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const visiblePageIds = await pageScopeFor(user.id, workspace.id, access.role);
  const paged = q.trim()
    ? await searchPagesPaged(workspace.id, q, visiblePageIds, {
        take: 50,
        includeBlocks: true,
      })
    : { results: [], nextOffset: null };
  const results = refineByRelevance(paged.results, q);

  return (
    <div className="mx-auto max-w-3xl px-10 py-12">
      <h1 className="mb-5 text-2xl font-semibold tracking-tight">{t(locale, "search")}</h1>

      <form method="GET" className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="Search titles and page content…"
          className="h-11 w-full rounded-lg border border-border bg-bg pl-9 pr-3 text-sm outline-none focus:border-accent"
        />
      </form>

      {q.trim() ? (
        <SearchResults
          workspaceId={workspace.id}
          slug={workspace.slug}
          query={q}
          locale={locale}
          initial={results.map((page) => ({
            id: page.id,
            title: page.title ?? "",
            icon: page.icon,
            type: page.type,
            snippet: page.snippet ?? "",
            blocks: page.blocks ?? [],
          }))}
          nextOffset={paged.nextOffset}
        />
      ) : null}
   </div>
  );
}

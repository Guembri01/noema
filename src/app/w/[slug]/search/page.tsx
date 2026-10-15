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
import { refineByRelevance } from "@/lib/search-ranking";

/**
 * How strongly a title hit outranks an equally frequent body hit in the shared
 * BM25 refinement pass below. Above `1` so the page name the user typed
 * surfaces first, matching the intent of the engine's own title-weighted rank.
 */
const SEARCH_TITLE_WEIGHT = 3;

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
  // Re-order the SQL-ranked window in memory with the shared BM25 scorer
  // (`search-ranking.ts`), weighting title matches. Purely additive and
  // lossless: rows the scorer does not recognise keep their engine order and
  // follow the scored rows, so pagination and result counts are unchanged. The
  // hit's `snippet` is the body the scorer should read (the shared default is
  // `row.body`), so it is supplied through the `getBody` accessor.
  const results = refineByRelevance(paged.results, q, {
    titleWeight: SEARCH_TITLE_WEIGHT,
    getBody: (row) => row.snippet,
  });

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

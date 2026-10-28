import Link from "next/link";
import { notFound } from "next/navigation";
import { Search } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { getWorkspaceBySlug, searchPagesPaged } from "@/server/queries";
import { t } from "@/lib/i18n";
import { SearchResults } from "@/components/search-results";
import { LiveSearchInput } from "@/components/live-search-input";
import { EmptyState } from "@/components/ui/empty-state";
import { truncate } from "@/lib/utils";
import { refineByRelevance } from "@/lib/search-ranking";
import { filterByType, parseTypeScope, type SearchType } from "@/lib/fuzzy";

/**
 * How strongly a title hit outranks an equally frequent body hit in the shared
 * BM25 refinement pass below. Above `1` so the page name the user typed
 * surfaces first, matching the intent of the engine's own title-weighted rank.
 */
const SEARCH_TITLE_WEIGHT = 3;

/**
 * Item types the search page can be narrowed to via the URL `type` param
 * (§11 Search filters / Search by type). A subset of the shared engine's
 * `SEARCH_TYPES`: page search only indexes pages, so `page`/`database` map onto
 * the stored `PageType`, while `ticket` is accepted for URL parity with the
 * palette and simply yields no page hits. Anything else means "all types".
 */
const SEARCH_PAGE_TYPES = ["page", "database", "ticket"] as const;

type SearchPageType = (typeof SEARCH_PAGE_TYPES)[number];

function isSearchPageType(value: SearchType | null): value is SearchPageType {
  return value !== null && (SEARCH_PAGE_TYPES as readonly string[]).includes(value);
}

/**
 * Parse the `type` URL param into a scope, normalising case and plurals the way
 * the shared `parseTypeScope` engine does (`?type=Databases` → `database`).
 * Unknown or empty values fall back to `null`, i.e. no scoping.
 */
function parseSearchPageType(raw: string | undefined): SearchPageType | null {
  if (!raw) return null;
  const { type } = parseTypeScope(`type:${raw}`);
  return isSearchPageType(type) ? type : null;
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const { slug } = await params;
  const { q = "", type } = await searchParams;
  const searchType = parseSearchPageType(type);
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
  //
  // The URL `type` scope narrows the window before ranking: `filterByType` is
  // order-preserving and score-free, so it composes in front of the scorer.
  // Default is all types (`searchType === null`).
  const scoped = searchType
    ? filterByType(paged.results, searchType, (row) => row.type)
    : paged.results;
  const results = refineByRelevance(scoped, q, {
    titleWeight: SEARCH_TITLE_WEIGHT,
    getBody: (row) => row.snippet,
  });

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <header className="mb-6">
        <h1 className="text-title font-semibold tracking-title">{t(locale, "search")}</h1>
        <p className="mt-2 text-sm text-muted">
          Find pages and databases by title and content across the workspace.
        </p>
      </header>

      <LiveSearchInput
        initialQuery={q}
        type={searchType}
        locale={locale}
      />

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
      ) : (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title="Search the workspace"
          description="Type a title or a phrase from a page to find it here."
        />
      )}
   </div>
  );
}

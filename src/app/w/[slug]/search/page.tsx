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
  const results = paged.results;

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

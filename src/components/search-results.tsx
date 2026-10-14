"use client";

import { useState } from "react";
import Link from "next/link";
import { loadMoreSearchAction } from "@/server/actions/search";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";

export type SearchRow = {
  id: string;
  title: string;
  icon: string | null;
  type: string;
  snippet: string;
};

/**
 * The search results list, with a keyset "Load more" that appends the next
 * window instead of re-running the query.
 */
export function SearchResults({
  workspaceId,
  slug,
  query,
  initial,
  nextOffset,
  locale,
}: {
  workspaceId: string;
  slug: string;
  query: string;
  initial: SearchRow[];
  nextOffset: number | null;
  locale: string;
}) {
  const { run, pending, error } = useAction(locale);
  const [rows, setRows] = useState<SearchRow[]>(initial);
  const [offset, setOffset] = useState<number | null>(nextOffset);

  const loadMore = () =>
    run(
      () => loadMoreSearchAction({ workspaceId, query, offset: offset ?? 0 }),
      {
        onSuccess: (result) => {
          if (!("results" in result)) return;
          setRows((current) => [...current, ...result.results]);
          setOffset(result.nextOffset);
        },
      },
    );

  return (
    <>
      <p className="mt-4 text-sm text-muted">
        {rows.length} result{rows.length === 1 ? "" : "s"} for “{query}”
      </p>

      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {rows.map((page) => (
          <li key={page.id}>
            <Link
              href={`/w/${slug}/${page.id}`}
              className="block px-4 py-3 hover:bg-surface-2"
            >
              <p className="flex items-center gap-2 text-sm font-medium">
                <span>{page.icon ?? (page.type === "DATABASE" ? "🗂️" : "📄")}</span>
                {page.title || "Untitled"}
              </p>
              {page.snippet && <p className="mt-1 text-sm text-muted">{page.snippet}</p>}
            </Link>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted">
            {t(locale, "noResults")}
          </li>
        )}
      </ul>

      {offset !== null && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={loadMore}
            className="h-8 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            {t(locale, "loadMore")}
          </button>
          {error && (
            <span role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
        </div>
      )}
    </>
  );
}

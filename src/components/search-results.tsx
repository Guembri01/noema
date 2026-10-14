"use client";

import { useState } from "react";
import Link from "next/link";
import { loadMoreSearchAction } from "@/server/actions/search";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { highlightSnippet } from "@/lib/fuzzy";
import {
  DEFAULT_SUMMARY_LENGTH,
  extractDescription,
  summarizeBlocks,
  truncateAtWord,
  type SummaryBlock,
} from "@/lib/page-summary";

export type SearchRow = {
  id: string;
  title: string;
  icon: string | null;
  type: string;
  snippet: string;
  /** Stored page blocks, when the caller has them: the preferred teaser source. */
  blocks?: readonly SummaryBlock[];
};

/**
 * Plain-text teaser for one result (MISSING_FEATURES §1). Prefers a page's
 * stored blocks via `summarizeBlocks`; search results normally only carry a
 * plain-text snippet, so as a fallback the snippet is read as a paragraph with
 * `extractDescription` and truncated at a word boundary. Pure and total.
 */
function pageTeaser(
  content: { snippet?: string; blocks?: readonly SummaryBlock[] },
  maxLength: number,
): string {
  if (content.blocks && content.blocks.length > 0) {
    const summary = summarizeBlocks(content.blocks, { maxLength });
    if (summary) return summary;
  }
  const snippet = content.snippet ?? "";
  if (!snippet) return "";
  const described = extractDescription([{ type: "paragraph", text: snippet }]);
  return truncateAtWord(described ?? snippet, maxLength);
}

/**
 * Teaser text with the search term emphasised. Reuses the shared
 * `highlightSnippet` (read-only) so search-term highlighting stays consistent;
 * when the query is empty or not present in the text, plain text is rendered.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const match = highlightSnippet(text, query, text.length);
  if (!match) return <>{text}</>;
  const { text: excerpt, matchStart, matchEnd } = match;
  return (
    <>
      {excerpt.slice(0, matchStart)}
      <mark className="rounded-sm bg-accent/20 text-inherit">
        {excerpt.slice(matchStart, matchEnd)}
      </mark>
      {excerpt.slice(matchEnd)}
    </>
  );
}

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
  previewLength = DEFAULT_SUMMARY_LENGTH,
}: {
  workspaceId: string;
  slug: string;
  query: string;
  initial: SearchRow[];
  nextOffset: number | null;
  locale: string;
  /** Longest teaser shown per result, including the trailing ellipsis. */
  previewLength?: number;
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
        {rows.map((page) => {
          const teaser = pageTeaser(page, previewLength);
          return (
            <li key={page.id}>
              <Link
                href={`/w/${slug}/${page.id}`}
                className="block px-4 py-3 hover:bg-surface-2"
              >
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span>{page.icon ?? (page.type === "DATABASE" ? "🗂️" : "📄")}</span>
                  {page.title || "Untitled"}
                </p>
                {teaser && (
                  <p className="mt-1 text-sm text-muted">
                    <HighlightedText text={teaser} query={query} />
                  </p>
                )}
              </Link>
            </li>
          );
        })}
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

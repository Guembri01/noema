"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { loadMoreSearchAction } from "@/server/actions/search";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { highlightSnippet } from "@/lib/fuzzy";
import { buildIndex, rank } from "@/lib/search-ranking";
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
 * Plain-text teaser for one result (MISSING_FEATURES §1). Prefers the page's
 * real content via `summarizeBlocks` (fed by the search query as `blocks`).
 * The match-centred `snippet` stays a fallback: when the page carries no usable
 * content, or the derived teaser would not show the query (it matched deeper in
 * the page than the teaser reaches), the snippet is read as a paragraph with
 * `extractDescription` and truncated at a word boundary. Pure and total.
 */
function pageTeaser(
  content: { snippet?: string; blocks?: readonly SummaryBlock[] },
  maxLength: number,
  query: string,
): string {
  const fromSnippet = (): string => {
    const snippet = content.snippet ?? "";
    if (!snippet) return "";
    const described = extractDescription([{ type: "paragraph", text: snippet }]);
    return truncateAtWord(described ?? snippet, maxLength);
  };

  if (content.blocks && content.blocks.length > 0) {
    const summary = summarizeBlocks(content.blocks, { maxLength });
    if (summary) {
      const term = query.trim();
      if (!term || highlightSnippet(summary, query, summary.length)) return summary;
      // Prefer the real content, but never hide why the page matched: fall back
      // to the centred snippet when it can surface the highlight instead.
      return fromSnippet() || summary;
    }
  }
  return fromSnippet();
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
 * How strongly a title hit outranks an equally frequent body hit when the
 * merged list is re-ranked below. Matches the server page's refinement pass so
 * the order a result lands in does not depend on which window carried it.
 */
const SEARCH_TITLE_WEIGHT = 3;

/**
 * Order search rows by the shared BM25 scorer (`search-ranking.ts`), weighting
 * title matches, so the initial window and every appended "Load more" window
 * are ranked as one corpus rather than the first window alone. Additive and
 * lossless: rows the scorer does not recognise (prefix and substring-fallback
 * hits, whose terms fold differently) keep their arrival order and follow the
 * scored rows, and a stable sort leaves that order intact for remaining ties.
 */
function orderByRelevance<T extends { id: string; title: string; snippet: string }>(
  rows: readonly T[],
  query: string,
): T[] {
  if (rows.length <= 1) return [...rows];
  const index = buildIndex(
    rows.map((row) => ({
      id: row.id,
      fields: { title: row.title, body: row.snippet },
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

/**
 * The search results list, with a keyset "Load more" that appends the next
 * window instead of re-running the query. The merged initial + appended rows
 * are re-ranked together, so relevance order stays consistent as more pages
 * load rather than pinning later windows below the first.
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
  // Rank the whole merged set (initial + appended) so ordering is stable as
  // pages load; `rows` keeps arrival order underneath for lossless ties.
  const orderedRows = useMemo(() => orderByRelevance(rows, query), [rows, query]);

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
        {orderedRows.map((page) => {
          const teaser = pageTeaser(page, previewLength, query);
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

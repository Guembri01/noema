"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { loadMoreSearchAction } from "@/server/actions/search";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { highlightSnippet } from "@/lib/fuzzy";
import { refineByRelevance } from "@/lib/search-ranking";
import { offsetForIndex, totalHeight, visibleRange } from "@/lib/virtual-list";
import {
  DEFAULT_SUMMARY_LENGTH,
  extractDescription,
  summarizeBlocks,
  truncateAtWord,
  type SummaryBlock,
} from "@/lib/page-summary";

/*
 * Windowed mode geometry. The list pages without bound ("Load more"), so past
 * VIRTUAL_THRESHOLD rows we mount only the slice in view inside a fixed-height
 * scroller, using src/lib/virtual-list (visibleRange/totalHeight/offsetForIndex)
 * for the math. Rows stay real <li>s, absolutely positioned at their true
 * offset over a spacer <ul> carrying totalHeight, so list semantics, teasers and
 * the load-more flow are unchanged.
 *
 * Unlike the trash rows (uniform by design), a result's height depends on its
 * teaser: a row with none is a single title line, a row with one wraps to
 * several. A single constant stride would therefore overlap the rows below it,
 * so we size each row from its teaser via `heightOf`. The estimate is biased
 * tall — the slack shows up as a small gap, never as hidden content.
 */
/** Row with no teaser: `py-3` padding + one `text-sm` title line. */
const ROW_BASE_HEIGHT = 44;
/** A teaser adds its `mt-1` gap plus one `text-sm` line per estimated line. */
const TEASER_LINE_HEIGHT = 24;
/** Assumed characters per teaser line; kept low on purpose so the estimate runs tall. */
const TEASER_CHARS_PER_LINE = 64;
/** Cap on estimated teaser lines, so a pathological teaser cannot reserve the viewport. */
const MAX_TEASER_LINES = 6;
/** Height of the windowed scroll viewport. */
const VIEWPORT_HEIGHT = 480;
/** Rows rendered beyond the viewport on each side to hide fast-scroll gaps. */
const OVERSCAN = 4;
/** Above this many rows the list switches to windowed rendering. */
const VIRTUAL_THRESHOLD = 40;

/** Estimated rendered height of one result row, from its (possibly empty) teaser. */
function heightFromTeaser(teaser: string): number {
  if (!teaser) return ROW_BASE_HEIGHT;
  const lines = Math.min(
    MAX_TEASER_LINES,
    Math.max(1, Math.ceil(teaser.length / TEASER_CHARS_PER_LINE)),
  );
  return ROW_BASE_HEIGHT + TEASER_LINE_HEIGHT * lines;
}

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
 * The search results list, with a keyset "Load more" that appends the next
 * window instead of re-running the query. The merged initial + appended rows
 * are re-ranked together (so relevance order stays consistent as more pages
 * load), and long result sets are windowed with `virtual-list` geometry.
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
  // Top of the windowed scroller; only read when the list is windowed.
  const [scrollTop, setScrollTop] = useState(0);

  // Rank the whole merged set (initial + appended) so ordering is stable as
  // pages load; `rows` keeps arrival order underneath for lossless ties.
  const orderedRows = useMemo(
    () =>
      refineByRelevance(rows, query, {
        titleWeight: SEARCH_TITLE_WEIGHT,
        getBody: (row) => row.snippet,
      }),
    [rows, query],
  );

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

  // One teaser per row, computed once: it both renders the row and sizes it.
  // Computed over the ranked order so windowing and rendering agree.
  const teasers = orderedRows.map((row) => pageTeaser(row, previewLength, query));
  const heightOf = (index: number) => heightFromTeaser(teasers[index] ?? "");

  // Long lists mount only the visible slice; short lists keep the plain <ul>.
  const windowed = orderedRows.length > VIRTUAL_THRESHOLD;
  const range = windowed
    ? visibleRange({
        scrollTop,
        viewportSize: VIEWPORT_HEIGHT,
        itemHeight: ROW_BASE_HEIGHT,
        itemCount: orderedRows.length,
        overscan: OVERSCAN,
        heightOf,
      })
    : { start: 0, end: 0 };
  const visible = windowed ? orderedRows.slice(range.start, range.end) : orderedRows;

  // Shared row body so the plain and windowed lists stay byte-identical in what
  // they render (only the positioning wrapper differs).
  const resultBody = (page: SearchRow, teaser: string) => (
    <Link href={`/w/${slug}/${page.id}`} className="block px-4 py-3 hover:bg-surface-2">
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
  );

  return (
    <>
      <p className="mt-4 text-sm text-muted">
        {rows.length} result{rows.length === 1 ? "" : "s"} for “{query}”
      </p>

      {windowed ? (
        <div
          role="region"
          aria-label="Search results"
          tabIndex={0}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className="mt-4 overflow-y-auto rounded-lg border border-border"
          style={{ height: VIEWPORT_HEIGHT }}
        >
          <ul
            className="relative"
            style={{ height: totalHeight(orderedRows.length, ROW_BASE_HEIGHT, heightOf) }}
          >
            {visible.map((page, offsetInWindow) => {
              const index = range.start + offsetInWindow;
              return (
                <li
                  key={page.id}
                  // Absolute rows stacked at their true offset: the spacer <ul>
                  // carries the full height so the scrollbar matches the list.
                  className="absolute inset-x-0 border-b border-border"
                  style={{ top: offsetForIndex(index, ROW_BASE_HEIGHT, heightOf) }}
                >
                  {resultBody(page, teasers[index] ?? "")}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {orderedRows.map((page, index) => (
            <li key={page.id}>{resultBody(page, teasers[index] ?? "")}</li>
          ))}
          {orderedRows.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted">
              {t(locale, "noResults")}
            </li>
          )}
        </ul>
      )}

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

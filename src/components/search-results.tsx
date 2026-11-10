"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { loadMoreSearchAction } from "@/server/actions/search";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { highlightSnippet } from "@/lib/fuzzy";
import { nextIndex, rovingTabIndex } from "@/lib/keyboard-nav";
import { refineByRelevance } from "@/lib/search-ranking";
import { scrollToIndex } from "@/lib/virtual-list";
import { cn } from "@/lib/utils";
import { type TagHue } from "@/lib/design-tokens";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Tag } from "@/components/ui/tag";
import { VirtualList } from "@/components/ui/virtual-list";
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
 * scroller through the shared `VirtualList` primitive (`ui/virtual-list`), which
 * wraps src/lib/virtual-list (visibleRange/totalHeight/offsetForIndex) for the
 * math. Rows stay real <li>s, absolutely positioned at their true offset over a
 * spacer <ul> carrying totalHeight, so list semantics, teasers and the load-more
 * flow are unchanged.
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

/**
 * Result types the page search can return, in chip order. Mirrors the engine's
 * `PageType` (PAGE | DATABASE): `searchPages` only indexes `Page` rows, so
 * tickets — a separate model with its own search — are never results here.
 */
export const SEARCH_RESULT_TYPES = ["PAGE", "DATABASE"] as const;

/** Chip label for a result type; matches the Library page's section wording. */
export function resultTypeLabel(type: string): string {
  if (type === "PAGE") return "Pages";
  if (type === "DATABASE") return "Databases";
  return type;
}

/**
 * Tag hue for a result type, so the filter chips read from the shared tag
 * palette. Unknown types fall back to `gray` (the same fallback `tagClass`
 * applies), so a new engine type can never render an unstyled chip. Pure.
 */
const RESULT_TYPE_HUES: Record<string, TagHue> = {
  PAGE: "blue",
  DATABASE: "purple",
};

export function resultTypeHue(type: string): TagHue {
  return RESULT_TYPE_HUES[type] ?? "gray";
}

/** Estimated rendered height of one result row, from its (possibly empty) teaser. */
export function heightFromTeaser(teaser: string): number {
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
 * Append one "Load more" window to the loaded rows, dropping rows whose id is
 * already present. The Load more button is disabled while the action is
 * pending (`ui/button`), but before that re-render commits a fast double
 * click can fire the action twice at the same offset — two successful pages
 * would otherwise append the same ids twice. Mirrors the workspace view's
 * id-deduped row append (`database-view`'s "Load more"): one `Set` of the
 * ids already in the list, incoming filtered by `.id`. Pure and total.
 */
export function appendResultRows(
  current: readonly SearchRow[],
  incoming: readonly SearchRow[],
): SearchRow[] {
  const seen = new Set(current.map((row) => row.id));
  return [...current, ...incoming.filter((row) => !seen.has(row.id))];
}

/**
 * Plain-text teaser for one result (MISSING_FEATURES §1). Prefers the page's
 * real content via `summarizeBlocks` (fed by the search query as `blocks`).
 * The match-centred `snippet` stays a fallback: when the page carries no usable
 * content, or the derived teaser would not show the query (it matched deeper in
 * the page than the teaser reaches), the snippet is read as a paragraph with
 * `extractDescription` and truncated at a word boundary. Pure and total.
 */
export function pageTeaser(
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
  if (!match) return <bdi>{text}</bdi>;
  const { text: excerpt, matchStart, matchEnd } = match;
  return (
    <bdi>
      {excerpt.slice(0, matchStart)}
      <mark className="rounded-xs bg-highlight px-0.5 text-highlight-fg">
        {excerpt.slice(matchStart, matchEnd)}
      </mark>
      {excerpt.slice(matchEnd)}
    </bdi>
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
  types = SEARCH_RESULT_TYPES,
}: {
  workspaceId: string;
  slug: string;
  query: string;
  initial: SearchRow[];
  nextOffset: number | null;
  locale: string;
  /** Longest teaser shown per result, including the trailing ellipsis. */
  previewLength?: number;
  /**
   * Result types offered as filter chips (the `row.type` values to match).
   * Defaults to every type the page search can return; a caller may narrow the
   * set to the types it knows are present.
   */
  types?: readonly string[];
}) {
  const { run, pending, error } = useAction(locale);
  const [rows, setRows] = useState<SearchRow[]>(initial);
  const [offset, setOffset] = useState<number | null>(nextOffset);
  // Top of the windowed scroller; only read when the list is windowed.
  const [scrollTop, setScrollTop] = useState(0);
  // Roving focus over the result links (§11 Search keyboard nav, R78.10): one
  // row carries `tabIndex=0`, and ↑/↓ (plus Home/End) move both the cursor and
  // the real DOM focus, so the ring tracks the row and Enter opens it natively.
  // `rowRefs` maps a row index to its anchor so a move can focus it.
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef(new Map<number, HTMLAnchorElement>());
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // A row selected while windowed may not be mounted yet: remember it and focus
  // once the re-render (driven by the scroll adjustment below) mounts it.
  const pendingFocus = useRef<number | null>(null);

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

  // Result-type filter (client-side): every selectable type starts on; a chip
  // toggle narrows the rendered rows only. Ranking and pagination are untouched,
  // so "Load more" still appends the engine's next window underneath.
  const [selectedTypes, setSelectedTypes] = useState<readonly string[]>(() => [...types]);
  const filteredRows = useMemo(
    () => orderedRows.filter((row) => selectedTypes.includes(row.type)),
    [orderedRows, selectedTypes],
  );
  const toggleType = (type: string) =>
    setSelectedTypes((current) =>
      current.includes(type)
        ? current.filter((candidate) => candidate !== type)
        : [...current, type],
    );

  const loadMore = () =>
    run(
      () => loadMoreSearchAction({ workspaceId, query, offset: offset ?? 0 }),
      {
        onSuccess: (result) => {
          if (!("results" in result)) return;
          // Id-deduped append: see `appendResultRows` for the double-click
          // window this closes (disable commits are one render too slow).
          setRows((current) => appendResultRows(current, result.results));
          setOffset(result.nextOffset);
        },
      },
    );

  // One teaser per row, computed once: it both renders the row and sizes it.
  // Computed over the filtered ranked order so windowing and rendering agree.
  const teasers = filteredRows.map((row) => pageTeaser(row, previewLength, query));
  const heightOf = (index: number) => heightFromTeaser(teasers[index] ?? "");

  // Long lists mount only the visible slice; short lists keep the plain <ul>.
  const windowed = filteredRows.length > VIRTUAL_THRESHOLD;
  // The single tab stop of the roving model; `-1` (no row focusable) when empty.
  const activeRow = rovingTabIndex(activeIndex, filteredRows.length);

  // Focus a row that a move requested while windowed, once it is mounted.
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const element = rowRefs.current.get(index);
    if (!element) return;
    element.focus();
    pendingFocus.current = null;
  }, [activeIndex, scrollTop, filteredRows.length, windowed]);

  // Move the roving cursor to `next`, scrolling a windowed row into the window
  // and focusing its link so the visible ring follows the cursor.
  const moveTo = (next: number) => {
    setActiveIndex(next);
    if (!windowed) {
      rowRefs.current.get(next)?.focus();
      return;
    }
    const container = scrollerRef.current;
    if (container) {
      const top = scrollToIndex(next, {
        itemHeight: ROW_BASE_HEIGHT,
        itemCount: filteredRows.length,
        viewportSize: VIEWPORT_HEIGHT,
        scrollTop: container.scrollTop,
        heightOf,
        align: "nearest",
      });
      if (top !== container.scrollTop) container.scrollTop = top;
      setScrollTop(top);
    }
    pendingFocus.current = next;
  };

  // Keyboard nav for the result list (R78.10): ↑/↓/Home/End move the ring,
  // Enter opens the focused row, Esc hands focus back to the search field. A
  // focused <Link> already activates on Enter, so Enter is only intercepted
  // when the list region itself holds focus. The field lives in the page (out
  // of this component's tree), so Esc restores it by name.
  const onListKeyDown = (event: React.KeyboardEvent) => {
    const count = filteredRows.length;
    const { key } = event;
    if (key === "Escape") {
      const input = document.querySelector<HTMLInputElement>('input[name="q"]');
      if (input) {
        event.preventDefault();
        input.focus();
      }
      return;
    }
    if (key === "Enter") {
      if ((event.target as HTMLElement).closest("a")) return;
      const element = rowRefs.current.get(activeRow);
      if (element) {
        event.preventDefault();
        element.click();
      }
      return;
    }
    if (count === 0) return;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      event.preventDefault();
      moveTo(nextIndex(activeRow, { key, count }));
    }
  };

  // Shared row body so the plain and windowed lists stay byte-identical in what
  // they render (only the positioning wrapper differs). The active row carries
  // the `--accent-soft` tint so the keyboard cursor is visible without hover;
  // the shared `.focus-ring` tracks DOM focus.
  const resultBody = (page: SearchRow, teaser: string, index: number) => (
    <Link
      href={`/w/${slug}/${page.id}`}
      ref={(element) => {
        if (element) rowRefs.current.set(index, element);
        else rowRefs.current.delete(index);
      }}
      tabIndex={index === activeRow ? 0 : -1}
      data-active={index === activeRow ? "true" : undefined}
      onFocus={() => setActiveIndex(index)}
      className={cn(
        "block px-4 py-3 u-colors focus-ring",
        index === activeRow ? "bg-surface-2" : "hover:bg-surface-2",
      )}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <span>{page.icon ?? (page.type === "DATABASE" ? "🗂️" : "📄")}</span>
        <HighlightedText text={page.title || "Untitled"} query={query} />
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
        {filteredRows.length} result{filteredRows.length === 1 ? "" : "s"} for “<bdi>{query}</bdi>”
      </p>

      {types.length > 1 && (
        <div
          role="group"
          aria-label={t(locale, "filterResultsByType")}
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          {types.map((type) => (
            <Tag
              key={type}
              hue={resultTypeHue(type)}
              size="md"
              selected={selectedTypes.includes(type)}
              onSelectedChange={() => toggleType(type)}
            >
              {resultTypeLabel(type)}
            </Tag>
          ))}
        </div>
      )}

      {filteredRows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border">
          <EmptyState
            variant="compact"
            icon={<SearchX className="h-4 w-4" aria-hidden />}
            title={t(locale, "noResults")}
            description="Try a different search or clear the type filters."
          />
        </div>
      ) : windowed ? (
        <VirtualList
          items={filteredRows}
          scrollTop={scrollTop}
          onScrollTopChange={setScrollTop}
          viewportHeight={VIEWPORT_HEIGHT}
          itemHeight={ROW_BASE_HEIGHT}
          heightOf={heightOf}
          overscan={OVERSCAN}
          getKey={(page) => page.id}
          renderItem={(page, index) => resultBody(page, teasers[index] ?? "", index)}
          scrollerRef={scrollerRef}
          scrollerProps={{
            role: "region",
            "aria-label": t(locale, "searchResults"),
            tabIndex: -1,
            onKeyDown: onListKeyDown,
          }}
          className="mt-4 overflow-y-auto rounded-lg border border-border"
          rowClassName="absolute inset-x-0 border-b border-border"
        />
      ) : (
        <ul
          onKeyDown={onListKeyDown}
          className="mt-4 divide-y divide-border rounded-lg border border-border"
        >
          {filteredRows.map((page, index) => (
            <li key={page.id}>{resultBody(page, teasers[index] ?? "", index)}</li>
          ))}
        </ul>
      )}

      {offset !== null && (
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={pending}
            onClick={loadMore}
          >
            {t(locale, "loadMore")}
          </Button>
          {error && (
            <span role="alert" className="text-sm text-danger">
              {error}
            </span>
          )}
        </div>
      )}
    </>
  );
}

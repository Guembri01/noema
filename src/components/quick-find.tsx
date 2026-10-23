"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Plus, Search } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  highlightRanges,
  moveActiveIndex,
} from "@/components/command-palette";
import {
  quickFindAction,
  type QuickFindResult,
} from "@/server/actions/search";
import { createPageAction } from "@/server/actions/pages";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { highlightSnippet } from "@/lib/fuzzy";
import { rovingTabIndex } from "@/lib/keyboard-nav";
import { refineByRelevance } from "@/lib/search-ranking";
import {
  DEFAULT_SUMMARY_LENGTH,
  extractDescription,
  summarizeBlocks,
  truncateAtWord,
  type SummaryBlock,
} from "@/lib/page-summary";

/**
 * Quick find (B43 / DS18): a debounced server search rendered as a premium
 * launcher — icon + muted breadcrumb + highlighted title per page row, recent
 * pages first, wrapped keyboard selection, and a "showing N of M" footer when
 * the list is capped.
 *
 * - **Search** stays server-side (`quickFindAction`), then an additive,
 *   lossless in-memory BM25 re-rank (`search-ranking.ts`, title-weighted) lifts
 *   title hits without dropping any server hit.
 * - **Recents first** — the last opened pages are remembered locally
 *   ({@link rememberVisit}) and shown on an empty query, and promoted to the
 *   top of a search ({@link orderRowsByRecents}).
 * - **Keyboard** — the input keeps focus while the shared
 *   `src/lib/keyboard-nav.ts` + {@link moveActiveIndex} helpers drive ↑↓
 *   (wrapping), Home/End and PageUp/PageDown over the flat row order.
 * - **a11y** — `role="dialog"` + `aria-modal` + focus restore come from
 *   `src/components/ui/dialog.tsx`; the input is labelled and carries
 *   `aria-activedescendant` for the active row, and a polite live region
 *   announces the result count.
 * - **Motion** — opens with `animate-rise`, the list scrolls with
 *   `.scrollbar-thin`, and the active row uses `--accent-soft`.
 */

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

/**
 * Strings the i18n catalogue does not yet carry, kept as complete sentences
 * with `{placeholder}` slots so they can be lifted into `src/lib/i18n.ts`
 * verbatim (see the follow-up note).
 */
export const QUICK_FIND_COPY = {
  databases: "Databases",
  results: "{n} results",
  showing: "Showing {shown} of {total}",
} as const;

/** Stable cmdk-free option id for the flat row list. */
const optionId = (index: number) => `quick-find-option-${index}`;

/**
 * How strongly a title hit outranks an equally frequent body hit in the shared
 * refinement below. Above `1` so the page name the user typed surfaces first,
 * matching the search page's and API's own BM25 refinement.
 */
const QUICK_FIND_TITLE_WEIGHT = 3;

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

/**
 * A row, optionally carrying its ancestors so the breadcrumb can render a real
 * path. The server action does not send `parents` today; the field is optional
 * so this component lights up the moment it does (see the change notes).
 */
export type QuickFindRow = QuickFindResult & {
  parents?: { id: string; title: string }[];
};

/** A locally remembered page visit (richer than `recent-pages.ts`, which keeps ids only). */
export type QuickFindRecent = {
  id: string;
  title: string;
  icon: string | null;
  type: string;
  snippet: string;
  at: number;
};

/** How many recent pages quick find remembers per workspace. */
export const MAX_QUICK_FIND_RECENTS = 6;

/** Default cap on rendered page rows (excluding the "create" row). */
export const DEFAULT_QUICK_FIND_MAX_RESULTS = 6;

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested in `quick-find.test.ts`)
 * ------------------------------------------------------------------ */

/**
 * Record a visit and return a most-recent-first, de-duplicated, capped list.
 * A blank id is ignored (the list is still copied); a non-finite `now` is
 * coerced to `0`; the input list is never mutated.
 */
export function rememberVisit(
  list: readonly QuickFindRecent[] | null | undefined,
  row: { id: string; title: string; icon?: string | null; type: string; snippet?: string },
  now: number,
  limit: number = MAX_QUICK_FIND_RECENTS,
): QuickFindRecent[] {
  const source = Array.isArray(list) ? list : [];
  const cleaned = source.filter(
    (entry) => entry && typeof entry.id === "string" && entry.id.trim() !== "",
  );
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return cleaned;

  const next: QuickFindRecent = {
    id,
    title: row.title,
    icon: row.icon ?? null,
    type: row.type,
    snippet: row.snippet ?? "",
    at: Number.isFinite(now) ? now : 0,
  };
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : cleaned.length;
  return [next, ...cleaned.filter((entry) => entry.id !== id)].slice(0, cap);
}

/** Page id → recency rank (0 = most recent), for {@link orderRowsByRecents}. */
export function recentOrder(list: readonly QuickFindRecent[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const [index, entry] of (Array.isArray(list) ? list : []).entries()) {
    if (entry && typeof entry.id === "string" && !order.has(entry.id)) {
      order.set(entry.id, index);
    }
  }
  return order;
}

/**
 * Promote recent rows ahead of the rest, preserving the recency order and
 * leaving every non-recent row in its incoming relative order. Pure and stable;
 * rows whose id is absent from `rank` keep their position behind the promoted
 * ones.
 */
export function orderRowsByRecents<T extends { id: string }>(
  rows: readonly T[],
  rank: ReadonlyMap<string, number>,
): T[] {
  if (rank.size === 0) return [...rows];
  const promoted = rows
    .filter((row) => rank.has(row.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  if (promoted.length === 0) return [...rows];
  const promotedIds = new Set(promoted.map((row) => row.id));
  return [...promoted, ...rows.filter((row) => !promotedIds.has(row.id))];
}

/**
 * The muted breadcrumb above a row's title: the workspace, then real ancestor
 * titles when the search layer supplies them, otherwise the row type as a
 * single fallback segment (so a lone page still shows a path).
 */
export function resultBreadcrumb(
  row: QuickFindRow,
  workspaceSlug: string,
  locale: string,
): string[] {
  const parents = (row.parents ?? [])
    .map((parent) => (parent.title ?? "").trim() || t(locale, "untitled"))
    .filter(Boolean);
  if (parents.length > 0) return [workspaceSlug, ...parents];
  const typeLabel =
    row.type === "DATABASE" ? QUICK_FIND_COPY.databases : t(locale, "pages");
  return [workspaceSlug, typeLabel];
}

/**
 * The capped-list footer, or `null` when every result is already shown. The
 * copy is a single template with `{shown}` / `{total}` slots.
 */
export function showingFooter(shown: number, total: number): string | null {
  if (!Number.isFinite(total) || total <= shown) return null;
  return QUICK_FIND_COPY.showing
    .replace("{shown}", String(Math.max(0, shown)))
    .replace("{total}", String(total));
}

/** Map a remembered visit back to a renderable row. */
export function recentToRow(entry: QuickFindRecent): QuickFindRow {
  return {
    id: entry.id,
    title: entry.title,
    icon: entry.icon,
    type: entry.type,
    snippet: entry.snippet,
  };
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/** localStorage key holding this workspace's recently opened pages. */
function recentStorageKey(workspaceSlug: string): string {
  return `noema:quick-find:recent:${workspaceSlug}`;
}

/** Read the persisted recents, tolerating corrupt JSON / disabled storage. */
export function loadRecents(storageKey: string): QuickFindRecent[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    return [];
  }
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: QuickFindRecent[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Partial<QuickFindRecent>;
      if (typeof record.id !== "string" || typeof record.title !== "string") continue;
      entries.push({
        id: record.id,
        title: record.title,
        icon: typeof record.icon === "string" ? record.icon : null,
        type: typeof record.type === "string" ? record.type : "PAGE",
        snippet: typeof record.snippet === "string" ? record.snippet : "",
        at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0,
      });
    }
    return entries.slice(0, MAX_QUICK_FIND_RECENTS);
  } catch {
    return [];
  }
}

/** Persist the recents, tolerating private mode / disabled storage. */
function saveRecents(storageKey: string, list: readonly QuickFindRecent[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(list));
  } catch {
    // No storage — the in-memory list still ranks this session.
  }
}

/* ------------------------------------------------------------------ *
 * Rendering helpers
 * ------------------------------------------------------------------ */

/**
 * Plain-text teaser for one quick-find row (MISSING_FEATURES §1): stored blocks
 * via `summarizeBlocks` when available, otherwise the result's snippet read as a
 * paragraph through `extractDescription` and truncated at a word boundary.
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

/** Title text with the *matched characters* emphasised (merged fuzzy ranges). */
function HighlightedTitle({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <mark key={index} className="rounded-xs bg-highlight px-0.5 text-highlight-fg">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/** Teaser text with the active query highlighted via the shared `highlightSnippet`. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const match = highlightSnippet(text, query, text.length);
  if (!match) return <>{text}</>;
  const { text: excerpt, matchStart, matchEnd } = match;
  return (
    <>
      {excerpt.slice(0, matchStart)}
      <mark className="rounded-xs bg-highlight px-0.5 text-highlight-fg">
        {excerpt.slice(matchStart, matchEnd)}
      </mark>
      {excerpt.slice(matchEnd)}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function QuickFind({
  open,
  onOpenChange,
  workspaceId,
  workspaceSlug,
  locale,
  previewLength = DEFAULT_SUMMARY_LENGTH,
  maxResults = DEFAULT_QUICK_FIND_MAX_RESULTS,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceSlug: string;
  locale: string;
  /** Longest teaser shown per result, including the trailing ellipsis. */
  previewLength?: number;
  /** Most page rows rendered before the "showing N of M" footer appears. */
  maxResults?: number;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<QuickFindRow[]>([]);
  const [recents, setRecents] = useState<QuickFindRecent[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, startTransition] = useTransition();
  const listRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recents are restored on mount (not during render) so the first client
  // paint matches the server HTML.
  const recentKey = recentStorageKey(workspaceSlug);
  useEffect(() => {
    setRecents(loadRecents(recentKey));
  }, [recentKey]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setItems([]);
      setActiveIndex(0);
    }
  }, [open]);

  // Debounced server search. An empty query is served from the local recents,
  // so no request goes out.
  useEffect(() => {
    if (!open) return;
    if (query.trim() === "") {
      setItems((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      startTransition(async () => {
        const results = await quickFindAction(workspaceId, query);
        if ("error" in results) {
          toast.error(results.error);
          return;
        }
        setItems(results);
      });
    }, 180);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, open, workspaceId]);

  const cap = Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : Infinity;
  const recentRank = useMemo(() => recentOrder(recents), [recents]);

  // BM25 refinement (title-weighted) + "recents first" promotion; an empty
  // query shows the recents themselves.
  const orderedRows = useMemo<QuickFindRow[]>(() => {
    if (query.trim() === "") return recents.map(recentToRow);
    const refined = refineByRelevance(items, query, {
      titleWeight: QUICK_FIND_TITLE_WEIGHT,
      getBody: (row) => row.snippet,
    });
    return orderRowsByRecents(refined, recentRank);
  }, [items, recents, query, recentRank]);

  const shown = orderedRows.slice(0, cap === Infinity ? orderedRows.length : cap);
  // Row 0 is the always-present "create" action; page rows follow.
  const rowCount = shown.length + 1;
  const active = rovingTabIndex(activeIndex, rowCount);
  const footer = showingFooter(shown.length, orderedRows.length);
  const announcement = loading
    ? t(locale, "searching")
    : QUICK_FIND_COPY.results.replace("{n}", String(orderedRows.length));

  useEffect(() => {
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(active))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const go = (row: QuickFindRow) => {
    onOpenChange(false);
    const next = rememberVisit(recents, row, Date.now());
    setRecents(next);
    saveRecents(recentKey, next);
    router.push(`/w/${workspaceSlug}/${row.id}`);
  };

  const createNew = () => {
    onOpenChange(false);
    startTransition(async () => {
      const result = await createPageAction({ workspaceId, parentId: null });

      if ("ok" in result) {
        router.push(`/w/${workspaceSlug}/${result.id}`);
        router.refresh();
      }
    });
  };

  // Arrow/Home/End (wrapping) and PageUp/PageDown (one screenful, clamped) move
  // the controlled selection through the flat row order.
  const onListKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Leave IME composition alone.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const count = rowCount;
    if (count <= 0) return;
    const { key } = event;
    if (
      key === "ArrowDown" ||
      key === "ArrowUp" ||
      key === "Home" ||
      key === "End" ||
      key === "PageDown" ||
      key === "PageUp"
    ) {
      event.preventDefault();
      setActiveIndex(moveActiveIndex(active, key, count));
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      if (active === 0) createNew();
      else go(shown[active - 1]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label={t(locale, "quickFind")} className="overflow-hidden p-0">
        <div className="flex animate-rise max-h-[420px] flex-col">
          <div className="noema-search-field u-colors flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onListKeyDown}
              role="combobox"
              aria-expanded
              aria-controls="quick-find-list"
              aria-activedescendant={optionId(active)}
              aria-label={t(locale, "quickFindPlaceholder")}
              placeholder={t(locale, "quickFindPlaceholder")}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
          </div>

          <div className="sr-only" role="status" aria-live="polite">
            {announcement}
          </div>

          <div
            ref={listRef}
            id="quick-find-list"
            role="listbox"
            aria-label={t(locale, "quickFind")}
            className="scrollbar-thin overflow-y-auto py-1"
          >
            <div
              id={optionId(0)}
              role="option"
              aria-selected={active === 0}
              onMouseEnter={() => setActiveIndex(0)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={createNew}
              className={cn(
                "u-colors flex h-9 cursor-pointer items-center gap-2 rounded-control px-2 text-sm",
                active !== 0 && "hover:bg-surface-2",
                active === 0 && "bg-surface-2",
              )}
            >
              <Plus className="h-4 w-4 text-muted" />
              {t(locale, "createNewPage")}
            </div>

            {shown.length === 0 && query.trim() !== "" && (
              <div className="px-3 py-6 text-center text-sm text-muted">
                {loading ? t(locale, "searching") : t(locale, "noResultsDot")}
              </div>
            )}

            {shown.map((row, index) => {
              const flatIndex = index + 1;
              const isActive = flatIndex === active;
              const teaser = pageTeaser(row, previewLength);
              const breadcrumb = resultBreadcrumb(row, workspaceSlug, locale).join(" › ");
              return (
                <div
                  key={row.id}
                  id={optionId(flatIndex)}
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActiveIndex(flatIndex)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => go(row)}
                  className={cn(
                    "u-colors flex cursor-pointer items-start gap-2 rounded-control px-2 py-2 text-sm",
                    !isActive && "hover:bg-surface-2",
                    isActive && "bg-surface-2",
                  )}
                >
                  <span className="mt-0.5 w-4 shrink-0 text-center">
                    {row.icon ?? (row.type === "DATABASE" ? "🗂️" : "📄")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-muted">{breadcrumb}</span>
                    <span className="block truncate font-medium">
                      <HighlightedTitle text={row.title} query={query} />
                    </span>
                    {teaser && (
                      <span className="block truncate text-xs text-muted">
                        <HighlightedText text={teaser} query={query} />
                      </span>
                    )}
                  </span>
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                </div>
              );
            })}
          </div>

          {footer && (
            <div className="border-t border-border px-3 py-2 text-xs text-muted">{footer}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

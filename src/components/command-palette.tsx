"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Monitor, Moon, PanelLeft, Plus, Search, Sun } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  filterByType,
  fuzzyFilter,
  highlightSnippet,
  parseTypeScope,
  type SearchType,
} from "@/lib/fuzzy";
import {
  nextIndex,
  pageStepIndex,
  rovingTabIndex,
  typeaheadIndex,
} from "@/lib/keyboard-nav";
import { DEFAULT_SHORTCUTS, formatCombo } from "@/lib/keyboard-shortcuts";
import {
  MAX_RECENT_PAGES,
  recentPages,
  recordVisit,
  type RecentPage,
} from "@/lib/recent-pages";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { PageTreeNode } from "@/server/queries";

/**
 * Command palette (B43): one modal entry point for actions and pages,
 * opened with Ctrl/Cmd+K or Ctrl/Cmd+P from the workspace shell.
 *
 * - Fuzzy-ranked via `src/lib/fuzzy.ts` (pure, unit-tested): actions first,
 *   then workspace pages; an empty query lists everything in natural order
 *   except pages, which open again rank first via `src/lib/recent-pages.ts`
 *   (`recentPages`/`recordVisit`; history persisted per workspace).
 * - Filters: a leading `type:<value>` scope in the query narrows results by
 *   item type (`parseTypeScope` + `filterByType`).
 * - a11y: Radix gives `role="dialog"` + focus trap; the results container is
 *   a `role="listbox"` of `role="option"`s driven by `aria-activedescendant`,
 *   so the input keeps focus while ↑↓ (wrapping), Home/End and PageUp/PageDown
 *   move the selection via the shared, unit-tested `src/lib/keyboard-nav.ts`
 *   helpers (`nextIndex`/`pageStepIndex`), and a fresh query highlights the
 *   first label that starts with what was typed (`typeaheadIndex`).
 * - Server Actions never live here: `onCreatePage` is owned by the shell,
 *   which wraps it in `useAction()` (coherence ratchet).
 * - Commands that mirror a default keyboard shortcut advertise it on the row
 *   (right-aligned, platform-aware) using the shared `src/lib/keyboard-shortcuts.ts`
 *   registry, so no keystroke is hardcoded here.
 */

type PaletteItem = {
  key: string;
  group: "actions" | "theme" | "pages";
  /** Item type for `type:` scope filtering (§11 Search by type). */
  type: SearchType | "action" | "theme";
  label: string;
  searchText: string;
  icon: React.ReactNode;
  /** Page identity for page rows; absent on action/theme rows. */
  pageId?: string;
  run: () => void;
};

const optionId = (index: number) => `command-palette-option-${index}`;

/**
 * Action rows that mirror a `DEFAULT_SHORTCUTS` entry, keyed by palette item
 * key. The registry stays the single source of truth: the row renders whatever
 * combo that binding carries for the current platform, and a row with no entry
 * simply shows no hint (theme/page rows never match).
 */
const COMMAND_SHORTCUT_IDS: Readonly<Record<string, string>> = {
  "action:create-page": "new-page",
  "action:search": "search",
  "action:toggle-sidebar": "toggle-sidebar",
};

/** Formatted, platform-aware shortcut hints keyed by palette item key. */
function commandShortcutHints(isMac: boolean): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const [itemKey, id] of Object.entries(COMMAND_SHORTCUT_IDS)) {
    const binding = DEFAULT_SHORTCUTS.find((entry) => entry.id === id);
    if (binding) hints[itemKey] = formatCombo(binding.combo, { isMac });
  }
  return hints;
}

/** localStorage key holding this workspace's recently opened pages. */
function recentStorageKey(workspaceSlug: string): string {
  return `noema:recent-pages:${workspaceSlug}`;
}

/**
 * Read the persisted visit history. A missing key, corrupt JSON or an entry
 * whose shape doesn't match is dropped rather than thrown; {@link recentPages}
 * (the pure engine) then dedupes, trims and caps the survivors, so a broken row
 * can never shadow a good one.
 */
function loadRecentPages(storageKey: string): RecentPage[] {
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
    const entries: RecentPage[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { pageId?: unknown; visitedAt?: unknown };
      if (typeof record.pageId !== "string" || typeof record.visitedAt !== "number") {
        continue;
      }
      entries.push({ pageId: record.pageId, visitedAt: record.visitedAt });
    }
    return recentPages(entries, { limit: MAX_RECENT_PAGES, now: 0 });
  } catch {
    return [];
  }
}

/** Persist the history, tolerating private mode / disabled storage. */
function saveRecentPages(storageKey: string, list: readonly RecentPage[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(list));
  } catch {
    // No storage — the in-memory history still ranks this session.
  }
}

/**
 * Promote pages the user opened most recently ahead of the rest of the pages
 * slice, preserving the recency order. Only used for the empty-query list:
 * once the user types, the fuzzy score must win, so callers don't apply it.
 * Unvisited pages keep their natural order behind the recents.
 */
function orderPagesByRecency(
  pages: PaletteItem[],
  recentRank: ReadonlyMap<string, number>,
): PaletteItem[] {
  if (recentRank.size === 0) return pages;
  const ranked = pages
    .filter((item) => item.pageId !== undefined && recentRank.has(item.pageId))
    .sort(
      (a, b) =>
        (recentRank.get(a.pageId ?? "") ?? 0) - (recentRank.get(b.pageId ?? "") ?? 0),
    );
  if (ranked.length === 0) return pages;
  const promoted = new Set(ranked.map((item) => item.pageId));
  return [...ranked, ...pages.filter((item) => !promoted.has(item.pageId))];
}

/** macOS detection for shortcut glyphs; false during SSR to avoid a mismatch. */
function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/mac|iphone|ipad|ipod/i.test(navigator.userAgent));
  }, []);
  return isMac;
}

/**
 * Label text with the active (type-scoped) query emphasised. Reuses the shared
 * `highlightSnippet` so search-term highlighting matches the search page and
 * quick-find; an empty or non-matching query renders the plain label.
 */
function HighlightedLabel({ text, query }: { text: string; query: string }) {
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

export function CommandPalette({
  open,
  onOpenChange,
  workspaceSlug,
  locale,
  pages,
  onCreatePage,
  onToggleSidebar,
  highlightMatches = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceSlug: string;
  locale: string;
  pages: PageTreeNode[];
  onCreatePage: () => void;
  onToggleSidebar: () => void;
  /** Emphasise matched characters in result labels (default on). */
  highlightMatches?: boolean;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const isMac = useIsMac();
  const shortcutHints = useMemo(() => commandShortcutHints(isMac), [isMac]);

  // Recently opened pages, most-recent first — recorded on selection and
  // restored from localStorage on mount. Read in an effect (not during render)
  // so the first client paint matches the server HTML.
  const recentKey = recentStorageKey(workspaceSlug);
  const [recent, setRecent] = useState<RecentPage[]>([]);
  useEffect(() => {
    setRecent(loadRecentPages(recentKey));
  }, [recentKey]);

  // Fresh state on every open: no stale query, first item preselected.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        key: "action:create-page",
        group: "actions",
        type: "action",
        label: t(locale, "createNewPage"),
        searchText: `${t(locale, "createNewPage")} new page`,
        icon: <Plus className="h-4 w-4 text-muted" />,
        run: onCreatePage,
      },
      {
        key: "action:search",
        group: "actions",
        type: "action",
        label: t(locale, "goToSearchPage"),
        searchText: `${t(locale, "goToSearchPage")} ${t(locale, "search")}`,
        icon: <Search className="h-4 w-4 text-muted" />,
        run: () => router.push(`/w/${workspaceSlug}/search`),
      },
      {
        key: "action:toggle-sidebar",
        group: "actions",
        type: "action",
        label: t(locale, "toggleSidebar"),
        searchText: `${t(locale, "toggleSidebar")} sidebar navigation`,
        icon: <PanelLeft className="h-4 w-4 text-muted" />,
        run: onToggleSidebar,
      },
    ];

    const themeOptions = [
      { value: "light", label: t(locale, "light"), icon: <Sun className="h-4 w-4 text-muted" /> },
      { value: "dark", label: t(locale, "dark"), icon: <Moon className="h-4 w-4 text-muted" /> },
      { value: "system", label: t(locale, "system"), icon: <Monitor className="h-4 w-4 text-muted" /> },
    ] as const;
    const themeItems: PaletteItem[] = themeOptions.map((option) => ({
      key: `theme:${option.value}`,
      group: "theme",
      type: "theme",
      label: option.label,
      searchText: `${option.label} ${t(locale, "theme")} ${option.value}`,
      icon: option.icon,
      run: () => setTheme(option.value),
    }));

    const pageItems: PaletteItem[] = pages.map((page) => ({
      key: `page:${page.id}`,
      group: "pages",
      type: page.type === "DATABASE" ? "database" : "page",
      label: page.title || t(locale, "untitled"),
      searchText: page.title || t(locale, "untitled"),
      pageId: page.id,
      icon: (
        <span className="w-4 text-center">
          {page.icon ?? (page.type === "DATABASE" ? "🗂️" : "📄")}
        </span>
      ),
      run: () => router.push(`/w/${workspaceSlug}/${page.id}`),
    }));

    return [...actions, ...themeItems, ...pageItems];
  }, [locale, pages, router, setTheme, workspaceSlug, onCreatePage, onToggleSidebar]);

  // Search filters (§11): a leading `type:<value>` token narrows the list by
  // item type; the remainder is what actually gets fuzzy-matched.
  const scope = useMemo(() => parseTypeScope(query), [query]);
  const scoped = useMemo(
    () => (scope.type ? filterByType(items, scope.type, (item) => item.type) : items),
    [items, scope.type],
  );

  // Recency order (0 = most recent) for the empty-query page ranking. Passed a
  // fixed `now` so it's pure and deterministic; without a half-life the ranking
  // is exactly the move-to-front visit log.
  const recentRank = useMemo(() => {
    const rank = new Map<string, number>();
    for (const [index, entry] of recentPages(recent, {
      limit: recent.length,
      now: 0,
    }).entries()) {
      rank.set(entry.pageId, index);
    }
    return rank;
  }, [recent]);

  // An empty query has no fuzzy score to order by, so pages open again sort
  // by recency instead; a typed query keeps pure fuzzy ranking.
  const isQueryEmpty = scope.query.trim() === "";
  const pageSlice = useMemo(() => {
    const pageItems = scoped.filter((item) => item.group === "pages");
    return isQueryEmpty ? orderPagesByRecency(pageItems, recentRank) : pageItems;
  }, [scoped, isQueryEmpty, recentRank]);

  // Two ranked slices keep the Actions/Theme/Pages group order stable while
  // still ordering each group by fuzzy score.
  const ranked = useMemo(
    () => ({
      actions: fuzzyFilter(
        scoped.filter((item) => item.group === "actions"),
        scope.query,
        (item) => item.searchText,
      ),
      theme: fuzzyFilter(
        scoped.filter((item) => item.group === "theme"),
        scope.query,
        (item) => item.searchText,
      ),
      pages: fuzzyFilter(
        pageSlice,
        scope.query,
        (item) => item.searchText,
      ),
    }),
    [scoped, pageSlice, scope],
  );

  const flat = useMemo(
    () => [
      ...ranked.actions.map((entry) => entry.item),
      ...ranked.theme.map((entry) => entry.item),
      ...ranked.pages.map((entry) => entry.item),
    ],
    [ranked],
  );

  // Pin a stale cursor back into range after any list change, then keep the
  // active row scrolled into view.
  const active = flat.length > 0 ? rovingTabIndex(activeIndex, flat.length) : 0;
  // A fresh query highlights the first label starting with what was typed
  // (typeahead), falling back to the top-ranked hit when nothing matches. The
  // guard keeps later re-renders (items reloading) from resetting a cursor the
  // user already moved.
  const lastQuery = useRef<string | null>(null);
  useEffect(() => {
    if (lastQuery.current === scope.query) return;
    lastQuery.current = scope.query;
    const match = typeaheadIndex(
      flat.map((item) => item.label),
      scope.query,
      -1,
    );
    setActiveIndex(match >= 0 ? match : 0);
  }, [flat, scope.query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(active))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const select = (item: PaletteItem) => {
    onOpenChange(false);
    // Opening a page is the visit the "recent" ranking reads back: move it to
    // the front of the history and persist, so it ranks first next time the
    // palette opens with an empty query. Action/theme rows have no page id.
    const pageId = item.pageId;
    if (pageId !== undefined) {
      const next = recordVisit(recent, pageId, Date.now());
      setRecent(next);
      saveRecentPages(recentKey, next);
    }
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = flat.length;
    const { key } = event;
    if (count === 0) {
      // Nothing to move between; let Escape/Enter fall through to the branches
      // below so the dialog can still close / a stale row can't be selected.
      if (key !== "Enter" && key !== "Escape") return;
    }
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      event.preventDefault();
      setActiveIndex(nextIndex(active, { key, count }));
    } else if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      setActiveIndex(pageStepIndex(active, { key, count }));
    } else if (key === "Enter") {
      event.preventDefault();
      const item = flat[active];
      if (item) select(item);
    } else if (key === "Escape") {
      // Stop here so window-level Escape listeners (chat panel, editor)
      // don't also react to closing the palette.
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    }
  };

  const renderGroup = (
    heading: string,
    entries: typeof ranked.actions,
    offset: number,
  ) =>
    entries.length === 0 ? null : (
      <div role="group" aria-label={heading}>
        <div
          aria-hidden
          className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase text-muted"
        >
          {heading}
        </div>
        {entries.map((entry, index) => {
          const item = entry.item;
          const flatIndex = offset + index;
          const isActive = flatIndex === active;
          return (
            <div
              key={item.key}
              id={optionId(flatIndex)}
              role="option"
              aria-selected={isActive}
              onMouseEnter={() => setActiveIndex(flatIndex)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(item)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm",
                isActive && "bg-surface-2",
              )}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {item.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {highlightMatches ? (
                  <HighlightedLabel text={item.label} query={scope.query} />
                ) : (
                  item.label
                )}
              </span>
              {shortcutHints[item.key] && (
                <span aria-hidden className="shrink-0 text-xs text-muted">
                  {shortcutHints[item.key]}
                </span>
              )}
              {item.key === `theme:${theme}` && (
                <span className="text-xs text-muted">{t(locale, "theme")}</span>
              )}
            </div>
          );
        })}
      </div>
    );

  const hasResults = flat.length > 0;
  const themeOffset = ranked.actions.length;
  const pagesOffset = themeOffset + ranked.theme.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={t(locale, "commandPaletteAria")}
        className="overflow-hidden p-0"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={hasResults}
            aria-controls={hasResults ? "command-palette-list" : undefined}
            aria-activedescendant={hasResults ? optionId(active) : undefined}
            aria-label={t(locale, "commandPalettePlaceholder")}
            placeholder={t(locale, "commandPalettePlaceholder")}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>

        {hasResults ? (
          <div
            ref={listRef}
            id="command-palette-list"
            role="listbox"
            aria-label={t(locale, "commandPaletteAria")}
            className="max-h-[60vh] overflow-y-auto p-1"
          >
            {renderGroup(t(locale, "actionsGroup"), ranked.actions, 0)}
            {renderGroup(t(locale, "theme"), ranked.theme, themeOffset)}
            {renderGroup(t(locale, "pages"), ranked.pages, pagesOffset)}
          </div>
        ) : (
          <div className="px-3 py-6 text-center text-sm text-muted">
            {t(locale, "noResultsDot")}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

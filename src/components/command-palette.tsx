"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Monitor, Moon, PanelLeft, Plus, Search, Sun } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Z } from "@/lib/design-tokens";
import {
  filterByType,
  fuzzyFilter,
  fuzzyMatch,
  parseTypeScope,
  type SearchType,
} from "@/lib/fuzzy";
import {
  nextIndex,
  pageStepIndex,
  rovingTabIndex,
  typeaheadIndex,
  type NavKey,
} from "@/lib/keyboard-nav";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { useIsMac } from "@/lib/use-is-mac";
import {
  MAX_RECENT_PAGES,
  recentPages,
  recordVisit,
  type RecentPage,
} from "@/lib/recent-pages";
import { scrollToIndex } from "@/lib/virtual-list";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { PageTreeNode } from "@/server/queries";

/**
 * Command palette (B43 / DS18): one modal entry point for actions, pages and
 * databases, opened with Ctrl/Cmd+K or Ctrl/Cmd+P from the workspace shell.
 *
 * - **Grouped, counted sections** — Actions · Pages · Databases · Recent ·
 *   Settings — built by the pure {@link buildPaletteSections} (unit-tested):
 *   every slice is fuzzy-ranked with `src/lib/fuzzy.ts`, empty slices drop out,
 *   and a recently-opened page lives only in `Recent` so it never renders twice.
 * - **Fuzzy highlighting** — {@link highlightRanges} turns the fuzzy matcher's
 *   matched indices into merged ranges, so the *matched characters* are
 *   emphasised in the label rather than a contiguous substring.
 * - **Empty state** — when nothing matches, the palette offers a "did you
 *   mean" suggestion via {@link suggestQuery} (Levenshtein over the label and
 *   its words) that refills the query on click.
 * - **Recent actions** — recently opened pages rank inside `Recent` (the same
 *   `src/lib/recent-pages.ts` history the sidebar reads).
 * - **Keyboard** — the input keeps focus while ↑↓ (wrapping), Home/End,
 *   PageUp/PageDown move the roving selection through the shared
 *   `src/lib/keyboard-nav.ts` helpers ({@link moveActiveIndex}); Enter runs,
 *   Escape closes. A fresh query highlights the first label that starts with
 *   what was typed.
 * - **a11y** — Radix gives `role="dialog"` + `aria-modal` + focus trap and
 *   restore (`src/components/ui/dialog.tsx`); the input is labelled, carries
 *   `aria-activedescendant` for the active row, and a polite live region
 *   announces the result count.
 * - **Motion** — opens with the `animate-rise` token, rows never change size on
 *   hover/filter (background-only), the active row uses `--accent-soft`, and a
 *   long list scrolls through `scrollToIndex` (`src/lib/virtual-list.ts`).
 * - Server Actions never live here: `onCreatePage` is owned by the shell.
 */

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

/**
 * Strings the i18n catalogue does not yet carry. They are kept as complete
 * sentences (never concatenated) with `{placeholder}` slots, exactly like the
 * existing `importedMany` entry, so they can be lifted verbatim into
 * `src/lib/i18n.ts`. This file owns no catalogue keys — see the follow-up note
 * in the change notes.
 */
export const PALETTE_COPY = {
  databases: "Databases",
  resultCount: "{n} results",
  resultCountOne: "{n} result",
  noMatch: "No commands match “{query}”",
  didYouMean: "Did you mean “{suggestion}”?",
  navigate: "navigate",
} as const;

/** The live-region count, pluralised. */
export function resultCountLabel(count: number): string {
  const template = count === 1 ? PALETTE_COPY.resultCountOne : PALETTE_COPY.resultCount;
  return template.replace("{n}", String(count));
}

/* ------------------------------------------------------------------ *
 * Model
 * ------------------------------------------------------------------ */

/** The palette's section ids, in render order. */
export const PALETTE_GROUP_ORDER = [
  "actions",
  "pages",
  "databases",
  "recent",
  "settings",
] as const;

export type PaletteGroupId = (typeof PALETTE_GROUP_ORDER)[number];

export type PaletteItem = {
  key: string;
  /** The section this row belongs to when it is *not* a recent. */
  group: Exclude<PaletteGroupId, "recent">;
  /** Item type for `type:` scope filtering (§11 Search by type). */
  type: SearchType | "action" | "theme";
  label: string;
  searchText: string;
  icon: React.ReactNode;
  /** Page identity for page rows; absent on action/theme rows. */
  pageId?: string;
  /** Formatted, platform-aware shortcut hint — only rows mirroring a binding. */
  shortcut?: string;
  run: () => void;
};

/** A fuzzy match highlight range, half-open `[start, end)`. */
export type HighlightRange = { start: number; end: number };

/** One ranked row: the item plus the matched character indices in its label. */
export type PaletteEntry = { item: PaletteItem; indices: number[] };

/** A rendered section: a stable id, its counted rows, and the count. */
export type PaletteSection = {
  id: PaletteGroupId;
  entries: PaletteEntry[];
  count: number;
};

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested in `command-palette.test.ts`)
 * ------------------------------------------------------------------ */

/**
 * Collapse fuzzy-match character indices into sorted, non-overlapping
 * half-open ranges. Non-integer / negative indices are dropped, duplicates and
 * adjacent indices merge, so `[0, 1, 2, 5, 7, 8]` → `[{0,3},{5,6},{7,9}]`.
 */
export function mergeHighlightRanges(indices: readonly number[]): HighlightRange[] {
  const sorted = indices
    .filter((index) => Number.isInteger(index) && index >= 0)
    .slice()
    .sort((a, b) => a - b);

  const ranges: HighlightRange[] = [];
  for (const index of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && index < last.end) continue;
    if (last && index === last.end) last.end = index + 1;
    else ranges.push({ start: index, end: index + 1 });
  }
  return ranges;
}

/**
 * The merged highlight ranges for the fuzzy match of `query` inside `text`
 * (label-level, so the *matched characters* light up). An empty query or a
 * non-match yields `[]` — nothing to highlight.
 */
export function highlightRanges(text: string, query: string): HighlightRange[] {
  if (!text) return [];
  const match = fuzzyMatch(query, text);
  if (!match || match.indices.length === 0) return [];
  return mergeHighlightRanges(match.indices);
}

/** The translated heading for one section id. */
export function paletteGroupHeading(id: PaletteGroupId, locale: string): string {
  switch (id) {
    case "actions":
      return t(locale, "actionsGroup");
    case "pages":
      return t(locale, "pages");
    case "databases":
      return PALETTE_COPY.databases;
    case "recent":
      return t(locale, "recent");
    case "settings":
      return t(locale, "settings");
  }
}

/**
 * Build the palette's sections from the (already type-scoped) items.
 *
 * Rows whose page id is in `recentRank` move into the dedicated `Recent`
 * section (ordered by recency) and are removed from `Pages`/`Databases`, so a
 * page never renders twice. Every section is fuzzy-ranked against `query`;
 * empty sections are dropped, so the count is always `entries.length`. The
 * result follows {@link PALETTE_GROUP_ORDER}.
 */
export function buildPaletteSections(
  items: readonly PaletteItem[],
  options: { query: string; recentRank?: ReadonlyMap<string, number> },
): PaletteSection[] {
  const query = options.query ?? "";
  const recentRank = options.recentRank ?? new Map<string, number>();
  const isRecent = (item: PaletteItem) =>
    item.pageId !== undefined && recentRank.has(item.pageId);

  const recentItems: PaletteItem[] = [];
  const rest: PaletteItem[] = [];
  for (const item of items) {
    (isRecent(item) ? recentItems : rest).push(item);
  }
  recentItems.sort(
    (a, b) => (recentRank.get(a.pageId ?? "") ?? 0) - (recentRank.get(b.pageId ?? "") ?? 0),
  );

  const rank = (list: readonly PaletteItem[]): PaletteEntry[] =>
    fuzzyFilter(list, query, (item) => item.searchText);
  const groupOf = (group: PaletteItem["group"]) =>
    rest.filter((item) => item.group === group);

  const sections: PaletteSection[] = [];
  const push = (id: PaletteGroupId, entries: PaletteEntry[]) => {
    if (entries.length > 0) sections.push({ id, entries, count: entries.length });
  };

  // Order is the render order: Actions · Pages · Databases · Recent · Settings.
  push("actions", rank(groupOf("actions")));
  push("pages", rank(groupOf("pages")));
  push("databases", rank(groupOf("databases")));
  push("recent", rank(recentItems));
  push("settings", rank(groupOf("settings")));
  return sections;
}

/** Flatten sections into the single row order the keyboard cursor walks. */
export function flattenSections(sections: readonly PaletteSection[]): PaletteItem[] {
  return sections.flatMap((section) => section.entries.map((entry) => entry.item));
}

/**
 * The next active row for a navigation key, wrapping like the roving
 * `aria-activedescendant` model. Arrow/Home/End go through `nextIndex`,
 * PageUp/PageDown through `pageStepIndex`; any other key is a no-op. An empty
 * list yields `0`.
 */
export function moveActiveIndex(current: number, key: string, count: number): number {
  if (count <= 0) return 0;
  if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
    return nextIndex(current, { key: key as NavKey, count });
  }
  if (key === "PageDown" || key === "PageUp") {
    return pageStepIndex(current, { key, count });
  }
  return current;
}

/** Classic Levenshtein edit distance on two already-folded strings. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Word separators for the "did you mean" word-level comparison. */
const SUGGESTION_SEPARATOR = /[\s\-_/.]+/;

/**
 * The closest candidate to `query` for a "did you mean" hint, or `null` when
 * nothing is close enough. Comparison is case-insensitive and scored against
 * both the whole candidate and each of its words (so `craete` suggests
 * `Create a new page`). Ties keep the earlier candidate; the default distance
 * budget grows with the query length.
 */
export function suggestQuery(
  query: string,
  candidates: readonly string[],
  options: { maxDistance?: number } = {},
): string | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;

  const max =
    options.maxDistance ??
    (needle.length <= 3 ? 1 : needle.length <= 6 ? 2 : 3);

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const label = candidate.trim();
    if (!label) continue;
    const folded = label.toLowerCase();
    let distance = editDistance(needle, folded);
    for (const word of folded.split(SUGGESTION_SEPARATOR)) {
      if (word) distance = Math.min(distance, editDistance(needle, word));
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best !== null && bestDistance <= max ? best : null;
}

/**
 * The empty-state copy for a query with no matches: the "no commands match"
 * message plus an optional "did you mean" suggestion drawn from every label.
 */
export function emptyStateCopy(
  query: string,
  candidates: readonly string[],
): { message: string; suggestion: string | null } {
  const trimmed = query.trim();
  return {
    message: PALETTE_COPY.noMatch.replace("{query}", trimmed),
    suggestion: suggestQuery(trimmed, candidates),
  };
}

/** Rows are a fixed height so filtering never shifts layout. */
export const PALETTE_ROW_HEIGHT = 36;

/** Above this many rows the list scrolls through `scrollToIndex`. */
export const PALETTE_VIRTUAL_THRESHOLD = 30;

/**
 * The `scrollTop` that keeps the active row visible for a long list, or `null`
 * when the list is short enough for the DOM to handle. Delegates the geometry
 * to the pure `scrollToIndex` (`src/lib/virtual-list.ts`) with `nearest`
 * alignment and a half-row padding.
 */
export function paletteScrollTop(args: {
  active: number;
  count: number;
  viewportSize: number;
  scrollTop: number;
  rowHeight?: number;
}): number | null {
  const rowHeight = args.rowHeight ?? PALETTE_ROW_HEIGHT;
  if (args.count <= PALETTE_VIRTUAL_THRESHOLD || args.count <= 0) return null;
  return scrollToIndex(args.active, {
    itemHeight: rowHeight,
    itemCount: args.count,
    viewportSize: args.viewportSize,
    scrollTop: args.scrollTop,
    align: "nearest",
    padding: rowHeight / 2,
  });
}

/* ------------------------------------------------------------------ *
 * Browser-only helpers
 * ------------------------------------------------------------------ */

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
export function commandShortcutHints(isMac: boolean): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const [itemKey, id] of Object.entries(COMMAND_SHORTCUT_IDS)) {
    hints[itemKey] = formatShortcut(id, { isMac });
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
 * Label text with the *matched characters* (not a contiguous substring)
 * emphasised, using the merged ranges from {@link highlightRanges}. An empty or
 * non-matching query renders the plain label.
 */
function HighlightedLabel({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <mark key={index} className="rounded-xs bg-accent/20 text-inherit">
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/** The footer's key hints: ↑↓ navigate · ⏎ run · Esc close. */
function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex items-center gap-0.5">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
      <span>{label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function CommandPalette({
  open,
  onOpenChange,
  workspaceSlug,
  locale,
  pages,
  onCreatePage,
  onToggleSidebar,
  highlightMatches = true,
  initialQuery = "",
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
  /** Seed the query (e.g. open with a scoped `type:` search); default empty. */
  initialQuery?: string;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = useState(initialQuery);
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
      setQuery(initialQuery);
      setActiveIndex(0);
    }
  }, [open, initialQuery]);

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        key: "action:create-page",
        group: "actions",
        type: "action",
        label: t(locale, "createNewPage"),
        searchText: `${t(locale, "createNewPage")} new page`,
        icon: <Plus className="h-4 w-4 text-muted" />,
        shortcut: shortcutHints["action:create-page"],
        run: onCreatePage,
      },
      {
        key: "action:search",
        group: "actions",
        type: "action",
        label: t(locale, "goToSearchPage"),
        searchText: `${t(locale, "goToSearchPage")} ${t(locale, "search")}`,
        icon: <Search className="h-4 w-4 text-muted" />,
        shortcut: shortcutHints["action:search"],
        run: () => router.push(`/w/${workspaceSlug}/search`),
      },
      {
        key: "action:toggle-sidebar",
        group: "actions",
        type: "action",
        label: t(locale, "toggleSidebar"),
        searchText: `${t(locale, "toggleSidebar")} sidebar navigation`,
        icon: <PanelLeft className="h-4 w-4 text-muted" />,
        shortcut: shortcutHints["action:toggle-sidebar"],
        run: onToggleSidebar,
      },
    ];

    const themeOptions = [
      { value: "light", label: t(locale, "light"), icon: <Sun className="h-4 w-4 text-muted" /> },
      { value: "dark", label: t(locale, "dark"), icon: <Moon className="h-4 w-4 text-muted" /> },
      { value: "system", label: t(locale, "system"), icon: <Monitor className="h-4 w-4 text-muted" /> },
    ] as const;
    const settings: PaletteItem[] = themeOptions.map((option) => ({
      key: `theme:${option.value}`,
      group: "settings",
      type: "theme",
      label: option.label,
      searchText: `${option.label} ${t(locale, "theme")} ${option.value}`,
      icon: option.icon,
      run: () => setTheme(option.value),
    }));

    const pageItems: PaletteItem[] = pages.map((page) => ({
      key: `page:${page.id}`,
      group: page.type === "DATABASE" ? "databases" : "pages",
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

    return [...actions, ...settings, ...pageItems];
  }, [
    locale,
    pages,
    router,
    setTheme,
    workspaceSlug,
    onCreatePage,
    onToggleSidebar,
    shortcutHints,
  ]);

  // Search filters (§11): a leading `type:<value>` token narrows the list by
  // item type; the remainder is what actually gets fuzzy-matched.
  const scope = useMemo(() => parseTypeScope(query), [query]);
  const scoped = useMemo(
    () => (scope.type ? filterByType(items, scope.type, (item) => item.type) : items),
    [items, scope.type],
  );

  // Recency order (0 = most recent) for the dedicated Recent section. Passed a
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

  const sections = useMemo(
    () => buildPaletteSections(scoped, { query: scope.query, recentRank }),
    [scoped, scope.query, recentRank],
  );
  const flat = useMemo(() => flattenSections(sections), [sections]);

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
    const list = listRef.current;
    if (!list) return;
    const top = paletteScrollTop({
      active,
      count: flat.length,
      viewportSize: list.clientHeight,
      scrollTop: list.scrollTop,
    });
    if (top !== null) {
      list.scrollTop = top;
      return;
    }
    list
      .querySelector(`#${CSS.escape(optionId(active))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open, flat.length]);

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

  const renderSection = (section: PaletteSection, offset: number) => {
    const heading = paletteGroupHeading(section.id, locale);
    return (
      <div
        key={section.id}
        role="group"
        aria-label={heading}
        data-palette-group={section.id}
        data-count={section.count}
      >
        <div
          aria-hidden
          style={{ zIndex: Z.sticky }}
          className="sticky top-0 flex items-center justify-between bg-bg px-2 py-1 text-2xs font-medium uppercase text-muted"
        >
          <span>{heading}</span>
          <span className="tabular-nums">{section.count}</span>
        </div>
        {section.entries.map((entry, index) => {
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
                "u-colors flex h-9 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm",
                !isActive && "hover:bg-surface-2",
                isActive && "bg-accent-soft",
              )}
              style={{ height: PALETTE_ROW_HEIGHT }}
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
              {item.shortcut && (
                <span aria-hidden className="shrink-0">
                  <Kbd>{item.shortcut}</Kbd>
                </span>
              )}
              {item.key === `theme:${theme}` && (
                <span className="shrink-0 text-xs text-muted">{t(locale, "theme")}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const hasResults = flat.length > 0;
  const allLabels = items.map((item) => item.label);
  const empty = scope.query.trim() === "" ? null : emptyStateCopy(scope.query, allLabels);
  const suggestion = empty?.suggestion ?? null;
  const announcement = hasResults
    ? resultCountLabel(flat.length)
    : t(locale, "noResultsDot");

  // Running offsets keep option ids aligned with the flat keyboard cursor.
  const offsets: number[] = [];
  sections.reduce((sum, section) => {
    offsets.push(sum);
    return sum + section.count;
  }, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={t(locale, "commandPaletteAria")}
        className="overflow-hidden p-0"
      >
        <div className="flex animate-rise flex-col">
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

          <div className="sr-only" role="status" aria-live="polite">
            {announcement}
          </div>

          {hasResults ? (
            <div
              ref={listRef}
              id="command-palette-list"
              role="listbox"
              aria-label={t(locale, "commandPaletteAria")}
              className="scrollbar-thin max-h-[60vh] overflow-y-auto py-1"
            >
              {sections.map((section, index) => renderSection(section, offsets[index]))}
            </div>
          ) : (
            <div className="px-3 py-8 text-center text-sm text-muted">
              <p>{empty ? empty.message : t(locale, "noResultsDot")}</p>
              {suggestion && (
                <button
                  type="button"
                  onClick={() => setQuery(suggestion)}
                  className="focus-ring mt-2 rounded-sm text-sm text-accent underline underline-offset-2"
                >
                  {PALETTE_COPY.didYouMean.replace("{suggestion}", suggestion)}
                </button>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-4 border-t border-border px-3 py-2 text-xs text-muted">
            <KeyHint keys={["↑", "↓"]} label={PALETTE_COPY.navigate} />
            <KeyHint keys={["⏎"]} label={t(locale, "runWord")} />
            <KeyHint keys={["Esc"]} label={t(locale, "close")} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

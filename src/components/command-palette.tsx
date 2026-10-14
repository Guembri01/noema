"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Monitor, Moon, PanelLeft, Plus, Search, Sun } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  filterByType,
  firstIndex,
  fuzzyFilter,
  lastIndex,
  nextIndex,
  parseTypeScope,
  prevIndex,
  type SearchType,
} from "@/lib/fuzzy";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { PageTreeNode } from "@/server/queries";

/**
 * Command palette (B43): one modal entry point for actions and pages,
 * opened with Ctrl/Cmd+K or Ctrl/Cmd+P from the workspace shell.
 *
 * - Fuzzy-ranked via `src/lib/fuzzy.ts` (pure, unit-tested): actions first,
 *   then workspace pages; an empty query lists everything in natural order.
 * - Filters: a leading `type:<value>` scope in the query narrows results by
 *   item type (`parseTypeScope` + `filterByType`).
 * - a11y: Radix gives `role="dialog"` + focus trap; the results container is
 *   a `role="listbox"` of `role="option"`s driven by `aria-activedescendant`,
 *   so the input keeps focus while ↑↓ (wrapping) and Home/End move the
 *   selection via the unit-tested `nextIndex`/`prevIndex`/`firstIndex`/
 *   `lastIndex` helpers.
 * - Server Actions never live here: `onCreatePage` is owned by the shell,
 *   which wraps it in `useAction()` (coherence ratchet).
 */

type PaletteItem = {
  key: string;
  group: "actions" | "theme" | "pages";
  /** Item type for `type:` scope filtering (§11 Search by type). */
  type: SearchType | "action" | "theme";
  label: string;
  searchText: string;
  icon: React.ReactNode;
  run: () => void;
};

const optionId = (index: number) => `command-palette-option-${index}`;

export function CommandPalette({
  open,
  onOpenChange,
  workspaceSlug,
  locale,
  pages,
  onCreatePage,
  onToggleSidebar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceSlug: string;
  locale: string;
  pages: PageTreeNode[];
  onCreatePage: () => void;
  onToggleSidebar: () => void;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

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
        scoped.filter((item) => item.group === "pages"),
        scope.query,
        (item) => item.searchText,
      ),
    }),
    [scoped, scope],
  );

  const flat = useMemo(
    () => [
      ...ranked.actions.map((entry) => entry.item),
      ...ranked.theme.map((entry) => entry.item),
      ...ranked.pages.map((entry) => entry.item),
    ],
    [ranked],
  );

  // Clamp after any list change, then keep the active row scrolled into view.
  const active = Math.min(activeIndex, Math.max(flat.length - 1, 0));
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(active))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const select = (item: PaletteItem) => {
    onOpenChange(false);
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(nextIndex(flat.length, active));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(prevIndex(flat.length, active));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(firstIndex(flat.length));
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(lastIndex(flat.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = flat[active];
      if (item) select(item);
    } else if (event.key === "Escape") {
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
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
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

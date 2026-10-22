"use client";

/**
 * Select / Combobox — the single- and multi-select control the app was missing.
 *
 * Design-system notes (see `docs/DESIGN_SYSTEM.md`):
 * - colour / shape / motion / layering come from tokens only (`Z.popover`,
 *   `DUR.fast`, `.surface-raised`, `.focus-ring`, `.u-interactive`, `.u-colors`,
 *   `.tag` + `tagStyle()`): no raw hex, magic z-index or ad-hoc duration.
 * - motion: the menu enters with `animate-rise`; the option list gets
 *   `.u-no-transition` while the user scrolls (the "dragging is 1:1" rule).
 * - all seven states are implemented: default / hover / focus-visible / open /
 *   disabled / loading (skeleton rows) / empty (no results) / error (danger ring
 *   + message).
 *
 * Accessibility: the trigger is `role="combobox"` with `aria-expanded`,
 * `aria-controls` and `aria-activedescendant`; the popup list is
 * `role="listbox"` (`aria-multiselectable` in multi mode) and every row is
 * `role="option"` + `aria-selected`. Focus is never trapped: the search field
 * receives focus while open and focus returns to the trigger on select / Esc /
 * Tab.
 *
 * The filtering/ranking, grouping, keyboard-index and selection rules live in
 * the pure functions below so they can be proven without a DOM (see
 * `select.test.ts`).
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { DUR, Z, tagStyle } from "@/lib/design-tokens";
import { floatingStyle, placeFloating, type Placement } from "@/lib/floating";
import { useFloatingHost } from "@/components/ui/floating-layer";
import { offsetForIndex, totalHeight, visibleRange, type VirtualListRange } from "@/lib/virtual-list";

/* -------------------------------------------------------------------------- *
 * Pure API — filtering / ranking / grouping / navigation / selection
 * -------------------------------------------------------------------------- */

/** One selectable row. Values must be unique and stable within `options`. */
export type SelectOption = {
  /** Stable identity, returned by `onChange`. */
  value: string;
  /** Visible text; also the primary search field. */
  label: string;
  /** Optional secondary line under the label. */
  description?: string;
  /** Section heading; options keep their group's first-appearance order. */
  group?: string;
  /** Extra search terms that do not render. */
  keywords?: readonly string[];
  /** Not pickable; skipped by keyboard navigation and clicks. */
  disabled?: boolean;
  /** A tag hue (`TAG_PALETTE`) rendered as a coloured chip on the row. */
  tag?: string | null;
  /** Leading affordance (icon / emoji / avatar). */
  icon?: React.ReactNode;
};

/** Match quality, lower is better. */
export const MATCH_EXACT = 0;
export const MATCH_PREFIX = 1;
export const MATCH_WORD = 2;
export const MATCH_SUBSTRING = 3;
export const MATCH_META = 4;

/**
 * Fold a query for matching: Unicode NFD, drop combining marks, lowercase,
 * collapse whitespace. Also used for labels so `Café` matches `cafe`.
 */
export function normalizeQuery(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Rank one option against `query`, or `null` when it does not match at all. */
export function rankOption(option: SelectOption, query: string): number | null {
  const q = normalizeQuery(query);
  if (q === "") return MATCH_PREFIX;
  const label = normalizeQuery(option.label);
  if (label === q) return MATCH_EXACT;
  if (label.startsWith(q)) return MATCH_PREFIX;
  if (label.split(/[\s/_\-.]+/).some((word) => word.startsWith(q))) {
    return MATCH_WORD;
  }
  if (label.includes(q)) return MATCH_SUBSTRING;
  const meta = normalizeQuery(
    [option.value, option.group ?? "", option.description ?? "", ...(option.keywords ?? [])].join(
      " ",
    ),
  );
  if (meta.includes(q)) return MATCH_META;
  return null;
}

/**
 * Filter + rank options for `query`. A blank query reveals every option in
 * source order; otherwise matches are ordered by rank and then by their
 * original position (a stable sort, so equal ranks keep their order).
 */
export function filterOptions(
  options: readonly SelectOption[],
  query: string,
  limit?: number,
): SelectOption[] {
  const q = normalizeQuery(query);
  const cap = typeof limit === "number" ? Math.max(0, limit) : undefined;
  if (q === "") return cap === undefined ? options.slice() : options.slice(0, cap);

  const scored: { rank: number; index: number; option: SelectOption }[] = [];
  options.forEach((option, index) => {
    const rank = rankOption(option, q);
    if (rank !== null) scored.push({ rank, index, option });
  });
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const ranked = scored.map((entry) => entry.option);
  return cap === undefined ? ranked : ranked.slice(0, cap);
}

/** The option whose label exactly equals `query` (used to hide "create"). */
export function matchedOption(
  options: readonly SelectOption[],
  query: string,
): SelectOption | null {
  const q = normalizeQuery(query);
  if (q === "") return null;
  return options.find((option) => normalizeQuery(option.label) === q) ?? null;
}

/**
 * Whether the "create new" row should appear: a creator is wired up, the query
 * is non-empty, and it does not already name an existing option.
 */
export function shouldShowCreate(
  options: readonly SelectOption[],
  query: string,
  hasCreate: boolean,
): boolean {
  return hasCreate && query.trim() !== "" && matchedOption(options, query) === null;
}

/** A run of options that share one group heading (`null` = ungrouped). */
export type OptionGroup = { group: string | null; options: SelectOption[] };

/** Partition options by `group`, keeping first-appearance order. */
export function groupOptions(options: readonly SelectOption[]): OptionGroup[] {
  const order: (string | null)[] = [];
  const buckets = new Map<string | null, SelectOption[]>();
  for (const option of options) {
    const raw = option.group;
    const group = raw === undefined || raw === null || raw.trim() === "" ? null : raw.trim();
    const bucket = buckets.get(group);
    if (bucket) {
      bucket.push(option);
    } else {
      buckets.set(group, [option]);
      order.push(group);
    }
  }
  return order.map((group) => ({ group, options: buckets.get(group) ?? [] }));
}

/** A flattened render row: a non-selectable heading or an option. */
export type SelectRow =
  | { kind: "group"; key: string; label: string }
  | { kind: "option"; key: string; option: SelectOption };

/** Flatten grouped options into the ordered rows the popup renders. */
export function buildRows(groups: readonly OptionGroup[]): SelectRow[] {
  const rows: SelectRow[] = [];
  for (const { group, options } of groups) {
    if (group !== null) rows.push({ kind: "group", key: `group:${group}`, label: group });
    for (const option of options) {
      rows.push({ kind: "option", key: `option:${option.value}`, option });
    }
  }
  return rows;
}

/** The minimum a row needs to take part in keyboard navigation. */
export type NavItem = { disabled?: boolean };

/** Index of the first selectable row, or `-1` when none are selectable. */
export function firstEnabledIndex(items: readonly NavItem[]): number {
  for (let i = 0; i < items.length; i += 1) if (!items[i].disabled) return i;
  return -1;
}

/** Index of the last selectable row, or `-1` when none are selectable. */
export function lastEnabledIndex(items: readonly NavItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (!items[i].disabled) return i;
  return -1;
}

/**
 * Move `delta` rows (±1) from `from`, skipping disabled rows. `from < 0` means
 * "nothing active": a downward step starts at the first row, an upward step at
 * the last. With `wrap` the search circles the list; without it a boundary is a
 * no-op. Returns `from` when nothing is selectable.
 */
export function nextEnabledIndex(
  items: readonly NavItem[],
  from: number,
  delta: number,
  wrap = true,
): number {
  const count = items.length;
  if (count === 0) return -1;
  const direction = delta >= 0 ? 1 : -1;
  let index = from < 0 ? (direction > 0 ? -1 : count) : from;
  for (let step = 0; step < count; step += 1) {
    index += direction;
    if (index >= count) {
      if (!wrap) return from;
      index = 0;
    } else if (index < 0) {
      if (!wrap) return from;
      index = count - 1;
    }
    if (!items[index].disabled) return index;
  }
  return from;
}

/**
 * The row to highlight when the menu opens: the first preferred (usually
 * already-selected) selectable row, otherwise the first selectable row.
 */
export function initialActiveIndex(items: readonly NavItem[], preferred: readonly number[]): number {
  for (const index of preferred) {
    const item = items[index];
    if (item && !item.disabled) return index;
  }
  return firstEnabledIndex(items);
}

/**
 * Turn render rows into nav rows (group headings are never selectable) and
 * append the "create new" affordance as a selectable final row when present.
 */
export function selectNavItems(rows: readonly SelectRow[], hasCreate: boolean): NavItem[] {
  const items: NavItem[] = rows.map((row) => ({
    disabled: row.kind === "group" || row.option.disabled === true,
  }));
  if (hasCreate) items.push({ disabled: false });
  return items;
}

/** Normalise a controlled value / default value into a list of values. */
export function toSelectionArray(
  value: string | readonly string[] | undefined,
  multiple: boolean,
): string[] {
  if (Array.isArray(value)) return multiple ? value.slice() : value.slice(0, 1);
  if (value === undefined || value === null || value === "") return [];
  return [value as string];
}

/** Is `value` currently selected? */
export function isSelected(selected: readonly string[], value: string): boolean {
  return selected.includes(value);
}

/** Add or remove `value` (multi-select semantics). */
export function toggleValue(selected: readonly string[], value: string): string[] {
  return selected.includes(value)
    ? selected.filter((entry) => entry !== value)
    : [...selected, value];
}

/** Remove `value` if present. */
export function removeValue(selected: readonly string[], value: string): string[] {
  return selected.filter((entry) => entry !== value);
}

/**
 * Resolve the next selection after picking `value`. Multi-select toggles;
 * single-select replaces, and re-picking the current value clears it when
 * `allowClear` is on.
 */
export function applySelection(
  selected: readonly string[],
  value: string,
  options: { multiple: boolean; allowClear?: boolean },
): string[] {
  if (options.multiple) return toggleValue(selected, value);
  if (selected.includes(value)) return options.allowClear ? [] : selected.slice();
  return [value];
}

/** The selection after the user clears the control. */
export function clearSelection(): string[] {
  return [];
}

/**
 * Swallow the Escape key for the select. `preventDefault` stops the browser's
 * default, and `stopPropagation` keeps the event from bubbling to a parent
 * dialog — closing the listbox must not also close the dialog around it.
 * Exported as a pure seam so the propagation contract is testable without a DOM.
 */
export function consumeEscape(event: {
  preventDefault: () => void;
  stopPropagation: () => void;
}): void {
  event.preventDefault();
  event.stopPropagation();
}

/** Stable DOM id for an option row. */
export function optionId(baseId: string, index: number): string {
  return `${baseId}-option-${index}`;
}

/** Above this option count the popup windows its rows. */
export const VIRTUALIZE_THRESHOLD = 200;
/** Pixel height of one option row. */
export const OPTION_ROW_HEIGHT = 32;
/** Tallest the popup may grow before it scrolls (design bound). */
export const MENU_MAX_HEIGHT = 340;
/** Row height used to estimate the popup height before it is measured. */
const ROW_ESTIMATE = 32;

/**
 * Renders the popup into the surface that owns it — the modal's floating host
 * when the Select sits inside one, `document.body` otherwise — in the browser,
 * while rendering inline during SSR, where portals are unavailable.
 *
 * The `typeof document` check (rather than a mounted flag) keeps the popup's
 * server markup identical to its first client render, which the static
 * assertions in `select.test.ts` rely on; host resolution is shared with
 * `ui/floating-layer.tsx` so there is still one rule for where popups go.
 */
function FloatingLayer({ children }: { children?: React.ReactNode }) {
  const host = useFloatingHost();
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(children, host ?? document.body);
}
/** Pixel height of one group heading row. */
export const GROUP_ROW_HEIGHT = 24;
/** Extra rows rendered outside the viewport while virtualised. */
export const OPTION_OVERSCAN = 6;

/** The virtual window over `count` rows, wrapping `@/lib/virtual-list`. */
export function virtualOptionWindow(input: {
  count: number;
  scrollTop: number;
  viewportSize: number;
  rowHeight?: number;
  overscan?: number;
  heightOf?: (index: number) => number;
}): VirtualListRange {
  return visibleRange({
    itemCount: input.count,
    scrollTop: input.scrollTop,
    viewportSize: input.viewportSize,
    itemHeight: input.rowHeight ?? OPTION_ROW_HEIGHT,
    overscan: input.overscan ?? OPTION_OVERSCAN,
    heightOf: input.heightOf,
  });
}

/* -------------------------------------------------------------------------- *
 * Component
 * -------------------------------------------------------------------------- */

/** Popup viewport height in px (matches `max-h-80`). */
const LISTBOX_MAX_HEIGHT = 320;

type SelectCommonProps = {
  /** Every selectable row. */
  options: readonly SelectOption[];
  disabled?: boolean;
  /** Show skeleton rows instead of options in the popup. */
  loading?: boolean;
  /** Danger ring + message; sets `aria-invalid`. */
  invalid?: boolean;
  errorMessage?: string;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Accessible label for the filter field (defaults to `t("search")`). */
  searchPlaceholder?: string;
  /** Empty-state title (defaults to `t("noResults")`). */
  noResultsLabel?: string;
  /** Empty-state hint under the title. */
  noResultsHint?: string;
  /** Label for the clear button. */
  clearLabel?: string;
  /** Verb for the create affordance ("Create"). */
  createLabel?: string;
  /** When set, a "create" row appears for a non-empty, unmatched query. */
  onCreate?: (query: string) => void;
  /** Allow clicking the clear button / re-picking to clear. */
  allowClear?: boolean;
  /** Show the in-popup filter field and focus it on open. */
  searchable?: boolean;
  /** Start with the popup open (uncontrolled; handy for "always open" use and tests). */
  defaultOpen?: boolean;
  /** Initial filter text (uncontrolled). */
  defaultQuery?: string;
  /** Chips shown on a multi-select trigger before collapsing to "+N". */
  maxChips?: number;
  size?: "sm" | "md";
  className?: string;
  menuClassName?: string;
  id?: string;
  name?: string;
  locale?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

export type SelectProps =
  | (SelectCommonProps & {
      multiple?: false;
      value?: string;
      defaultValue?: string;
      onChange?: (value: string) => void;
    })
  | (SelectCommonProps & {
      multiple: true;
      value?: string[];
      defaultValue?: string[];
      onChange?: (value: string[]) => void;
    });

const SIZE_CLASS: Record<"sm" | "md", string> = {
  sm: "min-h-8 text-sm",
  md: "min-h-9 text-sm",
};

/** The coloured tag chip shown on an option / trigger. */
function TagChip({ hue, label }: { hue: string; label: string }) {
  return (
    <span className="tag shrink-0" style={tagStyle(hue)}>
      {label}
    </span>
  );
}

export function Select(props: SelectProps) {
  const {
    options,
    disabled = false,
    loading = false,
    invalid = false,
    errorMessage,
    locale = "en",
    placeholder = t(locale, "select"),
    searchPlaceholder,
    noResultsLabel,
    noResultsHint = "Try a different search.",
    clearLabel = "Clear",
    createLabel = "Create",
    onCreate,
    allowClear = true,
    searchable = true,
    defaultOpen = false,
    defaultQuery = "",
    maxChips = 3,
    size = "md",
    className,
    menuClassName,
    id,
    name,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledby,
  } = props;
  const multiple = props.multiple === true;
  const controlled = props.value !== undefined;
  const onChange = props.onChange as ((value: string | string[]) => void) | undefined;

  const reactId = React.useId();
  const baseId = id ?? `select-${reactId}`;
  const listboxId = `${baseId}-listbox`;
  const errorId = `${baseId}-error`;

  const [open, setOpen] = React.useState(defaultOpen);
  const [query, setQuery] = React.useState(defaultQuery);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [scrolling, setScrolling] = React.useState(false);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [uncontrolled, setUncontrolled] = React.useState<string[]>(() =>
    toSelectionArray(props.defaultValue, multiple),
  );

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  /**
   * Collision-aware placement of the portal-ed listbox. Resolved on open (and on
   * scroll/resize) so the popup can never be clipped by a scrolling ancestor or
   * run off the viewport edge.
   */
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const [menuWidth, setMenuWidth] = React.useState<number | undefined>(undefined);
  const scrollTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = React.useMemo(
    () => (controlled ? toSelectionArray(props.value, multiple) : uncontrolled),
    [controlled, props.value, multiple, uncontrolled],
  );

  const commit = React.useCallback(
    (next: string[]) => {
      if (!controlled) setUncontrolled(next);
      if (!onChange) return;
      if (multiple) onChange(next);
      else onChange(next[0] ?? "");
    },
    [controlled, onChange, multiple],
  );

  const filtered = React.useMemo(() => filterOptions(options, query), [options, query]);
  const groups = React.useMemo(() => groupOptions(filtered), [filtered]);
  const rows = React.useMemo(() => buildRows(groups), [groups]);
  const showCreate = shouldShowCreate(options, query, Boolean(onCreate));
  const navItems = React.useMemo(
    () => selectNavItems(rows, showCreate),
    [rows, showCreate],
  );

  const virtual = rows.length >= VIRTUALIZE_THRESHOLD;
  const heightOf = React.useCallback(
    (index: number) => (rows[index]?.kind === "group" ? GROUP_ROW_HEIGHT : OPTION_ROW_HEIGHT),
    [rows],
  );
  const windowRange = virtual
    ? virtualOptionWindow({
        count: rows.length,
        scrollTop,
        viewportSize: LISTBOX_MAX_HEIGHT,
        heightOf,
      })
    : { start: 0, end: rows.length };
  const topPad = virtual ? offsetForIndex(windowRange.start, OPTION_ROW_HEIGHT, heightOf) : 0;
  const bottomPad = virtual
    ? totalHeight(rows.length, OPTION_ROW_HEIGHT, heightOf) -
      offsetForIndex(windowRange.end, OPTION_ROW_HEIGHT, heightOf)
    : 0;

  const activeDescendant = React.useMemo(() => {
    if (!open || activeIndex < 0) return undefined;
    if (showCreate && activeIndex === rows.length) return `${baseId}-create`;
    return rows[activeIndex]?.kind === "option" ? optionId(baseId, activeIndex) : undefined;
  }, [open, activeIndex, showCreate, rows, baseId]);

  // Reset the highlighted row (and scroll) whenever the menu opens or filters.
  React.useEffect(() => {
    if (!open) return;
    const preferred = rows
      .map((row, index) =>
        row.kind === "option" && selected.includes(row.option.value) ? index : -1,
      )
      .filter((index) => index >= 0);
    setActiveIndex(initialActiveIndex(navItems, preferred));
    setScrollTop(0);
    const node = rootRef.current?.querySelector<HTMLElement>("[data-select-listbox]");
    if (node) node.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  // Keep the active row in view (virtual: adjust scrollTop; else scrollIntoView).
  React.useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = rootRef.current?.querySelector<HTMLElement>("[data-select-listbox]");
    if (!node) return;
    const row = rows[activeIndex];
    if (!row) return;
    if (virtual) {
      const height = heightOf(activeIndex);
      const top = offsetForIndex(activeIndex, OPTION_ROW_HEIGHT, heightOf);
      const bottom = top + height;
      const viewTop = node.scrollTop;
      const viewBottom = viewTop + node.clientHeight;
      if (top < viewTop) node.scrollTop = top;
      else if (bottom > viewBottom) node.scrollTop = bottom - node.clientHeight;
    } else {
      const el = node.querySelector<HTMLElement>(`#${CSS.escape(optionId(baseId, activeIndex))}`);
      el?.scrollIntoView({ block: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, open, virtual]);

  // Resolve the popup placement whenever it opens, and keep it correct while the
  // page scrolls or the window resizes (the layer is `fixed`).
  React.useEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const resolve = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const estimated = Math.min(
        MENU_MAX_HEIGHT,
        Math.max(120, rows.length * ROW_ESTIMATE + (searchable ? 44 : 8)),
      );
      setMenuWidth(rect.width);
      setPlacement(
        placeFloating({
          anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          size: { width: rect.width, height: estimated },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          preferred: "bottom",
          align: "start",
        }),
      );
    };
    resolve();
    window.addEventListener("resize", resolve);
    window.addEventListener("scroll", resolve, true);
    return () => {
      window.removeEventListener("resize", resolve);
      window.removeEventListener("scroll", resolve, true);
    };
  }, [open, rows.length, searchable]);

  // Close when a pointer lands outside the control. The layer lives in a portal,
  // so `rootRef` no longer contains it — check both trees.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.('[data-testid="select-menu"]')) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  React.useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  const openMenu = React.useCallback(() => {
    setOpen(true);
    setQuery("");
  }, []);

  const closeMenu = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }, []);

  const choose = React.useCallback(
    (option: SelectOption) => {
      if (option.disabled) return;
      commit(applySelection(selected, option.value, { multiple, allowClear }));
      if (!multiple) closeMenu();
    },
    [allowClear, closeMenu, commit, multiple, selected],
  );

  const activateRow = React.useCallback(
    (index: number) => {
      if (showCreate && index === rows.length) {
        onCreate?.(query.trim());
        setQuery("");
        closeMenu();
        return;
      }
      const row = rows[index];
      if (row?.kind === "option") choose(row.option);
    },
    [choose, closeMenu, onCreate, query, rows, showCreate],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (disabled) return;
      const { key } = event;

      if (!open) {
        if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
          if (key === " " && !searchable) return; // let Space scroll the page
          event.preventDefault();
          openMenu();
          return;
        }
        // Type-ahead from the closed trigger (select-only combobox).
        if (!searchable && onCreate === undefined && key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          openMenu();
          setQuery(key);
        }
        return;
      }

      switch (key) {
        case "ArrowDown":
          event.preventDefault();
          setActiveIndex((index) => nextEnabledIndex(navItems, index, 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          setActiveIndex((index) => nextEnabledIndex(navItems, index, -1));
          break;
        case "Home":
          event.preventDefault();
          setActiveIndex(firstEnabledIndex(navItems));
          break;
        case "End":
          event.preventDefault();
          setActiveIndex(lastEnabledIndex(navItems));
          break;
        case "Enter":
          event.preventDefault();
          activateRow(activeIndex);
          break;
        case "Escape":
          consumeEscape(event);
          closeMenu();
          break;
        case "Tab":
          // Close and hand focus back to the trigger; the browser then continues
          // the tab order from there.
          closeMenu();
          break;
        case "Backspace":
          if (!searchable) {
            event.preventDefault();
            setQuery((value) => value.slice(0, -1));
          }
          break;
        default:
          if (!searchable && key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            setQuery((value) => value + key);
          }
      }
    },
    [activateRow, activeIndex, closeMenu, disabled, navItems, onCreate, open, openMenu, searchable],
  );

  const onListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    setScrolling(true);
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => setScrolling(false), DUR.fast);
  };

  const handleClear = (event: React.MouseEvent) => {
    event.stopPropagation();
    commit(clearSelection());
    if (!open) triggerRef.current?.focus();
  };

  const selectedOptions = selected
    .map((value) => options.find((option) => option.value === value))
    .filter((option): option is SelectOption => option !== undefined);
  const visibleChips = selectedOptions.slice(0, Math.max(0, maxChips));
  const overflowChips = selectedOptions.length - visibleChips.length;
  const singleSelected = multiple ? undefined : selectedOptions[0];

  const showClear = allowClear && !disabled && selected.length > 0;

  return (
    <div className={cn("inline-flex w-full flex-col", className)} ref={rootRef}>
      <span className="relative inline-flex w-full">
        <button
          type="button"
          ref={triggerRef}
          id={baseId}
          data-testid="select-trigger"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open ? activeDescendant : undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={errorMessage ? errorId : undefined}
          aria-busy={loading || undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          disabled={disabled}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={handleKeyDown}
          className={cn(
            "u-interactive u-colors focus-ring relative flex w-full items-center gap-2 rounded-sm border border-control bg-bg px-2 text-start text-fg",
            SIZE_CLASS[size],
            "hover:bg-surface-2",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-bg",
            open && "bg-surface-2",
            invalid && "border-danger",
            showClear ? "pe-12" : "pe-7",
          )}
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {loading ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin text-muted" />
            ) : null}
            {multiple ? (
              selectedOptions.length === 0 ? (
                <span className="truncate text-muted">{placeholder}</span>
              ) : (
                <>
                  {visibleChips.map((option) => (
                    <span
                      key={option.value}
                      className="inline-flex max-w-[140px] items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 text-xs"
                    >
                      {option.tag ? (
                        <span
                          aria-hidden
                          className="h-2 w-2 shrink-0 rounded-full border"
                          style={tagStyle(option.tag)}
                        />
                      ) : null}
                      <span className="truncate">{option.label}</span>
                    </span>
                  ))}
                  {overflowChips > 0 ? (
                    <span className="text-xs text-muted">{`+${overflowChips}`}</span>
                  ) : null}
                </>
              )
            ) : singleSelected ? (
              <>
                {singleSelected.icon ? (
                  <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {singleSelected.icon}
                  </span>
                ) : null}
                <span className="truncate">{singleSelected.label}</span>
                {singleSelected.tag ? (
                  <TagChip hue={singleSelected.tag} label={singleSelected.label} />
                ) : null}
              </>
            ) : (
              <span className="truncate text-muted">{placeholder}</span>
            )}
          </span>
        </button>

        {showClear ? (
          <button
            type="button"
            aria-label={clearLabel}
            data-testid="select-clear"
            onClick={handleClear}
            className="focus-ring absolute end-7 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-xs text-muted hover:text-fg"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : null}

        <ChevronDown
          aria-hidden
          className={cn(
            "u-transform pointer-events-none absolute end-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted",
            open && "rotate-180",
          )}
        />

        {open ? (
          <FloatingLayer>
          <div
            data-testid="select-menu"
            style={{
              ...floatingStyle(
                placement ?? {
                  top: 0,
                  left: 0,
                  side: "bottom",
                  flipped: false,
                  cramped: false,
                  maxHeight: MENU_MAX_HEIGHT,
                },
              ),
              zIndex: Z.popover,
              width: menuWidth,
            }}
            className={cn(
              "surface-raised animate-rise overflow-hidden p-1 text-fg",
              menuClassName,
            )}
          >
            {searchable ? (
              <div className="mb-1 flex items-center gap-2 rounded-sm border border-control px-2">
                <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
                <input
                  autoFocus
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={listboxId}
                  aria-activedescendant={activeDescendant}
                  aria-autocomplete="list"
                  aria-label={searchPlaceholder ?? t(locale, "search")}
                  data-testid="select-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={searchPlaceholder ?? t(locale, "search")}
                  className="h-8 w-full bg-transparent text-sm text-fg outline-none placeholder:text-muted"
                />
              </div>
            ) : null}

            <div
              role="listbox"
              id={listboxId}
              data-select-listbox
              aria-multiselectable={multiple || undefined}
              aria-busy={loading || undefined}
              onScroll={onListScroll}
              // Keep focus in the filter field when an option is clicked.
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                "scrollbar-thin max-h-80 overflow-y-auto",
                virtual && "relative",
                scrolling && "u-no-transition",
              )}
            >
              {loading ? (
                <div className="flex flex-col gap-1 p-1" data-testid="select-loading">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <div key={index} className="flex items-center gap-2 px-2 py-1.5">
                      <span className="h-3.5 w-3.5 shrink-0 animate-pulse-soft rounded-xs bg-surface-2" />
                      <span className="h-3 w-2/3 animate-pulse-soft rounded-xs bg-surface-2" />
                    </div>
                  ))}
                </div>
              ) : rows.length === 0 && !showCreate ? (
                <div
                  data-testid="select-empty"
                  className="flex flex-col items-center gap-1 px-4 py-6 text-center"
                >
                  <span className="grid h-8 w-8 place-items-center rounded-md bg-surface text-muted">
                    <Search aria-hidden className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium text-fg">
                    {noResultsLabel ?? t(locale, "noResults")}
                  </span>
                  <span className="text-xs text-muted">{noResultsHint}</span>
                </div>
              ) : (
                <>
                  {virtual && topPad > 0 ? <div aria-hidden style={{ height: topPad }} /> : null}
                  {rows.slice(windowRange.start, windowRange.end).map((row, offset) => {
                    const index = windowRange.start + offset;
                    if (row.kind === "group") {
                      return (
                        <div
                          key={row.key}
                          role="presentation"
                          className="px-2 pb-1 pt-2 text-xs font-medium text-muted"
                        >
                          {row.label}
                        </div>
                      );
                    }
                    const option = row.option;
                    const isActive = index === activeIndex;
                    const isChosen = isSelected(selected, option.value);
                    return (
                      <div
                        key={row.key}
                        id={optionId(baseId, index)}
                        role="option"
                        aria-selected={isChosen}
                        aria-disabled={option.disabled || undefined}
                        onClick={() => choose(option)}
                        onMouseMove={() => {
                          if (!option.disabled && index !== activeIndex) setActiveIndex(index);
                        }}
                        className={cn(
                          "u-colors flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                          isActive && "bg-surface-2",
                          option.disabled && "cursor-not-allowed opacity-50",
                        )}
                      >
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted">
                          {option.icon ?? (isChosen && multiple ? (
                            <Check aria-hidden className="h-3.5 w-3.5" />
                          ) : null)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{option.label}</span>
                          {option.description ? (
                            <span className="block truncate text-xs text-muted">
                              {option.description}
                            </span>
                          ) : null}
                        </span>
                        {option.tag ? <TagChip hue={option.tag} label={option.label} /> : null}
                        {!multiple && isChosen ? (
                          <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />
                        ) : null}
                      </div>
                    );
                  })}
                  {showCreate ? (
                    <div
                      id={`${baseId}-create`}
                      role="option"
                      aria-selected={false}
                      onClick={() => activateRow(rows.length)}
                      onMouseMove={() => {
                        if (activeIndex !== rows.length) setActiveIndex(rows.length);
                      }}
                      className={cn(
                        "u-colors flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-accent",
                        activeIndex === rows.length && "bg-surface-2",
                      )}
                    >
                      <span className="h-4 w-4 shrink-0" />
                      <span className="truncate">{`${createLabel} “${query.trim()}”`}</span>
                    </div>
                  ) : null}
                  {virtual && bottomPad > 0 ? <div aria-hidden style={{ height: bottomPad }} /> : null}
                </>
              )}
            </div>
          </div>
          </FloatingLayer>
        ) : null}
      </span>

      {errorMessage ? (
        <p id={errorId} data-testid="select-error" className="mt-1 text-xs text-danger">
          {errorMessage}
        </p>
      ) : null}

      {name
        ? multiple
          ? selected.map((value) => <input key={value} type="hidden" name={name} value={value} />)
          : <input type="hidden" name={name} value={selected[0] ?? ""} />
        : null}
    </div>
  );
}

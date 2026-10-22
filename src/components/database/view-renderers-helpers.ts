/**
 * Shared model for the database view renderers.
 *
 * Row presence/motion, row and column ordering, table height/sort/footer
 * helpers and scroll anchoring live here so each layout can stay a view.
 * Everything is re-exported from ./view-renderers for the existing tests.
 */
"use client";

import { Cell, PropertyHeader } from "./view-parts";
import { Fragment, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type RefObject } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  ExternalLink,
  Inbox,
  LayoutTemplate,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { DUR, TAG_PALETTE, Z, tagClass, type TagHue } from "@/lib/design-tokens";
import {
  formatCell,
  hasStatusGroups,
  statusGroupColumns,
  visibleColumns,
  type QueryProperty,
  type QueryRow,
  type Sort,
  type ViewConfig,
} from "@/lib/database-query";
import { applySort, type SortSpec } from "@/lib/sort-compare";
import { groupRowsByProperty, visibleGroups as filterVisibleGroups } from "@/lib/board-groups";
import { buildSwimlanes, laneCounts } from "@/lib/board-swimlanes";
import { checkWip, type WipLimits, type WipStatus } from "@/lib/kanban-wip";
import { reorderRows, sortByOrder } from "@/lib/row-order";
import { reorderRowsAction } from "@/server/actions/database";
import { evaluateRowColors, type RowColorRule } from "@/lib/row-color-rules";
import {
  AGGREGATION_FUNCTIONS,
  aggregateGroups,
  type AggregateOptions,
  type AggregationFn,
  type GroupAggregationSpec,
} from "@/lib/aggregations";
import {
  CARD_SIZES,
  COVER_PROPERTY_TYPES,
  cardFieldOrder,
  cardSizeFor,
  densityOptions,
  listRowModel,
  resolveCardPreview,
  type CardSizeName,
  type ListDensity,
} from "@/lib/view-presets";
import {
  flattenLayout,
  parsePropertyLayout as parseLegacyPropertyLayout,
} from "@/lib/property-layout";
import {
  resolveLayout as resolvePropertyPlacements,
  type PropertyPlacement,
} from "@/lib/property-layout-engine";
import {
  deleteColumn as deleteTableColumn,
  deleteRow as deleteTableRow,
  insertColumn as insertTableColumn,
  insertRow as insertTableRow,
  moveColumn as moveTableColumn,
  moveRow as moveTableRow,
} from "@/lib/table-ops";
import {
  indentItem,
  normalizeLevels,
  outdentItem,
  type ListItem,
} from "@/lib/list-ops";
import {
  captureAnchor,
  nearestVisibleIndex,
  restoreScrollTop,
} from "@/lib/scroll-anchor";
import {
  computeFooter,
  forGroup,
  parseFooterSpec,
  type FooterColumnResult,
  type FooterSpec,
} from "@/lib/footer-calculations";
import {
  parsePreviewConfig,
  resolveCardPreview as resolveGalleryPreview,
  type GalleryPropertyLike,
  type PreviewConfig,
  type ResolvedCardPreview,
} from "@/lib/gallery-preview";
import {
  buildFormSchema,
  defaultAnswers,
  describeForm,
  parseFormSchema,
  toRowValues,
  validateSubmission,
  type FormDescription,
  type FormField,
  type FormIssue,
  type FormSchema,
} from "@/lib/form-view";
import { optionEdge, optionInk, optionSurface, type DBProperty, type DBRow, type HeaderConfig } from "@/components/database/database-types";
import { shouldAnimateLayout, useFlipList } from "@/lib/layout-shift";
import {
  ROW_MOTION_MS,
  enteredIds,
  groupChevronClass,
  retainLeaving,
  rowIdsKey,
  rowMotionClass,
  rowMotionState,
  rowMotionStyle,
  sameIds,
  type RowMotionState,
} from "./group-motion";

/* ---------------------------------------------------------------------------
   Row presence — fade in on add, fade out on delete (shared by the views)

   The FLIP hook (`@/lib/layout-shift`) animates the rows that *move*; this is
   the other half: a row that appears fades in and one that disappears keeps its
   box for `--dur-2` while it fades out, so the rows around it never jump. The
   presence of a row is derived from the **ordered ids** only — a keystroke
   changes cell content, never an id, so typing can never replay a fade.
   --------------------------------------------------------------------------- */

/**
 * Whether this client should run entry/exit motion at all. The decision is the
 * shared `shouldAnimateLayout` predicate, so the fade and the FLIP slide stand
 * down under `prefers-reduced-motion` together (and the global CSS override
 * makes anything that slips through instant). Starts `false` so the server and
 * the first client render agree; the effect flips it once the media query is
 * readable.
 */
export function useMotionEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setEnabled(true);
      return;
    }
    setEnabled(
      shouldAnimateLayout({
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        dragging: false,
      }),
    );
  }, []);
  return enabled;
}

type RowPresenceState<T> = {
  /** The ordered ids of the rows that were present last commit. */
  ids: string[];
  /** The list rendered last commit (present rows plus any still exiting). */
  rendered: T[];
  /** Ids that just appeared and should fade in. */
  entering: Set<string>;
  /** Rows that are no longer present but still fading out. */
  exiting: T[];
};

/**
 * Track which rows just entered or left and return the list to render (with the
 * exiting rows re-inserted at their old slots) plus a per-row motion state.
 *
 * The entry/exit detection runs during render — a render-phase state update —
 * so the very first commit that shows a new row already carries its fade, with
 * no visible flash. Both the enter flag and the exiting snapshots are cleared
 * after `--dur-2`.
 */
export function useRowPresence<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): { rows: T[]; stateOf: (id: string) => RowMotionState } {
  const motion = useMotionEnabled();
  const ids = items.map(keyOf);
  const [presence, setPresence] = useState<RowPresenceState<T>>(() => ({
    ids,
    rendered: [...items],
    entering: new Set<string>(),
    exiting: [],
  }));

  if (!sameIds(presence.ids, ids)) {
    const nextIds = new Set(ids);
    setPresence({
      ids,
      rendered: retainLeaving(items, presence.rendered, keyOf),
      entering: new Set(enteredIds(presence.ids, ids)),
      exiting: presence.rendered.filter((item) => !nextIds.has(keyOf(item))),
    });
  }

  // Drop the enter flags once the fade has played, so a later re-entry replays.
  useEffect(() => {
    if (presence.entering.size === 0) return;
    const timer = setTimeout(
      () => setPresence((current) => ({ ...current, entering: new Set<string>() })),
      ROW_MOTION_MS,
    );
    return () => clearTimeout(timer);
  }, [presence.entering]);

  // Drop the exiting snapshots once the fade-out has played.
  useEffect(() => {
    if (presence.exiting.length === 0) return;
    const timer = setTimeout(() => {
      setPresence((current) => {
        const present = new Set(current.ids);
        return {
          ...current,
          rendered: current.rendered.filter((item) => present.has(keyOf(item))),
          exiting: [],
        };
      });
    }, ROW_MOTION_MS);
    return () => clearTimeout(timer);
  }, [presence.exiting]);

  if (!motion) {
    return { rows: [...items], stateOf: () => "idle" };
  }

  const present = new Set(ids);
  return {
    // Present rows always come from the fresh `items` (a cell edit re-renders
    // them); only the exiting rows are pulled from the last rendered list.
    rows: retainLeaving(items, presence.rendered, keyOf),
    stateOf: (id) => rowMotionState(id, { present, entering: presence.entering }),
  };
}

/* ---------------------------------------------------------------------------
   View class & motion maps (design system §5/§6)

   Every visual decision a view makes that is not itself a token — how tall a
   table row is, how a board card lifts, how many skeleton rows to draw — is a
   pure mapping here. Node tests (`view-renderers.classes.test.ts`) pin them and
   the renderers below consume them, so the markup and the mapping can never
   disagree.
   --------------------------------------------------------------------------- */

/** Table row-height modes, densest to roomiest. */
export const TABLE_ROW_HEIGHTS = ["short", "medium", "tall"] as const;
export type TableRowHeight = (typeof TABLE_ROW_HEIGHTS)[number];

/**
 * Per-mode cell padding class and approximate rendered row height (px). The
 * height feeds the scroll anchor, so a taller table re-pins with the right
 * measurements; the class keeps every cell in a mode the same height.
 */
export const TABLE_ROW_HEIGHT_MODES: Record<
  TableRowHeight,
  { px: number; cellClass: string; label: string }
> = {
  short: { px: 32, cellClass: "px-3 py-0.5", label: "Short" },
  medium: { px: 37, cellClass: "px-3 py-1.5", label: "Medium" },
  tall: { px: 52, cellClass: "px-3 py-3", label: "Tall" },
};

/** Coerce an untrusted row-height value to a known mode (default `medium`). */
export function resolveTableRowHeight(value: unknown): TableRowHeight {
  return value === "short" || value === "medium" || value === "tall"
    ? value
    : "medium";
}

/** Approximate rendered height (px) of a table row in a mode. */
export function tableRowHeight(value: unknown): number {
  return TABLE_ROW_HEIGHT_MODES[resolveTableRowHeight(value)].px;
}

/** The cell padding class for a table row mode (one height per row). */
export function tableRowCellClass(value: unknown): string {
  return TABLE_ROW_HEIGHT_MODES[resolveTableRowHeight(value)].cellClass;
}

/** Approximate rendered height (px) of one list row under a density preset. */
export function listRowHeight(density: ListDensity): number {
  return density === "comfortable" ? 57 : 41;
}

/**
 * Board card lift (design system §5/§6): `shadow-1` at rest, `shadow-2` on
 * hover, pressed with `.u-interactive`. While a card is being dragged it carries
 * `.u-no-transition` so it tracks the cursor 1:1 without lagging behind, and a
 * settling card eases back with the spring-ish `animate-scale-in`.
 */
export const CARD_LIFT = {
  base: "shadow-1",
  hover: "hover:shadow-2",
  press: "u-interactive",
  dragging: "u-no-transition opacity-50",
  settling: "animate-scale-in",
} as const;

/** The class for a board card in a given interaction state. */
export function boardCardClass(
  state: { dragging?: boolean; settling?: boolean } = {},
): string {
  return cn(
    "block rounded-lg border border-border bg-bg p-3 hover:bg-surface-2/40",
    CARD_LIFT.base,
    CARD_LIFT.hover,
    CARD_LIFT.press,
    state.dragging && CARD_LIFT.dragging,
    state.settling && CARD_LIFT.settling,
  );
}

/**
 * The cell value a card drop writes to the grouping property. `undefined` means
 * "no write" (a status-bucket board whose columns are not option ids); `null`
 * clears the value (the Empty column); otherwise the option id is set.
 */
export function boardDropValue(optionId: string | null | undefined): unknown {
  if (optionId === undefined) return undefined;
  return optionId === null ? null : { optionId };
}

/**
 * Deterministic tag hue for a gallery badge, so two cards with the same
 * property always draw the same chip colour and the palette — never a raw
 * colour — is the only source of the chip's look.
 */
export function galleryBadgeHue(seed: string): TagHue {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

/** How many skeleton rows/cards a view draws while loading. */
export const SKELETON_COUNTS = {
  table: 6,
  boardCards: 3,
  gallery: 8,
  list: 6,
  form: 3,
  timeline: 4,
  chart: 5,
  calendar: 6,
} as const;

export type ViewKind = keyof typeof SKELETON_COUNTS;

/** Skeleton count for a view. */
export function skeletonCount(view: ViewKind): number {
  return SKELETON_COUNTS[view];
}

/** Gallery skeleton cards track the responsive column count (two rows each). */
export function gallerySkeletonCards(size: CardSizeName): number {
  return CARD_SIZES[size].columns * 2;
}

/**
 * The left offsets (px) of the 1px `--border-strong` indent guides drawn for a
 * list row at `level`: one guide per ancestor, empty at the root.
 */
export function listIndentGuides(level: number): number[] {
  const depth = Number.isFinite(level) ? Math.max(0, Math.trunc(level)) : 0;
  return Array.from({ length: depth }, (_, index) => (index + 1) * 16 - 8);
}

/**
 * The row ids hidden because an ancestor is collapsed. `items` is the normalised
 * outline (`@/lib/list-ops`), so levels never jump more than one step, which is
 * what lets a single pass track the open ancestors.
 */
export function collapsedListIds(
  items: readonly ListItem[],
  collapsed: Readonly<Record<string, boolean>>,
): Set<string> {
  const hidden = new Set<string>();
  const collapsedLevels: number[] = [];
  for (const item of items) {
    while (
      collapsedLevels.length > 0 &&
      collapsedLevels[collapsedLevels.length - 1] >= item.level
    ) {
      collapsedLevels.pop();
    }
    if (collapsedLevels.length > 0) hidden.add(item.id);
    else if (collapsed[item.id]) collapsedLevels.push(item.level);
  }
  return hidden;
}

/**
 * Apply a manual row order (id → order) with the row-order engine. Without a
 * map the input sequence is returned untouched, so an unpositioned board/list
 * keeps the order the server already sorted by `Page.position`.
 */
export function orderRows(rows: DBRow[], rowOrder?: Record<string, number>): DBRow[] {
  if (!rowOrder) return rows;
  return sortByOrder(
    rows.map((row) => ({ id: row.id, row, order: rowOrder[row.id] })),
  ).map((entry) => entry.row);
}

/**
 * Persist a manual row order. The in-session `update` callback still runs first
 * so a move feels instant and stays the fallback when persistence fails; the
 * `reorderRowsAction` then renumbers `Page.position` for the parent database.
 * The failure is swallowed on purpose — a failed write must never undo the
 * order the user just saw.
 */
export function persistRowOrder(
  orderedIds: string[],
  update: (orderedIds: string[]) => void,
): void {
  update(orderedIds);
  if (orderedIds.length === 0) return;
  void reorderRowsAction(orderedIds[0], orderedIds).catch(() => {
    /* keep the in-session order */
  });
}

/* ---------------------------------------------------------------------------
   Structural ops adapters

   The table renderer's row/column affordances are the pure `@/lib/table-ops`
   operations: a list of ids is modelled as a one-cell-per-row (rows) or
   one-row (columns) matrix and the engine's move/insert/delete helpers return
   the new id order. They are total and immutable, so a guarded call (a stale
   index from a keyboard race) returns a fresh unchanged copy instead of
   throwing.
   --------------------------------------------------------------------------- */

/** Row ids after moving the row at `fromIndex` to `toIndex`. */
export function moveTableRowIds(
  ids: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  return moveTableRow(ids.map((id) => [id]), fromIndex, toIndex).map((row) => row[0]);
}

/** Row ids with a blank (as-yet-unidentified) row inserted at `atIndex`. */
export function insertTableRowIds(ids: readonly string[], atIndex: number): string[] {
  return insertTableRow(ids.map((id) => [id]), atIndex).map((row) => row[0]);
}

/** Row ids after deleting the row at `index`. */
export function deleteTableRowIds(ids: readonly string[], index: number): string[] {
  return deleteTableRow(ids.map((id) => [id]), index).map((row) => row[0]);
}

/** Column ids after moving the column at `fromIndex` to `toIndex`. */
export function moveTableColumnIds(
  ids: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  return moveTableColumn([[...ids]], fromIndex, toIndex)[0] ?? [];
}

/** Column ids with a blank column inserted at `atIndex`. */
export function insertTableColumnIds(ids: readonly string[], atIndex: number): string[] {
  return insertTableColumn([[...ids]], atIndex)[0] ?? [];
}

/** Column ids after deleting the column at `index`. */
export function deleteTableColumnIds(ids: readonly string[], index: number): string[] {
  return deleteTableColumn([[...ids]], index)[0] ?? [];
}

/* ---------------------------------------------------------------------------
   List outline adapter (`@/lib/list-ops`)

   A list view's rows can nest: each row carries a level and the outline rules
   (first row is the root, no row jumps more than one level deeper) are the
   pure `@/lib/list-ops` engine's job.
   --------------------------------------------------------------------------- */

/** Normalise a flat row list into a well-formed outline (level rules). */
export function outlineItems(
  rows: readonly { id: string; text?: string | null }[],
  levels: Record<string, number> | undefined,
): ListItem[] {
  return normalizeLevels(
    rows.map((row) => ({
      id: row.id,
      level: levels?.[row.id] ?? 0,
      text: row.text ?? "",
    })),
  );
}

/** The nesting level `rowId` takes after an indent/outdent request. */
export function nextOutlineLevel(
  items: readonly ListItem[],
  rowId: string,
  direction: "in" | "out",
): number {
  const next = direction === "in" ? indentItem(items, rowId) : outdentItem(items, rowId);
  return next.find((item) => item.id === rowId)?.level ?? 0;
}

/* ---------------------------------------------------------------------------
   Scroll-anchor adapter (`@/lib/scroll-anchor`)

   When a long list loads, sorts or filters, the rows above the viewport change
   height and a raw `scrollTop` would visibly jump. The anchor remembers the row
   under the viewport's top edge and re-pins it against the new measurements.
   --------------------------------------------------------------------------- */

/** One measured row: its stable id and its rendered height in pixels. */
export type AnchoredRow = { id: string; height: number };

/** Sum of the first `count` finite, non-negative heights. */
function sumHeights(heights: readonly number[], count: number): number {
  let total = 0;
  for (let index = 0; index < count && index < heights.length; index += 1) {
    const height = heights[index];
    total += typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
  }
  return total;
}

/** `id:height` signature used to detect that the rendered rows changed. */
function rowSignature(rows: readonly AnchoredRow[]): string {
  return rows.map((row) => `${row.id}:${row.height}`).join(",");
}

/**
 * The `scrollTop` that keeps a scrolled list pinned to the row under its top
 * edge after rows above it load, sort or filter. The row is located with
 * `nearestVisibleIndex`, captured with `captureAnchor` and re-pinned against the
 * next layout's measured row offsets with `restoreScrollTop`. The anchor is
 * matched by id, so a row inserted or removed above the viewport shifts the
 * pinned row instead of jumping to whatever now sits at the old index.
 */
export function anchoredScrollTop(
  scrollTop: number,
  previous: readonly AnchoredRow[],
  next: readonly AnchoredRow[],
): number {
  const safeScrollTop = Number.isFinite(scrollTop) ? scrollTop : 0;
  const previousHeights = previous.map((row) => row.height);
  const index = nearestVisibleIndex(safeScrollTop, previousHeights);
  if (index < 0) return Math.max(0, Math.floor(safeScrollTop));
  const anchor = captureAnchor({
    anchorIndex: index,
    anchorOffset: safeScrollTop - sumHeights(previousHeights, index),
    scrollTop: safeScrollTop,
  });
  const anchorId = previous[index]?.id;
  const matched = anchorId ? next.findIndex((row) => row.id === anchorId) : -1;
  const resolvedIndex = matched >= 0 ? matched : Math.min(index, next.length - 1);
  if (resolvedIndex < 0) return restoreScrollTop(anchor, { newOffsetOfIndex: 0 });
  return restoreScrollTop(anchor, {
    newOffsetOfIndex: sumHeights(next.map((row) => row.height), resolvedIndex),
  });
}

/**
 * Keep a scrolled container pinned across re-renders. A no-op when disabled or
 * when there is no container (e.g. server rendering), so an unanchored list
 * renders exactly as before.
 */
export function useScrollAnchor(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  rows: readonly AnchoredRow[],
): void {
  const previous = useRef<{ scrollTop: number; rows: readonly AnchoredRow[] } | null>(null);
  const signature = rowSignature(rows);
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const stored = previous.current;
    if (enabled && stored && rowSignature(stored.rows) !== signature) {
      node.scrollTop = anchoredScrollTop(stored.scrollTop, stored.rows, rows);
    }
    previous.current = { scrollTop: node.scrollTop, rows };
  }, [containerRef, enabled, signature, rows]);
}

/* ---------------------------------------------------------------------------
   Property-layout adapter (`@/lib/property-layout`)

   The older `@/lib/property-layout` array-of-columns model is superseded by the
   flat `@/lib/property-layout-engine`, but persisted pages still store the old
   shape. It is wired here as the adapter the panel consumes: it owns the
   untrusted-JSON parse and hands the engine a flat `order` to place.
   --------------------------------------------------------------------------- */

/** The cleaned two-column plan `@/lib/property-layout` yields for a page. */
export type PropertyColumnPlan = {
  /** Row-major order: left column top-to-bottom, then the right column. */
  order: string[];
  /** The persisted columns, normalised: known ids only, no blanks/duplicates. */
  columns: string[][];
};

/**
 * Adapter from the persisted legacy array-of-columns layout to the flat model
 * the two-column grid renders. `parsePropertyLayout` normalises untrusted JSON
 * against `knownIds` — dropping ids the page no longer has and any duplicate —
 * and `flattenLayout` flattens the columns into row-major order.
 */
export function legacyPropertyColumns(
  raw: unknown,
  knownIds: readonly string[],
): PropertyColumnPlan {
  const parsed = parseLegacyPropertyLayout(raw, knownIds);
  return {
    order: flattenLayout(parsed),
    columns: parsed.columns.map((column) => [...column]),
  };
}

/**
 * Resolve a persisted legacy layout into the two-column grid placements the
 * panel renders, through the newer `@/lib/property-layout-engine`. The legacy
 * module is the adapter: it normalises the stored JSON; the engine owns the
 * row-major placement and schema reconciliation (appending properties the
 * layout never listed).
 */
export function propertyPlacements(
  raw: unknown,
  properties: readonly DBProperty[],
): PropertyPlacement[] {
  const knownIds = properties.map((property) => property.id);
  const parsed = parseLegacyPropertyLayout(raw, knownIds);
  const columns: 1 | 2 = parsed.columns.length >= 2 ? 2 : 1;
  return resolvePropertyPlacements(
    { columns, order: flattenLayout(parsed), spans: {}, dividers: false },
    { properties },
  );
}

/** A column's `PropertyType` (Prisma, upper-case) → the sort engine's kind. */
function sortTypeFor(type: DBProperty["type"]): SortSpec["type"] {
  switch (type) {
    case "NUMBER":
      return "number";
    case "DATE":
      return "date";
    case "CHECKBOX":
      return "checkbox";
    case "SELECT":
    case "STATUS":
      return "select";
    default:
      return "text";
  }
}

/** The declared option order of a choice column, when it has one. */
function optionOrderFor(property: DBProperty): string[] | undefined {
  if (property.type !== "SELECT" && property.type !== "STATUS") return undefined;
  const options = property.config?.options;
  if (!options || options.length === 0) return undefined;
  return options.map((option) => option.id);
}

/**
 * Translate a view's stored sort keys (the existing sort-state UI) into the
 * sort engine's specs. A key for a column that no longer exists is dropped, so
 * a stale stored sort can never hide or reorder rows unexpectedly.
 */
export function sortSpecsFor(sorts: Sort[] | undefined, properties: DBProperty[]): SortSpec[] {
  if (!sorts || sorts.length === 0) return [];
  const byId = new Map(properties.map((property) => [property.id, property]));
  const specs: SortSpec[] = [];
  for (const sort of sorts) {
    const property = byId.get(sort.propertyId);
    if (!property) continue;
    specs.push({
      propertyId: sort.propertyId,
      dir: sort.direction,
      type: sortTypeFor(property.type),
      optionOrder: optionOrderFor(property),
      // The product convention: empty cells sit at the end in both directions.
      nulls: "last",
    });
  }
  return specs;
}

/**
 * A row's value for one sort key, mirroring the query layer: the primary
 * column is backed by `row.title` rather than a stored property value, so an
 * empty cell falls back to `{ text }`.
 */
function sortValueFor(
  row: DBRow,
  property: DBProperty | undefined,
  valueFor: (row: DBRow, propertyId: string) => unknown,
): unknown {
  const direct = property ? valueFor(row, property.id) : undefined;
  if (direct !== undefined && direct !== null) return direct;
  if (property?.config?.primary) return { text: row.title };
  return direct;
}

/**
 * Order rows with the shared multi-key sort engine. Rows are wrapped into the
 * engine's `SortRow` shape (carrying the original `DBRow`) so the sort is a
 * pure comparison, then unwrapped. No specs (or no resolvable keys) leaves the
 * incoming order untouched, so a view without sorts renders exactly as before.
 */
export function sortRowsWith(
  rows: readonly DBRow[],
  specs: SortSpec[],
  properties: DBProperty[],
  valueFor: (row: DBRow, propertyId: string) => unknown,
): DBRow[] {
  if (specs.length === 0) return [...rows];
  const byId = new Map(properties.map((property) => [property.id, property]));
  const wrapped = rows.map((row) => ({
    id: row.id,
    propertyValues: specs.map((spec) => ({
      propertyId: spec.propertyId,
      value: sortValueFor(row, byId.get(spec.propertyId), valueFor),
    })),
    row,
  }));
  return applySort(wrapped, specs).map((entry) => entry.row);
}

/** One TABLE footer calculation: a visible column plus the aggregation shown under it. */
export type TableFooterCalculation = { propertyId: string; fn: AggregationFn };

/**
 * Resolve the persisted table footer config into the footer engine's spec.
 *
 * The stored `footer` list (the settings popovers write `{ propertyId, fn }`)
 * is parsed through `parseFooterSpec` — which validates each function against
 * `AGGREGATION_FUNCTIONS`, dedupes by property and drops malformed entries — so
 * a persisted footer actually drives the table. Entries naming a property that
 * no longer exists are dropped, mirroring the old behaviour. With no usable
 * list a view that names an `aggregationPropertyId` (the settings "Summarize by
 * property" picker) still shows that one column's aggregate — `sum` for a
 * NUMBER column, a row count otherwise — so an unconfigured table is unchanged.
 */
export function tableFooterSpec(
  footer: readonly TableFooterCalculation[] | undefined,
  config: ViewConfig,
  properties: readonly DBProperty[],
): FooterSpec {
  const parsed = parseFooterSpec(footer);
  if (parsed.length > 0) {
    const known = new Set(properties.map((property) => property.id));
    return parsed.filter((entry) => known.has(entry.propertyId));
  }
  const propertyId = config.aggregationPropertyId;
  if (!propertyId) return [];
  const property = properties.find((candidate) => candidate.id === propertyId);
  if (!property) return [];
  const requested = AGGREGATION_FUNCTIONS.find(
    (candidate) => candidate.id === config.chartAggregate,
  )?.id;
  return [
    {
      propertyId,
      fn: requested ?? (property.type === "NUMBER" ? "sum" : "count"),
    },
  ];
}

/**
 * Group a table's ordered rows for per-group footers, through the shared
 * `@/lib/board-groups` engine. `null` when the view has no (resolvable)
 * `groupByPropertyId`, so an ungrouped table renders exactly as before.
 */
export function groupTableRows(
  rows: readonly DBRow[],
  properties: readonly DBProperty[],
  groupByPropertyId: string | null | undefined,
): ReturnType<typeof groupRowsByProperty<DBRow>> | null {
  if (!groupByPropertyId) return null;
  const property = properties.find((candidate) => candidate.id === groupByPropertyId);
  if (!property) return null;
  return groupRowsByProperty([...rows], properties, property.id);
}


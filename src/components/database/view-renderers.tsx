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
import { DUR, TAG_HUES, Z, tagClass, type TagHue } from "@/lib/design-tokens";
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
function listRowHeight(density: ListDensity): number {
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
  return TAG_HUES[hash % TAG_HUES.length];
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
function orderRows(rows: DBRow[], rowOrder?: Record<string, number>): DBRow[] {
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
function persistRowOrder(
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
function useScrollAnchor(
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
function sortSpecsFor(sorts: Sort[] | undefined, properties: DBProperty[]): SortSpec[] {
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
function sortRowsWith(
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

export function TableView({
  locale,
  workspaceSlug,
  workspaceId,
  properties,
  rows,
  primary,
  editable,
  config,
  valueFor,
  setValue,
  setPrimary,
  removeRow,
  onSaveTemplate,
  computedFor,
  relationOptionsFor,
  peopleOptions,
  headerConfig,
  onRunButton,
  onConfigureButton,
  onOpenPeek,
  onRunAi,
  colorOf,
  onEditFormula,
  onSetFormat,
  onEditOptions,
  editingProperty,
  setEditingProperty,
  onDeleteProperty,
  onRenameProperty,
  onDuplicateProperty,
  onReorderProperty,
  rowOrder,
  onReorderRows,
  onReorderColumns,
  preserveScroll = false,
  rowColorRules = [],
  footer,
  rowHeight,
  loading = false,
  onAddRow,
}: {
  locale: string;
  workspaceSlug: string;
  workspaceId: string;
  properties: DBProperty[];
  rows: DBRow[];
  primary: DBProperty | null;
  editable: boolean;
  /** Per-view configuration: which columns show, whether the first is pinned. */
  config: ViewConfig;
  valueFor: (row: DBRow, propertyId: string) => unknown;
  setValue: (rowId: string, propertyId: string, value: unknown) => void;
  setPrimary: (row: DBRow, text: string) => void;
  removeRow: (rowId: string) => void;
  onSaveTemplate: (row: DBRow) => void;
  computedFor: (row: DBRow, property: DBProperty) => string | undefined;
  relationOptionsFor: (propertyId: string) => { id: string; title: string; icon: string | null }[];
  /** Workspace members offered by PEOPLE cells. */
  peopleOptions: { id: string; name: string }[];
  headerConfig: HeaderConfig;
  onRunButton: (row: DBRow, property: DBProperty) => void;
  onConfigureButton: (property: DBProperty) => void;
  onOpenPeek: (row: DBRow) => void;
  onRunAi: (row: DBRow, property: DBProperty) => void;
  colorOf: (row: DBRow) => string | null;
  onEditFormula: (property: DBProperty) => void;
  onSetFormat: (property: DBProperty, format: string, currency?: string) => void;
  onEditOptions: (property: DBProperty) => void;
  editingProperty: string | null;
  setEditingProperty: (id: string | null) => void;
  onDeleteProperty: (propertyId: string) => void;
  onRenameProperty: (id: string, name: string) => void;
  onDuplicateProperty: (p: DBProperty) => void;
  onReorderProperty: (fromId: string, toId: string) => void;
  /** Manual row order (id → position); applied with the row-order engine. */
  rowOrder?: Record<string, number>;
  /** Persist a new row sequence (ids in display order); enables move up/down. */
  onReorderRows?: (orderedIds: string[]) => void;
  /**
   * Persist a new column sequence (ids in display order) after a header drag.
   * The new order is computed with `@/lib/table-ops`; absent falls back to
   * `onReorderProperty(fromId, toId)` so a drag behaves exactly as before.
   */
  onReorderColumns?: (orderedIds: string[]) => void;
  /** Preserve the scroll position while rows load/sort/filter (scroll anchor). */
  preserveScroll?: boolean;
  /** Conditional-formatting rules: row background/text via the colour engine. */
  rowColorRules?: RowColorRule[];
  /**
   * Per-column footer calculations (a visible column id → aggregation fn).
   * Absent renders the view's `aggregationPropertyId` column when one is set,
   * and no footer at all otherwise — so an unconfigured table is unchanged.
   */
  footer?: TableFooterCalculation[];
  /** Row-height mode (`short` / `medium` / `tall`); defaults to `medium`. */
  rowHeight?: string | null;
  /** Render the loading skeleton (matching the final layout) instead of rows. */
  loading?: boolean;
  /** Empty-state primary action; absent renders the hint without a button. */
  onAddRow?: () => void;
}) {
  const columns = visibleColumns(
    properties as unknown as QueryProperty[],
    config,
  ) as unknown as DBProperty[];
  const frozen = config.freezeFirstColumn !== false;
  const rowMode = resolveTableRowHeight(rowHeight);
  const cellClass = tableRowCellClass(rowMode);
  // Sorting goes through the shared engine (`@/lib/sort-compare`) driven by the
  // view's saved sort keys; the manual row order, when set, still wins on top.
  const sortSpecs = sortSpecsFor(config.sorts, properties);
  const orderedRows = orderRows(
    sortRowsWith(rows, sortSpecs, properties, valueFor),
    rowOrder,
  );
  // A scrolled table re-measures when its rows load, sort or filter; the scroll
  // anchor re-pins the row under the viewport's top edge instead of a raw offset.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useScrollAnchor(
    scrollRef,
    preserveScroll,
    orderedRows.map((row) => ({ id: row.id, height: tableRowHeight(rowMode) })),
  );
  // The sticky header drops a shadow only once the body has scrolled under it.
  const [scrolled, setScrolled] = useState(false);
  // Footer calculations run over the same ordered (filtered + sorted) rows the
  // body shows, so a footer total always agrees with the visible cells. The
  // persisted `footer` config is parsed by `@/lib/footer-calculations`; when the
  // view names a group-by column, the same spec is recomputed per group through
  // `forGroup`, so a grouped table reports each group's own totals.
  const footerSpec = tableFooterSpec(footer, config, properties);
  const footerResults = computeFooter(footerSpec, orderedRows, {
    valueFor,
    properties,
  });
  const footerByProperty = new Map(
    footerResults.map((result) => [result.propertyId, result] as const),
  );
  const groups = groupTableRows(orderedRows, properties, config.groupByPropertyId);
  const groupFooters = groups
    ? forGroup(groups, footerSpec, { valueFor, properties })
    : null;
  const globalIndexById = new Map(
    orderedRows.map((row, index) => [row.id, index] as const),
  );
  // HTML5 drag state for property reorder: the dragged column id and the
  // column currently under the pointer (highlighted as the drop target).
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  /** The cells of one footer row, for a per-column result lookup. */
  const renderFooterCells = (
    resultFor: (propertyId: string) => FooterColumnResult | undefined,
    testId: (name: string) => string,
  ) => (
    <>
      {columns.map((property, index) => {
        const result = resultFor(property.id);
        return (
          <td
            key={property.id}
            data-testid={testId(property.name)}
            className={cn(
              "sticky bottom-0 border-t border-border-strong bg-surface-2 px-3 py-1.5 tabular-nums text-muted",
              frozen && index === 0 && "left-0",
            )}
            style={{ zIndex: Z.sticky }}
          >
            {result && (
              <span className="flex flex-wrap items-center gap-x-1">
                <span className="font-medium">
                  {AGGREGATION_FUNCTIONS.find((entry) => entry.id === result.fn)?.label ??
                    result.fn}
                </span>
                <span>{result.display}</span>
              </span>
            )}
          </td>
        );
      })}
      <th
        className="sticky bottom-0 border-t border-border-strong bg-surface-2"
        style={{ zIndex: Z.sticky }}
      />
    </>
  );

  /** One body row: the same cells the table always rendered, parameterised so a
   * grouped and an ungrouped table share one implementation. */
  const renderRow = (row: DBRow, rowIndex: number) => {
    const rowStripe = (() => {
      const color = colorOf(row);
      return color ? `3px solid ${optionEdge(color)}` : undefined;
    })();
    // Conditional formatting from the view's colour rules: the engine
    // picks the first matching "row" rule and returns palette names.
    const resolved = evaluateRowColors(
      rowColorRules,
      row as unknown as QueryRow,
      properties as unknown as QueryProperty[],
    );
    const rowColors: { backgroundColor?: string; color?: string } = {};
    if (resolved.backgroundColor) {
      rowColors.backgroundColor = optionSurface(resolved.backgroundColor);
    }
    if (resolved.textColor) {
      rowColors.color = optionInk(resolved.textColor);
    }
    return (
      <tr
        key={row.id}
        style={rowColors}
        className="group u-colors border-b border-border last:border-0 hover:bg-surface-2/60"
      >
        {columns.map((property, index) => {
          const isPrimary = property.id === primary?.id;
          return (
            <td
              key={property.id}
              // The row colour stripe lives on the first cell so it
              // stays visible when that cell is pinned (sticky).
              style={index === 0 ? { borderLeft: rowStripe } : undefined}
              className={cn(
                cellClass,
                "align-top",
                frozen &&
                  index === 0 &&
                  "sticky left-0 bg-bg group-hover:bg-surface-2/60",
              )}
            >
              {isPrimary ? (
                <input
                  defaultValue={row.title}
                  aria-label={t(locale, "nameLabel")}
                  readOnly={!editable}
                  placeholder={t(locale, "untitled")}
                  onBlur={(e) =>
                    e.target.value !== row.title &&
                    setPrimary(row, e.target.value)
                  }
                  className="w-full bg-transparent outline-none placeholder:text-muted"
                />
              ) : (
                <Cell
                  locale={locale}
                  property={property}
                  value={valueFor(row, property.id)}
                  computed={computedFor(row, property)}
                  relationOptions={relationOptionsFor(property.id)}
                  peopleOptions={peopleOptions}
                  workspaceId={workspaceId}
                  onRunButton={
                    property.type === "BUTTON"
                      ? () => onRunButton(row, property)
                      : undefined
                  }
                  onRunAi={
                    property.type === "AI_AUTOFILL"
                      ? () => onRunAi(row, property)
                      : undefined
                  }
                  editable={editable}
                  onChange={(v) => setValue(row.id, property.id, v)}
                  // Conditional formatting: the same rules that tint the
                  // row are offered to the cell so `"cell"`-target rules
                  // (which `evaluateRowColors` ignores) paint their cell;
                  // the full row + schema let a rule read other cells.
                  colorRules={rowColorRules}
                  row={row}
                  properties={properties}
                />
              )}
            </td>
          );
        })}
        <td className="px-1 align-top">
          <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100">
            {editable && onReorderRows && (
              <>
                <button
                  type="button"
                  title={t(locale, "moveUp")}
                  aria-label={`${t(locale, "moveUp")}: ${row.title}`}
                  disabled={rowIndex === 0}
                  onClick={() =>
                    persistRowOrder(
                      moveTableRowIds(
                        orderedRows.map((entry) => entry.id),
                        rowIndex,
                        rowIndex - 1,
                      ),
                      onReorderRows,
                    )
                  }
                  className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title={t(locale, "moveDown")}
                  aria-label={`${t(locale, "moveDown")}: ${row.title}`}
                  disabled={rowIndex === orderedRows.length - 1}
                  onClick={() =>
                    persistRowOrder(
                      moveTableRowIds(
                        orderedRows.map((entry) => entry.id),
                        rowIndex,
                        rowIndex + 1,
                      ),
                      onReorderRows,
                    )
                  }
                  className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <a
              href={`/w/${workspaceSlug}/${row.id}`}
              title={t(locale, "openAsPage")}
              aria-label={`${t(locale, "openAsPage")}: ${row.title}`}
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              title={t(locale, "openSidePeek")}
              aria-label={`${t(locale, "openSidePeek")}: ${row.title}`}
              onClick={() => onOpenPeek(row)}
              className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
            {editable && (
              <button
                type="button"
                title={t(locale, "saveAsTemplate")}
                aria-label={`${t(locale, "saveAsTemplate")}: ${row.title}`}
                onClick={() => onSaveTemplate(row)}
                className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg"
              >
                <LayoutTemplate className="h-3.5 w-3.5" />
              </button>
            )}
            {editable && (
              <button
                type="button"
                title={t(locale, "deleteRow")}
                aria-label={`${t(locale, "deleteRow")}: ${row.title}`}
                onClick={() => removeRow(row.id)}
                className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  };

  if (loading) {
    return (
      <div
        data-testid="table-skeleton"
        aria-busy="true"
        className="overflow-hidden rounded-lg border border-border"
      >
        <table className="w-full min-w-[680px] border-collapse text-sm">
          <thead>
            <tr className="bg-surface">
              {columns.map((property) => (
                <th key={property.id} className="border-b border-border px-3 py-2">
                  <span className="notion-skeleton block h-3 w-20 rounded-sm" />
                </th>
              ))}
              <th className="w-16 border-b border-border" />
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: skeletonCount("table") }).map((_, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border last:border-0">
                {columns.map((property) => (
                  <td key={property.id} className={cn(cellClass, "align-top")}>
                    <span className="notion-skeleton block h-3 w-full max-w-32 rounded-sm" />
                  </td>
                ))}
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      data-scrolled={scrolled ? "true" : "false"}
      className="scrollbar-thin overflow-x-auto rounded-lg border border-border"
    >
      <table className="w-full min-w-[680px] border-collapse text-sm">
        <thead>
          <tr className="bg-surface text-left text-xs text-muted">
            {columns.map((property, index) => (
              <th
                key={property.id}
                data-testid={`property-header-${property.name}`}
                draggable={editable && editingProperty !== property.id}
                onDragStart={(event) => {
                  setDraggingId(property.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", property.id);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setOverId(null);
                }}
                onDragOver={(event) => {
                  if (!editable || draggingId === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setOverId(property.id);
                }}
                onDragLeave={() => setOverId((current) => (current === property.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = event.dataTransfer.getData("text/plain") || draggingId;
                  setDraggingId(null);
                  setOverId(null);
                  if (!from || from === property.id) return;
                  const ids = columns.map((column) => column.id);
                  const fromIndex = ids.indexOf(from);
                  const toIndex = ids.indexOf(property.id);
                  if (fromIndex === -1 || toIndex === -1) return;
                  // `@/lib/table-ops` computes the column order the drag implies;
                  // a caller that only understands (fromId, toId) still gets the
                  // legacy callback, so a header drag behaves exactly as before.
                  const orderedIds = moveTableColumnIds(ids, fromIndex, toIndex);
                  if (onReorderColumns) onReorderColumns(orderedIds);
                  else onReorderProperty(from, property.id);
                }}
                className={cn(
                  "border-b border-border-strong px-3 py-2 font-medium",
                  "sticky top-0 u-colors",
                  frozen && index === 0 && "left-0",
                  "bg-surface",
                  scrolled && "shadow-1",
                  editable && "cursor-grab active:cursor-grabbing",
                  overId === property.id &&
                    draggingId !== null &&
                    draggingId !== property.id &&
                    "bg-surface-2",
                )}
                style={{ zIndex: Z.sticky }}
              >
                <PropertyHeader
                  locale={locale}
                  property={property}
                  editable={editable}
                  editing={editingProperty === property.id}
                  setEditing={setEditingProperty}
                  onDelete={onDeleteProperty}
                  onRename={onRenameProperty}
                  onDuplicate={onDuplicateProperty}
                  onEditFormula={onEditFormula}
                  onSetFormat={onSetFormat}
                  onEditOptions={onEditOptions}
                  headerConfig={headerConfig}
                  onConfigureButton={onConfigureButton}
                />
              </th>
            ))}
            <th
              className="sticky top-0 w-16 border-b border-border-strong bg-surface"
              style={{ zIndex: Z.sticky }}
            />
          </tr>
        </thead>
        {groups && groups.length > 0 ? (
          groups.map((group, groupIndex) => {
            const groupFooterByProperty = new Map(
              (groupFooters?.[groupIndex]?.footers ?? []).map(
                (result) => [result.propertyId, result] as const,
              ),
            );
            return (
              <tbody key={group.key}>
                <tr className="bg-surface-2/60 text-xs">
                  <td
                    colSpan={columns.length + 1}
                    data-testid={`table-group-${group.key}`}
                    className="px-3 py-1.5 font-medium"
                  >
                    {group.label}{" "}
                    <span className="text-muted">{group.rows.length}</span>
                  </td>
                </tr>
                {group.rows.map((row) =>
                  renderRow(row, globalIndexById.get(row.id) ?? 0),
                )}
                {footerSpec.length > 0 && (
                  <tr className="text-xs">
                    {renderFooterCells(
                      (propertyId) => groupFooterByProperty.get(propertyId),
                      (name) => `table-footer-${group.key}-${name}`,
                    )}
                  </tr>
                )}
              </tbody>
            );
          })
        ) : (
          <tbody>
            {orderedRows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-10">
                  <div className="notion-empty" data-testid="table-empty">
                    <span className="notion-empty-icon" aria-hidden="true">
                      <Inbox className="h-5 w-5" />
                    </span>
                    <p className="text-sm font-medium text-fg">{t(locale, "dbNoRows")}</p>
                    <p className="text-xs">{t(locale, "dbNoRowsHint")}</p>
                    {onAddRow && (
                      <button
                        type="button"
                        data-testid="table-add-row"
                        onClick={onAddRow}
                        aria-label={t(locale, "newRow")}
                        className="focus-ring u-interactive mt-1 inline-flex items-center gap-1 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t(locale, "newRow")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {orderedRows.map((row, rowIndex) => renderRow(row, rowIndex))}
          </tbody>
        )}
        {(!groups || groups.length === 0) && footerByProperty.size > 0 && (
          <tfoot>
            <tr className="text-xs">
              {renderFooterCells(
                (propertyId) => footerByProperty.get(propertyId),
                (name) => `table-footer-${name}`,
              )}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function ListView({
  locale,
  workspaceSlug,
  properties,
  rows,
  valueFor,
  editable,
  density: densityProp,
  onDensityChange,
  rowOrder,
  onReorderRows,
  levels,
  onLevelChange,
  preserveScroll = false,
  loading = false,
  onAddRow,
}: {
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  valueFor: (row: DBRow, propertyId: string) => unknown;
  editable: boolean;
  locale: string;
  /** List density; defaults to compact and toggles in place. */
  density?: ListDensity;
  /** Persist a density change; without it the toggle is local-only. */
  onDensityChange?: (density: ListDensity) => void;
  /** Manual row order (id → position); applied with the row-order engine. */
  rowOrder?: Record<string, number>;
  /** Persist a new row sequence (ids in display order); enables move up/down. */
  onReorderRows?: (orderedIds: string[]) => void;
  /**
   * Per-row nesting depth (row id → level), normalised through `@/lib/list-ops`
   * so the outline is always well-formed. Absent keeps every row at the top
   * level, so an un-nested list renders exactly as before.
   */
  levels?: Record<string, number>;
  /** Persist a row's new nesting level; enables the indent/outdent controls. */
  onLevelChange?: (rowId: string, level: number) => void;
  /** Preserve the scroll position while rows load/sort/filter (scroll anchor). */
  preserveScroll?: boolean;
  /** Render the loading skeleton (matching the final layout) instead of rows. */
  loading?: boolean;
  /** Empty-state primary action; absent renders the hint without a button. */
  onAddRow?: () => void;
}) {
  const status = properties.find(
    (p) => p.type === "STATUS" || p.type === "SELECT",
  );
  const [localDensity, setLocalDensity] = useState<ListDensity>("compact");
  // Collapsed outlines: a parent's chevron hides its descendants (the pure
  // `collapsedListIds` walk over the normalised outline).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const density = densityProp ?? localDensity;
  const orderedRows = orderRows(rows, rowOrder);
  // Nesting levels run through `@/lib/list-ops` (`normalizeLevels`): the outline
  // is repaired to the engine's rules before it is drawn, so a level that jumps
  // more than one step deeper can never render a broken tree.
  const outline = outlineItems(orderedRows, levels);
  const levelById = new Map(outline.map((item) => [item.id, item.level]));
  // A row is a parent when the next outline entry nests one level deeper.
  const parents = new Set(
    outline
      .filter((item, index) => (outline[index + 1]?.level ?? 0) > item.level)
      .map((item) => item.id),
  );
  const hidden = collapsedListIds(outline, collapsed);
  // Only indent/guide a list that actually nests, so a flat list keeps its
  // previous row geometry (no chevron column).
  const outlineEnabled = parents.size > 0;
  // The list re-measures as rows load/sort/filter; the anchor keeps the row
  // under the viewport's top edge pinned instead of the raw offset.
  const listRef = useRef<HTMLUListElement | null>(null);
  useScrollAnchor(
    listRef,
    preserveScroll,
    orderedRows.map((row) => ({ id: row.id, height: listRowHeight(density) })),
  );
  const setDensity = (next: ListDensity) => {
    if (onDensityChange) onDensityChange(next);
    else setLocalDensity(next);
  };
  if (loading) {
    return (
      <ul
        data-testid="list-skeleton"
        aria-busy="true"
        className="divide-y divide-border rounded-lg border border-border"
      >
        {Array.from({ length: skeletonCount("list") }).map((_, index) => (
          <li key={index} className="flex items-center gap-3 px-4 py-2">
            <span className="notion-skeleton h-4 w-4 rounded-sm" />
            <span className="notion-skeleton h-3 w-1/3 rounded-sm" />
            <span className="notion-skeleton ms-auto h-3 w-16 rounded-sm" />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div>
      {/* Density toggle: `densityOptions` drives both the choices and labels. */}
      <div className="mb-1 flex items-center justify-end gap-0.5" role="group">
        {densityOptions().map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={density === option.value}
            onClick={() => setDensity(option.value)}
            className={cn(
              "focus-ring u-interactive rounded px-2 py-0.5 text-xs",
              density === option.value
                ? "bg-surface-2 text-fg"
                : "text-muted hover:bg-surface-2",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <ul ref={listRef} className="divide-y divide-border rounded-lg border border-border">
        {orderedRows.map((row, rowIndex) => {
          if (hidden.has(row.id)) return null;
          const model = listRowModel(row, properties, { density });
          const value = status ? (valueFor(row, status.id) as { optionId?: string }) : undefined;
          const option = status?.config?.options?.find((o) => o.id === value?.optionId);
          const level = levelById.get(row.id) ?? 0;
          const isCollapsed = collapsed[row.id] === true;
          const hasChildren = parents.has(row.id);
          return (
            <li
              key={row.id}
              className="relative flex items-center"
              style={level > 0 ? { paddingLeft: level * 16 } : undefined}
            >
              {listIndentGuides(level).map((offset) => (
                <span
                  key={offset}
                  aria-hidden="true"
                  data-testid={`list-guide-${row.id}-${offset}`}
                  className="pointer-events-none absolute inset-y-0 w-px"
                  style={{ left: offset, backgroundColor: "var(--border-strong)" }}
                />
              ))}
              {outlineEnabled &&
                (hasChildren ? (
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    aria-label={
                      isCollapsed ? t(locale, "toggleExpand") : t(locale, "toggleCollapse")
                    }
                    onClick={() =>
                      setCollapsed((current) => ({
                        ...current,
                        [row.id]: !(current[row.id] === true),
                      }))
                    }
                    className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-2"
                  >
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 u-transform",
                        !isCollapsed && "rotate-90",
                      )}
                    />
                  </button>
                ) : (
                  <span className="w-6 shrink-0" aria-hidden="true" />
                ))}
              <Link
                href={`/w/${workspaceSlug}/${row.id}`}
                className={cn(
                  "u-colors flex min-w-0 flex-1 items-center gap-3 hover:bg-surface-2/60",
                  model.expanded ? "px-4 py-3" : "px-4 py-2",
                )}
              >
                <span className="w-4 text-center">{row.icon ?? "📄"}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {model.primary || t(locale, "untitled")}
                  </span>
                  {model.expanded && !isCollapsed && model.secondary && (
                    <span className="block truncate text-xs text-muted">
                      {model.secondary}
                    </span>
                  )}
                </span>
                {option && (
                  <span
                    className="rounded px-1.5 py-0.5 text-xs"
                    style={{
                      backgroundColor: optionSurface(option.color),
                      color: optionInk(option.color),
                    }}
                  >
                    {option.name}
                  </span>
                )}
                {editable && <ExternalLink className="h-3.5 w-3.5 text-muted" />}
              </Link>
              {editable && onReorderRows && (
                <span className="flex items-center gap-0.5 pr-2">
                  <button
                    type="button"
                    title={t(locale, "moveUp")}
                    aria-label={`${t(locale, "moveUp")}: ${row.title}`}
                    disabled={rowIndex === 0}
                    onClick={() =>
                      persistRowOrder(
                        reorderRows(
                          orderedRows.map((entry) => entry.id),
                          rowIndex,
                          rowIndex - 1,
                        ),
                        onReorderRows,
                      )
                    }
                    className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title={t(locale, "moveDown")}
                    aria-label={`${t(locale, "moveDown")}: ${row.title}`}
                    disabled={rowIndex === orderedRows.length - 1}
                    onClick={() =>
                      persistRowOrder(
                        reorderRows(
                          orderedRows.map((entry) => entry.id),
                          rowIndex,
                          rowIndex + 1,
                        ),
                        onReorderRows,
                      )
                    }
                    className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
              {editable && onLevelChange && (
                <span className="flex items-center gap-0.5 pr-2">
                  <button
                    type="button"
                    title={t(locale, "outdentWord")}
                    aria-label={`${t(locale, "outdentWord")}: ${row.title}`}
                    disabled={level === 0}
                    onClick={() => onLevelChange(row.id, nextOutlineLevel(outline, row.id, "out"))}
                    className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title={t(locale, "indentWord")}
                    aria-label={`${t(locale, "indentWord")}: ${row.title}`}
                    onClick={() => onLevelChange(row.id, nextOutlineLevel(outline, row.id, "in"))}
                    className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </li>
          );
        })}
        {orderedRows.length === 0 && (
          <li className="px-4 py-10">
            <div className="notion-empty" data-testid="list-empty">
              <span className="notion-empty-icon" aria-hidden="true">
                <Inbox className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-fg">{t(locale, "dbNoRows")}</p>
              <p className="text-xs">{t(locale, "dbNoRowsHint")}</p>
              {onAddRow && (
                <button
                  type="button"
                  data-testid="list-add-row"
                  onClick={onAddRow}
                  aria-label={t(locale, "newRow")}
                  className="focus-ring u-interactive mt-1 inline-flex items-center gap-1 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t(locale, "newRow")}
                </button>
              )}
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Property panel (two-column display)

   A page's properties can be laid out two to a row. The persisted layout is the
   older `@/lib/property-layout` array-of-columns JSON; the panel consumes that
   module as the adapter and renders through the flat
   `@/lib/property-layout-engine` placements.
   --------------------------------------------------------------------------- */

/**
 * Render a page's properties in one or two columns from a persisted layout.
 *
 * `layout` is the untrusted legacy array-of-columns value (a JSON string or
 * object). `propertyPlacements` adapts it through `@/lib/property-layout` and
 * resolves the grid through `@/lib/property-layout-engine`; an absent or
 * malformed layout renders every property once, in schema order.
 */
export function PropertyPanel({
  properties,
  layout,
  values,
  computedFor,
}: {
  properties: DBProperty[];
  /** Persisted legacy `PropertyLayout` (array-of-columns JSON) — untrusted. */
  layout?: unknown;
  /** Resolve a property's stored value. */
  values: (propertyId: string) => unknown;
  /** Optional computed display that wins over the stored value. */
  computedFor?: (property: DBProperty) => string | undefined;
}) {
  const placements = propertyPlacements(layout, properties);
  const hasSecondColumn = placements.some((placement) => placement.column === 1);
  const byId = new Map(properties.map((property) => [property.id, property]));
  return (
    <div
      data-testid="property-panel"
      className="grid gap-x-6 gap-y-2"
      style={{ gridTemplateColumns: `repeat(${hasSecondColumn ? 2 : 1}, minmax(0, 1fr))` }}
    >
      {placements.map((placement) => {
        const property = byId.get(placement.propertyId);
        if (!property) return null;
        const displayed =
          computedFor?.(property) ??
          formatCell(values(property.id), property as unknown as QueryProperty);
        return (
          <div
            key={placement.propertyId}
            data-testid={`property-${property.name}`}
            data-column={placement.column}
            className="flex items-center justify-between gap-2 text-sm"
            style={placement.span === 2 ? { gridColumn: "1 / -1" } : undefined}
          >
            <span className="truncate text-muted">{property.name}</span>
            <span className="truncate">{displayed || "—"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** WIP badge colours keyed by `checkWip`'s grade (all from the token set). */
const WIP_STYLES: Record<WipStatus, string> = {
  ok: "bg-surface-2 text-muted",
  at: "bg-warning-soft text-warning",
  over: "bg-danger-soft text-danger",
};

/**
 * Functions a grouped view reports per group, in display order. `sum`/`average`
 * only mean something for numeric cells and fall back to the lib's "—" sentinel
 * when a group holds none; `countValues` counts non-empty cells (rollup's
 * "count" semantics) so it differs from the plain row count beside the header.
 */
const GROUP_SUMMARY_FNS: readonly AggregationFn[] = ["sum", "average", "countValues"];

/** One formatted aggregation in a group's summary line. */
type GroupSummaryEntry = { fn: AggregationFn; label: string; display: string };

/** Map a NUMBER column's stored format/currency onto the aggregator's options. */
function aggregateOptionsFor(property: DBProperty): AggregateOptions | undefined {
  const format = property.config?.format;
  if (format === "percent") return { showAs: "percent" };
  if (format === "currency") {
    const currency = property.config?.currency;
    return currency ? { showAs: "currency", currency } : { showAs: "currency" };
  }
  return undefined;
}

/**
 * Summarize one group's rows through the shared `aggregateGroups` helper so a
 * board column agrees with the footer/chart maths instead of re-implementing
 * any of it. `property` is the metric column; an empty or non-numeric group
 * reports the aggregator's "—" display rather than a fabricated zero.
 */
function summarizeGroup(
  rows: readonly DBRow[],
  property: DBProperty,
  valueFor: (row: DBRow, propertyId: string) => unknown,
): GroupSummaryEntry[] {
  const options = aggregateOptionsFor(property);
  const specs: Record<string, GroupAggregationSpec<DBRow>> = {};
  for (const fn of GROUP_SUMMARY_FNS) {
    specs[fn] = {
      fn,
      value: (row) => valueFor(row, property.id),
      ...(options ? { options } : {}),
    };
  }
  const [aggregated] = aggregateGroups(
    [{ key: property.id, label: property.name, rows: [...rows] }],
    specs,
  );
  if (!aggregated) return [];
  return GROUP_SUMMARY_FNS.map((fn) => ({
    fn,
    label: AGGREGATION_FUNCTIONS.find((entry) => entry.id === fn)?.label ?? fn,
    display: aggregated.aggregates[fn]?.display ?? "—",
  }));
}

export function BoardView({
  locale,
  workspaceSlug,
  workspaceId,
  properties,
  rows,
  colorOf,
  groupBy,
  primary,
  valueFor,
  setValue,
  computedFor,
  peopleOptions,
  editable,
  visibleGroups: visibleGroupsProp,
  laneBy,
  wipLimits,
  aggregationPropertyId,
  loading = false,
  onAddRow,
}: {
  locale: string;
  workspaceSlug: string;
  workspaceId: string;
  properties: DBProperty[];
  rows: DBRow[];
  colorOf: (row: DBRow) => string | null;
  groupBy: string | null;
  primary: DBProperty | null;
  valueFor: (row: DBRow, propertyId: string) => unknown;
  setValue: (rowId: string, propertyId: string, value: unknown) => void;
  computedFor?: (row: DBRow, property: DBProperty) => string | undefined;
  peopleOptions?: { id: string; name: string }[];
  editable: boolean;
  /**
   * Column whose cells feed each board column's group summary (Sum / Average /
   * Count). Defaults to the first NUMBER column; a board without one — or with
   * the prop pointing at an unknown id — renders its columns exactly as before.
   */
  aggregationPropertyId?: string | null;
  /** Per-column visibility: a column key mapped to `false` is hidden. */
  visibleGroups?: Record<string, boolean>;
  /**
   * Optional swimlane grouping: a second property id slices the rows into
   * horizontal lanes while the board columns stay vertical. Unknown / equal to
   * `groupBy` falls back to the plain single-axis board.
   */
  laneBy?: string | null;
  /**
   * Optional per-column WIP limits (keyed by column key, i.e. option id or the
   * empty key). When supplied, every column header shows its graded count/limit
   * badge; unset (or a column without a valid limit) renders exactly as before.
   */
  wipLimits?: WipLimits;
  /** Render the loading skeleton (matching the final layout) instead of columns. */
  loading?: boolean;
  /** Empty-state primary action; absent renders the hint without a button. */
  onAddRow?: () => void;
}) {
  // Card drag state: the card in flight, the gap it would drop into, and the
  // card still animating back to rest after a drop (`animate-scale-in`).
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; index: number } | null>(null);
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const groupProperty = properties.find((p) => p.id === groupBy);
  const statusProperty = properties.find(
    (p) => p.type === "STATUS" || p.type === "SELECT",
  );
  const property = groupProperty ?? statusProperty;

  if (loading) {
    return (
      <div
        data-testid="board-skeleton"
        aria-busy="true"
        className="flex gap-4 overflow-x-auto pb-2"
      >
        {[0, 1, 2].map((column) => (
          <div key={column} className="w-64 shrink-0 space-y-2">
            <span className="notion-skeleton block h-4 w-24 rounded-sm" />
            {Array.from({ length: skeletonCount("boardCards") }).map((_, card) => (
              <div
                key={card}
                className="rounded-lg border border-border bg-bg p-3 shadow-1"
              >
                <span className="notion-skeleton block h-3 w-2/3 rounded-sm" />
                <span className="notion-skeleton mt-2 block h-3 w-1/2 rounded-sm" />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (!property) {
    return (
      <div className="notion-empty rounded-lg border border-dashed border-border" data-testid="board-empty">
        <span className="notion-empty-icon" aria-hidden="true">
          <Inbox className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-fg">{t(locale, "boardNeedsGroup")}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="notion-empty rounded-lg border border-dashed border-border" data-testid="board-empty">
        <span className="notion-empty-icon" aria-hidden="true">
          <Inbox className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-fg">{t(locale, "dbNoRows")}</p>
        <p className="text-xs">{t(locale, "dbNoRowsHint")}</p>
        {onAddRow && (
          <button
            type="button"
            data-testid="board-add-row"
            onClick={onAddRow}
            aria-label={t(locale, "newRow")}
            className="focus-ring u-interactive mt-1 inline-flex items-center gap-1 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            {t(locale, "newRow")}
          </button>
        )}
      </div>
    );
  }

  // A STATUS property whose options declare buckets (To-do / In progress /
  // Done) drives one column per bucket; every other grouping goes through the
  // board-groups engine, which orders one column per declared option and
  // appends the Empty bucket (multi-select rows land in every matching one).
  const statusBucketBoard = hasStatusGroups(property);
  const visibility = visibleGroupsProp ?? {};
  const localizedGroups: Record<string, string> = {
    todo: t(locale, "statusGroupTodo"),
    doing: t(locale, "statusGroupDoing"),
    done: t(locale, "statusGroupDone"),
  };
  type BoardColumn = {
    key: string;
    label: string;
    color: string;
    rows: DBRow[];
    /**
     * The option id a drop writes, `null` for the Empty column, or `undefined`
     * for a status-bucket column (not an option, so a drop is visual only).
     */
    optionId?: string | null;
  };
  const columns: BoardColumn[] = statusBucketBoard
    ? statusGroupColumns(rows, properties, property.id, t(locale, "noValue"))
        .map((column) => ({
          key: column.id,
          label: localizedGroups[column.id] ?? column.name,
          color: column.color,
          rows: column.rows,
        }))
        .filter((column) => visibility[column.key] !== false)
    : filterVisibleGroups(
        groupRowsByProperty(rows, properties, property.id),
        visibility,
      ).map((group) => ({
        key: group.key,
        label: group.label,
        color: group.color ?? "gray",
        rows: group.rows,
        optionId: group.optionId,
      }));
  // A second grouping property turns the single-axis board into a swimlane
  // board: `buildSwimlanes` owns the horizontal lanes (membership, order and
  // counts), while the board-groups columns above stay the vertical axis — so
  // an unknown / equal lane id, or a board with no rows, renders exactly as it
  // did before.
  const laneProperty =
    laneBy && laneBy !== property.id
      ? properties.find((candidate) => candidate.id === laneBy)
      : undefined;
  const swimlaneMatrix = laneProperty
    ? buildSwimlanes(rows, laneProperty.id, property.id)
    : null;
  const swimlaneCounts = swimlaneMatrix ? laneCounts(swimlaneMatrix) : [];

  // Per-column WIP standings (kanban limits). Graded once from the full column
  // rows — not a lane's slice — so every lane of a swimlane board reports the
  // same status. With no limits every column is `ok` and no badge is drawn.
  const wipCheck = checkWip(
    columns.map((column) => ({
      key: column.key,
      label: column.label,
      optionId: column.key,
      rows: column.rows,
    })),
    wipLimits ?? {},
  );
  const wipFor = (key: string) =>
    wipCheck.columns.find((column) => column.key === key);

  // Group summary metric: an explicit `aggregationPropertyId` wins, otherwise
  // the first NUMBER column that is neither the group/primary column. `null`
  // (no metric) skips the summary entirely, so a board without an aggregatable
  // column is byte-for-byte its previous self.
  const summaryProperty =
    (aggregationPropertyId
      ? properties.find((candidate) => candidate.id === aggregationPropertyId)
      : undefined) ??
    properties.find(
      (candidate) =>
        candidate.type === "NUMBER" &&
        candidate.id !== property.id &&
        !candidate.config?.primary,
    ) ??
    null;

  const renderCard = (row: DBRow, columnKey: string, index: number) => {
    const dragging = dragRowId === row.id;
    return (
      <Link
        key={row.id}
        href={`/w/${workspaceSlug}/${row.id}`}
        draggable={editable}
        onDragStart={(event) => {
          if (!editable) return;
          setDragRowId(row.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.id);
        }}
        onDragOver={(event) => {
          if (!editable || dragRowId === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget({ key: columnKey, index });
        }}
        onDragEnd={() => {
          setDragRowId(null);
          setDropTarget(null);
        }}
        data-dragging={dragging ? "true" : "false"}
        className={boardCardClass({ dragging, settling: settlingId === row.id })}
        style={{
          borderLeft: (() => {
            const color = colorOf(row);
            return color
              ? `3px solid ${optionEdge(color)}`
              : undefined;
          })(),
        }}
      >
        <p className="text-sm font-medium">
          {row.icon ? `${row.icon} ` : ""}
          {row.title || t(locale, "untitled")}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {properties
            .filter(
              (p) =>
                p.id !== property.id &&
                p.id !== primary?.id &&
                !p.config?.primary,
            )
            .slice(0, 3)
            .map((p) => (
              <Cell
                key={p.id}
                locale={locale}
                property={p}
                value={valueFor(row, p.id)}
                computed={computedFor?.(row, p)}
                peopleOptions={peopleOptions}
                workspaceId={workspaceId}
                editable={editable}
                onChange={(v) => setValue(row.id, p.id, v)}
              />
            ))}
        </div>
      </Link>
    );
  };

  /** The dashed slot a dragged card would drop into (the target gap). */
  const dropPlaceholder = (columnKey: string, index: number) => (
    <div
      key={`drop-${columnKey}-${index}`}
      aria-hidden="true"
      data-testid={`board-drop-placeholder-${columnKey}`}
      className="h-16 rounded-lg border border-dashed border-border-strong bg-surface-2/40"
    />
  );

  /** Move the dropped card into `column`, animating the settle with the spring. */
  const dropIntoColumn = (column: BoardColumn, event: ReactDragEvent) => {
    event.preventDefault();
    const rowId = event.dataTransfer.getData("text/plain") || dragRowId;
    setDragRowId(null);
    setDropTarget(null);
    if (!editable || !rowId || property.type === "MULTI_SELECT") return;
    const value = boardDropValue(column.optionId);
    if (value === undefined) return;
    setValue(rowId, property.id, value);
    setSettlingId(rowId);
    window.setTimeout(
      () => setSettlingId((current) => (current === rowId ? null : current)),
      DUR.base,
    );
  };

  const renderColumn = (column: BoardColumn, groupRows: DBRow[]) => {
    const wip = wipFor(column.key);
    // Aggregation runs over this column's own rows, so a swimlane's slice
    // reports its lane totals rather than the whole column's.
    const summary = summaryProperty
      ? summarizeGroup(groupRows, summaryProperty, valueFor)
      : [];
    const target = dropTarget?.key === column.key ? dropTarget.index : null;
    return (
      <div
        key={column.key}
        className="w-64 shrink-0"
        onDragOver={(event) => {
          if (!editable || dragRowId === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget((current) =>
            current && current.key === column.key
              ? current
              : { key: column.key, index: groupRows.length },
          );
        }}
        onDrop={(event) => dropIntoColumn(column, event)}
      >
        <div
          className="u-colors sticky top-0 mb-2 flex items-center gap-2 bg-bg py-1 text-sm"
          style={{ zIndex: Z.sticky }}
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{
              backgroundColor: optionInk(column.color),
            }}
          />
          <span className="font-medium" data-testid={`board-column-${column.key}`}>
            {column.label}
          </span>
          <span
            data-testid={`board-count-${column.key}`}
            className="rounded-sm bg-surface-2 px-1.5 text-xs tabular-nums text-muted"
          >
            {groupRows.length}
          </span>
          {wip && wip.limit !== undefined && (
            <span
              data-testid={`board-wip-${column.key}`}
              data-wip-status={wip.status}
              title={`${wip.count}/${wip.limit}`}
              className={cn(
                "rounded-sm px-1 py-0.5 text-3xs font-medium tabular-nums",
                WIP_STYLES[wip.status],
              )}
            >
              {wip.count}/{wip.limit}
            </span>
          )}
        </div>
        {summaryProperty && summary.length > 0 && (
          <p
            data-testid={`board-aggregation-${column.key}`}
            className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted"
          >
            <span className="font-medium">{summaryProperty.name}</span>
            {summary.map((entry) => (
              <span key={entry.fn}>
                {entry.label} {entry.display}
              </span>
            ))}
          </p>
        )}
        <div className="space-y-2">
          {groupRows.map((row, index) => (
            <Fragment key={row.id}>
              {target === index && dropPlaceholder(column.key, index)}
              {renderCard(row, column.key, index)}
            </Fragment>
          ))}
          {target === groupRows.length && dropPlaceholder(column.key, groupRows.length)}
        </div>
      </div>
    );
  };

  if (swimlaneMatrix && swimlaneMatrix.lanes.length > 0) {
    const laneRowIds = new Map<string, Set<string>>();
    for (const lane of swimlaneMatrix.lanes) {
      const ids = new Set<string>();
      for (const bucket of lane.buckets) {
        for (const row of bucket.rows) ids.add(row.id);
      }
      laneRowIds.set(lane.key, ids);
    }

    return (
      <div className="space-y-4 pb-2">
        {swimlaneMatrix.lanes.map((lane, index) => {
          const ids = laneRowIds.get(lane.key) ?? new Set<string>();
          return (
            <div key={lane.key} data-testid={`swimlane-${lane.key}`}>
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="font-medium">{lane.label}</span>
                <span className="text-muted">
                  {swimlaneCounts[index]?.count ?? ids.size}
                </span>
              </div>
              <div className="flex gap-4 overflow-x-auto">
                {columns.map((column) =>
                  renderColumn(
                    column,
                    column.rows.filter((row) => ids.has(row.id)),
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {columns.map((column) => renderColumn(column, column.rows))}
    </div>
  );
}

/** Whether an untrusted config value is a plain object (not an array/null). */
function isPlainConfig(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A gallery card's resolved preview plus whether the engine path is active. */
export type GalleryPreviewPlan = {
  /** True when the view carries a usable preview config. */
  active: boolean;
  /** The canonical config handed to `resolveCardPreview`. */
  config: PreviewConfig;
};

/**
 * Map a gallery view's persisted preview config onto `@/lib/gallery-preview`'s
 * `PreviewConfig`. The persisted `previewPropertyId` (the settings popover's
 * cover choice) becomes the engine's `coverPropertyId`, and any richer
 * `previewConfig` object is parsed (`parsePreviewConfig`) so malformed stored
 * JSON falls back to the engine defaults instead of throwing.
 *
 * `active` is false only when the view has no preview config at all, so an
 * unconfigured gallery keeps rendering through `@/lib/view-presets`.
 */
export function galleryPreviewPlan(
  previewPropertyId: string | null | undefined,
  previewConfig?: unknown,
): GalleryPreviewPlan {
  const base = isPlainConfig(previewConfig) ? previewConfig : {};
  const withCover = previewPropertyId
    ? { ...base, coverPropertyId: previewPropertyId }
    : base;
  const parsed = parsePreviewConfig(withCover);
  // A malformed richer config must not lose an otherwise valid cover choice.
  const config: PreviewConfig = parsed.ok
    ? parsed.config
    : {
        fit: "cover",
        ...(previewPropertyId ? { coverPropertyId: previewPropertyId } : {}),
      };
  const active = Boolean(
    config.coverPropertyId ||
      config.contentPropertyId ||
      (config.showProperties && config.showProperties.length > 0),
  );
  return { active, config };
}

/**
 * Resolve one card through the gallery-preview engine. Kept as a named helper
 * so the config ⇄ engine mapping is testable without rendering the component.
 */
export function resolveGalleryCard(
  row: DBRow,
  plan: GalleryPreviewPlan,
  properties: readonly GalleryPropertyLike[],
): ResolvedCardPreview {
  return resolveGalleryPreview(row, plan.config, { properties });
}

export function GalleryView({
  locale,
  workspaceSlug,
  properties,
  rows,
  primary,
  valueFor,
  computedFor,
  cardSize: cardSizeProp,
  previewPropertyId,
  previewConfig,
  loading = false,
  onAddRow,
}: {
  locale: string;
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  primary: DBProperty | null;
  valueFor: (row: DBRow, propertyId: string) => unknown;
  computedFor?: (row: DBRow, property: DBProperty) => string | undefined;
  /** Force a card size; without it the size follows the container width. */
  cardSize?: CardSizeName;
  /**
   * The property each card draws its preview image from (the persisted gallery
   * setting). Mapped onto `@/lib/gallery-preview`'s `coverPropertyId`; the
   * engine then resolves the cover, the text excerpt and the badge strip. Unset
   * or blank with no `previewConfig` keeps the previous `@/lib/view-presets`
   * card, so an unconfigured gallery renders exactly as it did before.
   */
  previewPropertyId?: string | null;
  /**
   * The full persisted gallery preview config (`coverPropertyId`,
   * `contentPropertyId`, `fit`, `aspect`, `showTitle`, `showProperties`) when a
   * caller carries one. Untrusted JSON; `galleryPreviewPlan` parses it and
   * `previewPropertyId` overrides its cover.
   */
  previewConfig?: unknown;
  /** Render skeleton cards (matching the final grid) instead of rows. */
  loading?: boolean;
  /** Empty-state primary action; absent renders the hint without a button. */
  onAddRow?: () => void;
}) {
  // The card size tracks the container: `cardSizeFor` maps a measured width to
  // a preset, and `CARD_SIZES` supplies the column count, aspect and whether
  // the cover is shown. Initial width is 0 (the densest preset) so server and
  // client render identically until the observer reports the real width.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const size = cardSizeProp ?? cardSizeFor(containerWidth);
  const spec = CARD_SIZES[size];

  // The preset engine reads lower-case property types (e.g. "files"), matching
  // `COVER_PROPERTY_TYPES`; `DatabaseView` stores them upper-case.
  const presetProperties = properties.map((property) => ({
    id: property.id,
    name: property.name,
    type: property.type.toLowerCase(),
  }));
  // The persisted preview choice wins; unset or blank keeps the automatic
  // cover — the first cover-eligible (FILES/MEDIA/URL) property, matching
  // `resolveCardPreview` — so a gallery without a stored choice only changes
  // when the schema itself does. `coverPropertyId` is the single source for
  // both the preview and the field that must not be repeated below.
  const coverPropertyId =
    previewPropertyId ||
    properties.find((property) =>
      (COVER_PROPERTY_TYPES as readonly string[]).includes(
        property.type.toLowerCase(),
      ),
    )?.id ||
    null;
  // The gallery-preview engine (covers + excerpts + badges). Active only when a
  // persisted preview config exists; otherwise the legacy card below is used so
  // an unconfigured gallery is byte-for-byte unchanged. The primary/name
  // property is the card title, so it is never offered as a badge.
  const plan = galleryPreviewPlan(previewPropertyId, previewConfig);
  const previewProperties = presetProperties.filter(
    (property) => property.id !== primary?.id,
  );
  const fields = cardFieldOrder(
    // The primary/name property is the card title, so it is never listed twice.
    previewProperties,
    {
      previewPropertyId: coverPropertyId,
      maxFields: spec.showPreview ? 3 : 4,
    },
  )
    .map((id) => properties.find((property) => property.id === id))
    .filter((property): property is DBProperty => property !== undefined);

  if (loading) {
    return (
      <div
        data-testid="gallery-skeleton"
        aria-busy="true"
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: gallerySkeletonCards(size) }).map((_, index) => (
          <div
            key={index}
            className="overflow-hidden rounded-lg border border-border bg-bg"
          >
            {spec.showPreview && (
              <div className="notion-skeleton" style={{ aspectRatio: spec.aspect }} />
            )}
            <div className="space-y-2 p-3">
              <span className="notion-skeleton block h-3 w-3/4 rounded-sm" />
              <span className="notion-skeleton block h-3 w-1/2 rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        className="notion-empty rounded-lg border border-dashed border-border"
        data-testid="gallery-empty"
      >
        <span className="notion-empty-icon" aria-hidden="true">
          <Inbox className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-fg">{t(locale, "noCardsYet")}</p>
        <p className="text-xs">{t(locale, "dbNoRowsHint")}</p>
        {onAddRow && (
          <button
            type="button"
            data-testid="gallery-add-row"
            onClick={onAddRow}
            aria-label={t(locale, "newRow")}
            className="focus-ring u-interactive mt-1 inline-flex items-center gap-1 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            {t(locale, "newRow")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}
      data-card-size={size}
    >
      {rows.map((row) => {
        // Config present → resolve cover/excerpt/badges through the engine;
        // otherwise keep the legacy preset preview.
        const card = plan.active
          ? resolveGalleryCard(row, plan, previewProperties)
          : null;
        const preview = card
          ? null
          : resolveCardPreview(row, presetProperties, { coverPropertyId });
        return (
          <Link
            key={row.id}
            href={`/w/${workspaceSlug}/${row.id}`}
            className="group overflow-hidden rounded-lg border border-border bg-bg u-surface hover:bg-surface-2"
          >
            {spec.showPreview && (
              <div
                className="grid place-items-center overflow-hidden bg-surface text-3xl"
                style={{ aspectRatio: card?.cover?.aspect ?? spec.aspect }}
                data-testid="gallery-banner"
              >
                {card?.cover ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- raw attachment URLs are not statically analysable for next/image */
                  <img
                    src={card.cover.url}
                    alt={row.title}
                    className="u-transform h-full w-full object-cover group-hover:scale-[1.02]"
                    style={{ objectFit: card.cover.fit }}
                  />
                ) : preview?.kind === "cover" ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- raw attachment URLs are not statically analysable for next/image */
                  <img
                    src={preview.value}
                    alt={row.title}
                    className="u-transform h-full w-full object-cover group-hover:scale-[1.02]"
                  />
                ) : (
                  preview?.value ?? row.icon ?? "📄"
                )}
              </div>
            )}
            <div className="p-3">
              <p className="truncate text-sm font-medium">
                {!spec.showPreview && <span className="mr-1">{row.icon ?? "📄"}</span>}
                {row.title || t(locale, "untitled")}
              </p>
              {card?.excerpt && (
                <p
                  data-testid="gallery-excerpt"
                  className="mt-1 line-clamp-2 text-xs text-muted"
                >
                  {card.excerpt.text}
                </p>
              )}
              {card && card.badges.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1" data-testid="gallery-badges">
                  {card.badges.map((badge) => (
                    <span
                      key={badge.propertyId}
                      data-testid={`gallery-badge-${badge.propertyId}`}
                      className={tagClass(galleryBadgeHue(badge.propertyId))}
                    >
                      {badge.value}
                    </span>
                  ))}
                </div>
              )}
              {!card && (
                <dl className="mt-2 space-y-1">
                  {fields.map((property) => (
                    <div key={property.id} className="flex items-center justify-between gap-2 text-xs text-muted">
                      <dt className="truncate">{property.name}</dt>
                      <dd className="truncate">
                        {(computedFor?.(row, property) ||
                          formatCell(
                            valueFor(row, property.id),
                            property as unknown as QueryProperty,
                          )) || "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Calendar view

   The month grid now lives in `./timeline-chart-views` as the multi-day
   `CalendarView`: each dated row is projected to a half-open `[start, end)`
   span and packed into non-overlapping lanes per week by the pure
   `@/lib/calendar-multiday` engine, so a multi-day event draws one bar across
   every day it touches instead of collapsing onto its start day. The prop
   surface is unchanged, so this renderer keeps its existing callers — it is
   re-exported here to avoid a duplicate implementation drifting from the one
   that is actually rendered.
   --------------------------------------------------------------------------- */

export { CalendarView } from "./timeline-chart-views";

/* ---------------------------------------------------------------------------
   Form view
   --------------------------------------------------------------------------- */

/** The resolved form plan the renderer consumes. */
export type FormPlan = {
  /** Stored form schema with each field enriched from the live property. */
  schema: FormSchema;
  /** The visible (non-hidden) questions, in order. */
  fields: FormField[];
  /** Display metadata: title, description, submit label, success message. */
  meta: FormDescription;
};

/**
 * Resolve a form plan from the database's properties plus the stored
 * `config.form`.
 *
 * A stored `FormSchema` (`{ fields: [...] }`) is parsed through
 * `parseFormSchema`; when it carries no questions (the legacy `fieldIds`
 * config shape) the schema is built from the live properties through
 * `buildFormSchema`, so stale/computed ids are still skipped. Every field is
 * then enriched with its live property's `type`/`config` so
 * `validateSubmission` enforces the real cell constraints and `toRowValues`
 * stores exactly what a cell write would. Pure and never throws, so it is
 * testable without rendering.
 */
export function resolveFormPlan(properties: DBProperty[], config: unknown): FormPlan {
  const parsed = parseFormSchema(config);
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const resolvedFields =
    parsed.fields.length > 0 ? parsed.fields : buildFormSchema(properties, config);
  const schema: FormSchema = {
    ...parsed,
    fields: resolvedFields.map((field) => {
      const property = propertyById.get(field.propertyId);
      if (!property) return field;
      return {
        ...field,
        type: property.type,
        config: (property.config ?? {}) as Record<string, unknown>,
      };
    }),
  };
  return {
    schema,
    fields: schema.fields.filter((field) => field.hidden !== true),
    meta: describeForm(schema),
  };
}

/**
 * Render a database as a respondent form.
 *
 * `resolveFormPlan` resolves the ordered questions from the stored form config
 * (`config.form`: a `FormSchema`, or the legacy `fieldIds` shape) plus the
 * live properties, so computed/system types are skipped and stale ids are
 * tolerated. Each question is edited with the existing `Cell` editor for its
 * property type, so the form can only offer answers the rest of the app
 * accepts. On submit, `validateSubmission` gates the answers with the same
 * rules a cell write uses and `toRowValues` maps an accepted submission to the
 * `{ propertyId, value }` cells a new row stores.
 *
 * `onSubmit` is the create-row seam: it receives those cells in field order and
 * the parent creates the row (the same `createRowAction` path the table's "+"
 * uses) and applies the values. Without it the form is render-only — the
 * questions show read-only and no submit is offered.
 */
export function FormView({
  locale,
  properties,
  config,
  onSubmit,
  loading = false,
}: {
  locale: string;
  properties: DBProperty[];
  /** Stored form configuration (`config.form`); every value is untrusted JSON. */
  config?: unknown;
  /**
   * Persist an accepted submission: receives the mapped property values for a
   * new row, in field order. Absent → the form renders read-only.
   */
  onSubmit?: (values: { propertyId: string; value: unknown }[]) => void;
  /** Render the loading skeleton (matching the final layout) instead of fields. */
  loading?: boolean;
}) {
  const { schema, fields, meta } = resolveFormPlan(properties, config);
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  // Pre-fill any stored field defaults so a fresh respondent starts where the
  // form config says; a form with no defaults is exactly as empty as before.
  const [answers, setAnswers] = useState<Record<string, unknown>>(() =>
    defaultAnswers(schema),
  );
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const editable = onSubmit !== undefined;

  if (loading) {
    return (
      <div
        data-testid="form-skeleton"
        aria-busy="true"
        className="mx-auto max-w-xl space-y-4 rounded-lg border border-border p-4"
      >
        {Array.from({ length: skeletonCount("form") }).map((_, index) => (
          <div key={index} className="space-y-2">
            <span className="notion-skeleton block h-3 w-24 rounded-sm" />
            <span className="notion-skeleton block h-9 w-full rounded-sm" />
          </div>
        ))}
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div
        className="notion-empty mx-auto max-w-xl rounded-lg border border-dashed border-border"
        data-testid="form-empty"
      >
        <span className="notion-empty-icon" aria-hidden="true">
          <Inbox className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-fg">{t(locale, "dbNoRows")}</p>
        <p className="text-xs">{t(locale, "dbNoRowsHint")}</p>
      </div>
    );
  }

  const setAnswer = (propertyId: string, value: unknown) => {
    setAnswers((current) => {
      const next = { ...current };
      // A cleared editor (empty text/number) writes nothing, mirroring an
      // unanswered optional question; objects like `{ checked: false }` stay.
      if (value === undefined || value === null) delete next[propertyId];
      else next[propertyId] = value;
      return next;
    });
    // Editing a field clears its previous error so the form can be resubmitted.
    setIssues((current) =>
      current.some((issue) => issue.propertyId === propertyId)
        ? current.filter((issue) => issue.propertyId !== propertyId)
        : current,
    );
  };

  const submit = () => {
    if (!onSubmit) return;
    // Client-side validation through the same engine a server action would use,
    // so only an acceptable submission is handed to the create-row seam.
    const validation = validateSubmission(schema, answers);
    if (!validation.ok) {
      setIssues(validation.issues);
      return;
    }
    setIssues([]);
    // Hand the mapped cells to the parent before clearing, so the success
    // state can offer "Add another" without resubmitting the same answers.
    onSubmit(toRowValues(schema, answers));
    setAnswers(defaultAnswers(schema));
    setSubmitted(true);
  };

  // After a successful submit the form becomes a small confirmation with an
  // "Add another" button, so a respondent can log several rows in a row.
  if (submitted && editable) {
    return (
      <div
        data-testid="form-success"
        role="status"
        className="mx-auto max-w-xl space-y-3 rounded-lg border border-border p-6 text-center"
      >
        <p className="text-sm font-medium">{meta.successMessage}</p>
        <button
          type="button"
          data-testid="form-add-another"
          onClick={() => {
            setAnswers(defaultAnswers(schema));
            setSubmitted(false);
          }}
          aria-label={t(locale, "add")}
          className="focus-ring u-interactive rounded bg-accent px-4 py-1.5 text-sm text-accent-fg hover:opacity-90"
        >
          {t(locale, "add")}
        </button>
      </div>
    );
  }

  return (
    <form
      data-testid="form-view"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="mx-auto max-w-xl space-y-4 rounded-lg border border-border p-4"
    >
      {meta.title !== "" && (
        <h2 data-testid="form-title" className="text-base font-medium">
          {meta.title}
        </h2>
      )}
      {meta.description !== "" && <p className="text-sm text-muted">{meta.description}</p>}
      {fields.map((field) => {
        const property = propertyById.get(field.propertyId);
        if (!property) return null;
        const issue = issues.find((candidate) => candidate.propertyId === field.propertyId);
        return (
          <div key={field.propertyId} className="space-y-1">
            <div className="flex items-center gap-1 text-sm font-medium">
              <span>{field.label}</span>
              {field.required && (
                <span className="text-danger" aria-hidden="true">
                  *
                </span>
              )}
            </div>
            <div className="u-surface focus-within:outline-none rounded-sm border border-border bg-bg px-2 py-1.5 focus-within:border-[var(--ring)] focus-within:shadow-[var(--shadow-focus)]">
              <Cell
                locale={locale}
                property={property}
                value={answers[field.propertyId]}
                editable={editable}
                onChange={(value) => setAnswer(field.propertyId, value)}
              />
            </div>
            {issue && (
              <ul
                data-testid={`form-issue-${field.propertyId}`}
                className="space-y-0.5 text-xs text-danger"
              >
                {issue.errors.map((error) => (
                  <li key={error.code}>{error.message}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {editable && (
        <button
          type="submit"
          data-testid="form-submit"
          aria-label={meta.submitLabel}
          className="focus-ring u-interactive rounded bg-accent px-4 py-1.5 text-sm text-accent-fg hover:opacity-90"
        >
          {meta.submitLabel}
        </button>
      )}
    </form>
  );
}

/* ---------------------------------------------------------------------------
   View settings (filter / sort / group)
   --------------------------------------------------------------------------- */

/**
 * Table layout for the database surface.
 *
 * Extracted from ./view-renderers; the public import path stays stable through
 * that module's re-export. Table-specific paste, selection, ordering and footer
 * behaviour lives here; shared row motion and height helpers live in
 * ./view-renderers-helpers.
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
import { Checkbox } from "@/components/ui/checkbox";
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

import {
  TABLE_ROW_HEIGHTS,
  TABLE_ROW_HEIGHT_MODES,
  resolveTableRowHeight,
  tableRowHeight,
  tableRowCellClass,
  CARD_LIFT,
  boardCardClass,
  boardDropValue,
  galleryBadgeHue,
  SKELETON_COUNTS,
  skeletonCount,
  gallerySkeletonCards,
  listIndentGuides,
  collapsedListIds,
  moveTableRowIds,
  insertTableRowIds,
  deleteTableRowIds,
  moveTableColumnIds,
  insertTableColumnIds,
  deleteTableColumnIds,
  outlineItems,
  nextOutlineLevel,
  anchoredScrollTop,
  useScrollAnchor,
  legacyPropertyColumns,
  propertyPlacements,
  listRowHeight,
  orderRows,
  persistRowOrder,
  sortSpecsFor,
  sortRowsWith,
  tableFooterSpec,
  groupTableRows,
  useMotionEnabled,
  useRowPresence,
  type TableRowHeight,
  type TableFooterCalculation,
} from "./view-renderers-helpers";
export * from "./view-renderers-helpers";

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
  addRowPending = false,
  selectedRowIds = [],
  onToggleRow,
  onToggleAllRows,
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
  /**
   * P2-T10 (M7) — true while one create is on the wire; the empty-state add
   * row button renders `disabled` + `aria-busy` until the guard settles.
   */
  addRowPending?: boolean;
  /** Row ids currently selected for the bulk bar (optional, table-only). */
  selectedRowIds?: readonly string[];
  /** Toggle one row's selection; absent renders no selection control. */
  onToggleRow?: (rowId: string) => void;
  /** Toggle the whole visible selection; absent renders no select-all box. */
  onToggleAllRows?: (rowIds: string[]) => void;
}) {
  const columns = visibleColumns(
    properties as unknown as QueryProperty[],
    config,
  ) as unknown as DBProperty[];
  const selected = new Set(selectedRowIds);
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
  // Group reveal (spec §4 "Expand group reveals rows"): a heading folds its
  // rows shut. The collapse is a display-only, in-session toggle — it never
  // touches the view config, and expanding simply lets the rows fade back in.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const groupKeyByRowId = new Map<string, string>();
  for (const group of groups ?? []) {
    for (const row of group.rows) {
      if (!groupKeyByRowId.has(row.id)) groupKeyByRowId.set(row.id, group.key);
    }
  }
  const visibleRows = orderedRows.filter(
    (row) => collapsedGroups[groupKeyByRowId.get(row.id) ?? ""] !== true,
  );
  // Rows fade in/out by presence; the FLIP hook then slides the rows a change
  // displaces. Both key off the ordered ids, never the cell content.
  const rowMotion = useRowPresence(visibleRows, (row) => row.id);
  useFlipList(scrollRef, [rowIdsKey(rowMotion.rows.map((row) => row.id))]);
  const motionGroups = groupTableRows(
    rowMotion.rows,
    properties,
    config.groupByPropertyId,
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
    const motion = rowMotion.stateOf(row.id);
    return (
      <tr
        key={row.id}
        data-flip-id={row.id}
        data-motion={motion}
        style={{ ...rowColors, ...rowMotionStyle(motion) }}
        className={cn(
          "group u-colors border-b border-border last:border-0 hover:bg-surface-2/60",
          rowMotionClass(motion),
        )}
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
                index === 0 && "min-w-[15rem]",
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
          <div className="flex items-center justify-end gap-0.5">
            {onToggleRow ? (
              <Checkbox
                size="sm"
                aria-label={`${t(locale, "select")}: ${row.title}`}
                checked={selected.has(row.id)}
                onCheckedChange={() => onToggleRow(row.id)}
                className="me-1 shrink-0"
              />
            ) : null}
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
                  className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-bg disabled:opacity-30"
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
                  className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-bg disabled:opacity-30"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <a
              href={`/w/${workspaceSlug}/${row.id}`}
              title={t(locale, "openAsPage")}
              aria-label={`${t(locale, "openAsPage")}: ${row.title}`}
              className="flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-bg"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              title={t(locale, "openSidePeek")}
              aria-label={`${t(locale, "openSidePeek")}: ${row.title}`}
              onClick={() => onOpenPeek(row)}
              className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-bg"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
            {editable && (
              <button
                type="button"
                title={t(locale, "saveAsTemplate")}
                aria-label={`${t(locale, "saveAsTemplate")}: ${row.title}`}
                onClick={() => onSaveTemplate(row)}
                className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-bg"
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
                className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded-control text-muted hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            </div>
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
                  index === 0 && "min-w-[15rem]",
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
            >
              {onToggleRow && onToggleAllRows ? (
                <Checkbox
                  size="sm"
                  aria-label={t(locale, "selectAll")}
                  checked={
                    visibleRows.length > 0 &&
                    visibleRows.every((row) => selected.has(row.id))
                      ? true
                      : visibleRows.some((row) => selected.has(row.id))
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={() =>
                    onToggleAllRows(visibleRows.map((row) => row.id))
                  }
                />
              ) : null}
            </th>
          </tr>
        </thead>
        {motionGroups && motionGroups.length > 0 ? (
          motionGroups.map((group, groupIndex) => {
            const groupFooterByProperty = new Map(
              (groupFooters?.[groupIndex]?.footers ?? []).map(
                (result) => [result.propertyId, result] as const,
              ),
            );
            const collapsedGroup = collapsedGroups[group.key] === true;
            const groupCount = groups?.[groupIndex]?.rows.length ?? group.rows.length;
            return (
              <tbody key={group.key}>
                <tr className="bg-surface-2/60 text-xs">
                  <td
                    colSpan={columns.length + 1}
                    data-testid={`table-group-${group.key}`}
                    className="px-3 py-1.5 font-medium"
                  >
                    <button
                      type="button"
                      aria-expanded={!collapsedGroup}
                      aria-label={
                        collapsedGroup
                          ? t(locale, "toggleExpand")
                          : t(locale, "toggleCollapse")
                      }
                      data-testid={`table-group-toggle-${group.key}`}
                      onClick={() =>
                        setCollapsedGroups((current) => ({
                          ...current,
                          [group.key]: !(current[group.key] === true),
                        }))
                      }
                      className="focus-ring u-interactive flex items-center gap-1 rounded-control"
                    >
                      <ChevronRight className={groupChevronClass(!collapsedGroup)} />
                      {group.label}
                    </button>{" "}
                    <span className="text-muted">{groupCount}</span>
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
                        disabled={addRowPending}
                        aria-busy={addRowPending}
                        aria-label={t(locale, "newRow")}
                        className="focus-ring u-interactive mt-1 inline-flex items-center gap-1 rounded-control bg-action px-3 py-1 text-xs font-medium text-action-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t(locale, "newRow")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {rowMotion.rows.map((row) =>
              renderRow(row, globalIndexById.get(row.id) ?? 0),
            )}
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

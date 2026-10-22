/**
 * List layout for the database surface.
 *
 * Extracted from ./view-renderers; the public import path stays stable through
 * that module's re-export. The list owns indentation, collapse state and its
 * own row presence, while shared ordering/motion helpers stay in
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

export { TableView } from "./table-view";

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
  // Collapsing a parent hides its descendants: those rows fade out while the
  // rows below slide up, and fade back in when the parent reopens. Presence
  // keys off the ordered ids, so typing never triggers it.
  const visibleRows = orderedRows.filter((row) => !hidden.has(row.id));
  const rowMotion = useRowPresence(visibleRows, (row) => row.id);
  useFlipList(listRef, [rowIdsKey(rowMotion.rows.map((row) => row.id))]);
  const indexById = new Map(
    orderedRows.map((row, index) => [row.id, index] as const),
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
        {rowMotion.rows.map((row) => {
          const rowIndex = indexById.get(row.id) ?? 0;
          const model = listRowModel(row, properties, { density });
          const value = status ? (valueFor(row, status.id) as { optionId?: string }) : undefined;
          const option = status?.config?.options?.find((o) => o.id === value?.optionId);
          const level = levelById.get(row.id) ?? 0;
          const isCollapsed = collapsed[row.id] === true;
          const hasChildren = parents.has(row.id);
          const motion = rowMotion.stateOf(row.id);
          return (
            <li
              key={row.id}
              data-flip-id={row.id}
              data-motion={motion}
              className={cn("relative flex items-center", rowMotionClass(motion))}
              style={{
                ...(level > 0 ? { paddingLeft: level * 16 } : {}),
                ...rowMotionStyle(motion),
              }}
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

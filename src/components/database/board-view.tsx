/**
 * Board layout for the database surface.
 *
 * Extracted from ./view-renderers; the public import path stays stable through
 * that module's re-export. Grouping, swimlanes, WIP limits and board-specific
 * aggregation live here; shared ordering/motion helpers stay in
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

export { ListView } from "./list-view";

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
  addRowPending = false,
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
  /**
   * P2-T10 (M7) — true while one create is on the wire; the empty-state add
   * row button renders `disabled` + `aria-busy` until the guard settles.
   */
  addRowPending?: boolean;
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

  // The column plan and the card-presence hooks are computed before the
  // loading/empty early returns, so the hooks run on every render (Rules of
  // Hooks). A board without a resolvable grouping property has no columns.
  const statusBucketBoard = property ? hasStatusGroups(property) : false;
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
  const buildColumns = (inputRows: DBRow[]): BoardColumn[] => {
    if (!property) return [];
    // A STATUS property whose options declare buckets (To-do / In progress /
    // Done) drives one column per bucket; every other grouping goes through the
    // board-groups engine, which orders one column per declared option and
    // appends the Empty bucket (multi-select rows land in every matching one).
    return statusBucketBoard
      ? statusGroupColumns(inputRows, properties, property.id, t(locale, "noValue"))
          .map((column) => ({
            key: column.id,
            label: localizedGroups[column.id] ?? column.name,
            color: column.color,
            rows: column.rows,
          }))
          .filter((column) => visibility[column.key] !== false)
      : filterVisibleGroups(
          groupRowsByProperty(inputRows, properties, property.id),
          visibility,
        ).map((group) => ({
          key: group.key,
          label: group.label,
          color: group.color ?? "gray",
          rows: group.rows,
          optionId: group.optionId,
        }));
  };
  const columns = buildColumns(rows);
  // Cards fade in/out by presence; the FLIP hook then slides the cards a change
  // displaces (including a cross-column drag). Both key off the ordered ids.
  const boardRef = useRef<HTMLDivElement | null>(null);
  const cardMotion = useRowPresence(
    columns.flatMap((column) => column.rows),
    (row) => row.id,
  );
  useFlipList(boardRef, [rowIdsKey(cardMotion.rows.map((row) => row.id))]);
  // Exiting cards are re-grouped into their column so they fade in place.
  const renderColumns = buildColumns(cardMotion.rows);

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
    );
  }

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
  // The lanes to render include exiting cards, so a moved/deleted card fades in
  // place rather than disappearing from its lane.
  const renderSwimlanes = laneProperty
    ? buildSwimlanes(cardMotion.rows, laneProperty.id, property.id)
    : null;

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
    const motion = cardMotion.stateOf(row.id);
    return (
      <Link
        key={row.id}
        data-flip-id={row.id}
        data-motion={motion}
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
        className={cn(
          boardCardClass({ dragging, settling: settlingId === row.id }),
          rowMotionClass(motion),
        )}
        style={{
          borderLeft: (() => {
            const color = colorOf(row);
            return color
              ? `3px solid ${optionEdge(color)}`
              : undefined;
          })(),
          ...rowMotionStyle(motion),
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

  if (renderSwimlanes && renderSwimlanes.lanes.length > 0) {
    const laneRowIds = new Map<string, Set<string>>();
    for (const lane of renderSwimlanes.lanes) {
      const ids = new Set<string>();
      for (const bucket of lane.buckets) {
        for (const row of bucket.rows) ids.add(row.id);
      }
      laneRowIds.set(lane.key, ids);
    }

    return (
      <div ref={boardRef} className="space-y-4 pb-2">
        {renderSwimlanes.lanes.map((lane, index) => {
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
                {renderColumns.map((column) =>
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
    <div ref={boardRef} className="flex gap-4 overflow-x-auto pb-2">
      {renderColumns.map((column) => renderColumn(column, column.rows))}
    </div>
  );
}

/** Whether an untrusted config value is a plain object (not an array/null). */

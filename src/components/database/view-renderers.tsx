"use client";

import { Cell, PropertyHeader } from "./view-parts";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CalendarDays,
  ExternalLink,
  LayoutTemplate,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
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
  aggregate,
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
  answersToPropertyValues,
  buildFormSchema,
  resolveFormMeta,
  validateSubmission,
  type FormIssue,
} from "@/lib/form-view";
import { OPTION_COLORS, type DBProperty, type DBRow, type HeaderConfig } from "@/components/database/database-types";

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
 * Resolve the table's footer calculations.
 *
 * An explicit per-column `footer` list wins, filtered down to the columns that
 * still exist and the functions the aggregator knows. With no explicit list a
 * view that already names an `aggregationPropertyId` (the settings "Summarize
 * by property" picker) shows that one column's aggregate — `sum` for a NUMBER
 * column, a row count otherwise — so the footer works with the settings that
 * exist today. Anything unresolvable yields no footer, leaving the table
 * exactly as it rendered before.
 */
function resolveFooterCalculations(
  footer: readonly TableFooterCalculation[] | undefined,
  config: ViewConfig,
  properties: readonly DBProperty[],
): TableFooterCalculation[] {
  if (footer && footer.length > 0) {
    const known = new Set(properties.map((property) => property.id));
    return footer.filter(
      (entry) =>
        known.has(entry.propertyId) &&
        AGGREGATION_FUNCTIONS.some((candidate) => candidate.id === entry.fn),
    );
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
  rowColorRules = [],
  footer,
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
  /** Conditional-formatting rules: row background/text via the colour engine. */
  rowColorRules?: RowColorRule[];
  /**
   * Per-column footer calculations (a visible column id → aggregation fn).
   * Absent renders the view's `aggregationPropertyId` column when one is set,
   * and no footer at all otherwise — so an unconfigured table is unchanged.
   */
  footer?: TableFooterCalculation[];
}) {
  const columns = visibleColumns(
    properties as unknown as QueryProperty[],
    config,
  ) as unknown as DBProperty[];
  const frozen = config.freezeFirstColumn !== false;
  // Sorting goes through the shared engine (`@/lib/sort-compare`) driven by the
  // view's saved sort keys; the manual row order, when set, still wins on top.
  const sortSpecs = sortSpecsFor(config.sorts, properties);
  const orderedRows = orderRows(
    sortRowsWith(rows, sortSpecs, properties, valueFor),
    rowOrder,
  );
  // Footer calculations run over the same ordered (filtered + sorted) rows the
  // body shows, so a footer total always agrees with the visible cells.
  const footerCalculations = resolveFooterCalculations(footer, config, columns);
  const footerFnByProperty = new Map(
    footerCalculations.map((entry) => [entry.propertyId, entry.fn] as const),
  );
  // HTML5 drag state for property reorder: the dragged column id and the
  // column currently under the pointer (highlighted as the drop target).
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
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
                  if (from && from !== property.id) onReorderProperty(from, property.id);
                }}
                className={cn(
                  "border-b border-border px-3 py-2 font-medium transition-colors",
                  frozen && index === 0 && "sticky left-0 z-10 bg-surface",
                  editable && "cursor-grab active:cursor-grabbing",
                  overId === property.id &&
                    draggingId !== null &&
                    draggingId !== property.id &&
                    "bg-surface-2",
                )}
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
            <th className="w-16 border-b border-border" />
          </tr>
        </thead>
        <tbody>
          {orderedRows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + 1}
                className="px-3 py-8 text-center text-sm text-muted"
              >
                {t(locale, "dbNoRowsClick")}
              </td>
            </tr>
          )}
          {orderedRows.map((row, rowIndex) => {
            const rowStripe = (() => {
              const color = colorOf(row);
              return color
                ? `3px solid ${OPTION_COLORS[color] ?? color}`
                : undefined;
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
              rowColors.backgroundColor = `${OPTION_COLORS[resolved.backgroundColor] ?? "#8a8a85"}22`;
            }
            if (resolved.textColor) {
              rowColors.color = OPTION_COLORS[resolved.textColor];
            }
            return (
            <tr
              key={row.id}
              style={rowColors}
              className="group border-b border-border last:border-0 hover:bg-surface-2/50"
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
                      "px-3 py-1.5 align-top",
                      frozen &&
                        index === 0 &&
                        "sticky left-0 z-10 bg-bg group-hover:bg-surface-2/50",
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
                            reorderRows(
                              orderedRows.map((entry) => entry.id),
                              rowIndex,
                              rowIndex - 1,
                            ),
                            onReorderRows,
                          )
                        }
                        className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
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
                        className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
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
                    onClick={() => onOpenPeek(row)}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </button>
                  {editable && (
                    <button
                      type="button"
                      title={t(locale, "saveAsTemplate")}
                      onClick={() => onSaveTemplate(row)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg"
                    >
                      <LayoutTemplate className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {editable && (
                    <button
                      type="button"
                      title={t(locale, "deleteRow")}
                      onClick={() => removeRow(row.id)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
        {footerFnByProperty.size > 0 && (
          <tfoot>
            <tr className="text-xs">
              {columns.map((property, index) => {
                const fn = footerFnByProperty.get(property.id);
                // The aggregate reads this column's cells from the visible row
                // set; NUMBER formats/currency flow through the same options the
                // board summary and chart use.
                const result = fn
                  ? aggregate(
                      orderedRows.map((row) => valueFor(row, property.id)),
                      fn,
                      aggregateOptionsFor(property),
                    )
                  : null;
                return (
                  <td
                    key={property.id}
                    data-testid={`table-footer-${property.name}`}
                    className={cn(
                      "sticky bottom-0 border-t border-border bg-surface px-3 py-1.5 text-muted",
                      frozen && index === 0 && "left-0 z-10",
                    )}
                  >
                    {fn && (
                      <span className="flex flex-wrap items-center gap-x-1">
                        <span className="font-medium">
                          {AGGREGATION_FUNCTIONS.find((entry) => entry.id === fn)?.label ?? fn}
                        </span>
                        <span>{result?.display ?? "—"}</span>
                      </span>
                    )}
                  </td>
                );
              })}
              <th className="sticky bottom-0 border-t border-border bg-surface" />
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
}) {
  const status = properties.find(
    (p) => p.type === "STATUS" || p.type === "SELECT",
  );
  const [localDensity, setLocalDensity] = useState<ListDensity>("compact");
  const density = densityProp ?? localDensity;
  const orderedRows = orderRows(rows, rowOrder);
  const setDensity = (next: ListDensity) => {
    if (onDensityChange) onDensityChange(next);
    else setLocalDensity(next);
  };
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
              "rounded px-2 py-0.5 text-xs",
              density === option.value
                ? "bg-surface-2 text-fg"
                : "text-muted hover:bg-surface-2",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {orderedRows.map((row, rowIndex) => {
          const model = listRowModel(row, properties, { density });
          const value = status ? (valueFor(row, status.id) as { optionId?: string }) : undefined;
          const option = status?.config?.options?.find((o) => o.id === value?.optionId);
          return (
            <li key={row.id} className="flex items-center">
              <Link
                href={`/w/${workspaceSlug}/${row.id}`}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-3 hover:bg-surface-2",
                  model.expanded ? "px-4 py-3" : "px-4 py-2",
                )}
              >
                <span className="w-4 text-center">{row.icon ?? "📄"}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {model.primary || t(locale, "untitled")}
                  </span>
                  {model.expanded && model.secondary && (
                    <span className="block truncate text-xs text-muted">
                      {model.secondary}
                    </span>
                  )}
                </span>
                {option && (
                  <span
                    className="rounded px-1.5 py-0.5 text-xs"
                    style={{
                      backgroundColor: `${OPTION_COLORS[option.color] ?? "#8a8a85"}22`,
                      color: OPTION_COLORS[option.color] ?? "#8a8a85",
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
                    className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
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
                    className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-bg disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </li>
          );
        })}
        {orderedRows.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-muted">{t(locale, "dbNoRows")}</li>
        )}
      </ul>
    </div>
  );
}

/** WIP badge colours keyed by `checkWip`'s grade. */
const WIP_STYLES: Record<WipStatus, string> = {
  ok: "bg-surface-2 text-muted",
  at: "bg-amber-500/15 text-amber-600",
  over: "bg-red-500/15 text-red-600",
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
}) {
  const groupProperty = properties.find((p) => p.id === groupBy);
  const statusProperty = properties.find(
    (p) => p.type === "STATUS" || p.type === "SELECT",
  );
  const property = groupProperty ?? statusProperty;

  if (!property) {
    return (
      <p className="text-sm text-muted">
        {t(locale, "boardNeedsGroup")}
      </p>
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
  type BoardColumn = { key: string; label: string; color: string; rows: DBRow[] };
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

  const renderCard = (row: DBRow) => (
    <Link
      key={row.id}
      href={`/w/${workspaceSlug}/${row.id}`}
      className="block rounded-lg border border-border bg-bg p-3 hover:bg-surface-2"
      style={{
        borderLeft: (() => {
          const color = colorOf(row);
          return color
            ? `3px solid ${OPTION_COLORS[color] ?? color}`
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

  const renderColumn = (column: BoardColumn, groupRows: DBRow[]) => {
    const wip = wipFor(column.key);
    // Aggregation runs over this column's own rows, so a swimlane's slice
    // reports its lane totals rather than the whole column's.
    const summary = summaryProperty
      ? summarizeGroup(groupRows, summaryProperty, valueFor)
      : [];
    return (
      <div key={column.key} className="w-64 shrink-0">
        <div className="mb-2 flex items-center gap-2 text-sm">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{
              backgroundColor: OPTION_COLORS[column.color] ?? "#8a8a85",
            }}
          />
          <span className="font-medium" data-testid={`board-column-${column.key}`}>
            {column.label}
          </span>
          <span className="text-muted">{groupRows.length}</span>
          {wip && wip.limit !== undefined && (
            <span
              data-testid={`board-wip-${column.key}`}
              data-wip-status={wip.status}
              title={`${wip.count}/${wip.limit}`}
              className={cn(
                "rounded px-1 py-0.5 text-[10px] font-medium",
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
            className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted"
          >
            <span className="font-medium">{summaryProperty.name}</span>
            {summary.map((entry) => (
              <span key={entry.fn}>
                {entry.label} {entry.display}
              </span>
            ))}
          </p>
        )}
        <div className="space-y-2">{groupRows.map((row) => renderCard(row))}</div>
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
   * setting). Feeds `resolveCardPreview` (as the cover property) and
   * `cardFieldOrder` (as the field to skip). Unset or blank falls back to the
   * first cover-eligible (FILES) property, so an unconfigured gallery renders
   * exactly as it did before.
   */
  previewPropertyId?: string | null;
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
  const fields = cardFieldOrder(
    // The primary/name property is the card title, so it is never listed twice.
    presetProperties.filter((property) => property.id !== primary?.id),
    {
      previewPropertyId: coverPropertyId,
      maxFields: spec.showPreview ? 3 : 4,
    },
  )
    .map((id) => properties.find((property) => property.id === id))
    .filter((property): property is DBProperty => property !== undefined);

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
        {t(locale, "noCardsYet")}
      </p>
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
        const preview = resolveCardPreview(row, presetProperties, { coverPropertyId });
        return (
          <Link
            key={row.id}
            href={`/w/${workspaceSlug}/${row.id}`}
            className="overflow-hidden rounded-lg border border-border bg-bg transition hover:bg-surface-2"
          >
            {spec.showPreview && (
              <div
                className="grid place-items-center overflow-hidden bg-surface text-3xl"
                style={{ aspectRatio: spec.aspect }}
                data-testid="gallery-banner"
              >
                {preview.kind === "cover" ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- raw attachment URLs are not statically analysable for next/image */
                  <img src={preview.value} alt={row.title} className="h-full w-full object-cover" />
                ) : (
                  preview.value ?? row.icon ?? "📄"
                )}
              </div>
            )}
            <div className="p-3">
              <p className="truncate text-sm font-medium">
                {!spec.showPreview && <span className="mr-1">{row.icon ?? "📄"}</span>}
                {row.title || t(locale, "untitled")}
              </p>
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
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Calendar view
   --------------------------------------------------------------------------- */

export function CalendarView({
  locale,
  workspaceSlug,
  properties,
  rows,
  valueFor,
}: {
  locale: string;
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  valueFor: (row: DBRow, propertyId: string) => unknown;
}) {
  const dateProperty = properties.find((p) => p.type === "DATE");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  if (!dateProperty) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
        {t(locale, "calendarNeedsDate")}
      </p>
    );
  }

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(year, monthIndex, day));
  }

  const today = new Date();
  const eventsFor = (day: Date) =>
    rows.filter((row) => {
      const value = valueFor(row, dateProperty.id) as { start?: string } | undefined;
      if (!value?.start) return false;
      const date = new Date(value.start);
      return (
        date.getFullYear() === day.getFullYear() &&
        date.getMonth() === day.getMonth() &&
        date.getDate() === day.getDate()
      );
    });

  const shift = (delta: number) => setMonth(new Date(year, monthIndex + delta, 1));

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted" />
          <button type="button" onClick={() => shift(-1)} aria-label={t(locale, "previousMonth")} className="rounded px-2 py-0.5 text-muted hover:bg-surface-2">
            ‹
          </button>
          <span className="text-sm font-medium">
            {month.toLocaleString(undefined, { month: "long", year: "numeric" })}
          </span>
          <button type="button" onClick={() => shift(1)} aria-label={t(locale, "nextMonth")} className="rounded px-2 py-0.5 text-muted hover:bg-surface-2">
            ›
          </button>
        </div>
        <button
          type="button"
          onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}
          className="text-xs text-muted hover:text-fg"
        >
          {t(locale, "todayWord")}
        </button>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {(["wdSun", "wdMon", "wdTue", "wdWed", "wdThu", "wdFri", "wdSat"] as const).map(
          (weekday) => (
            <div key={weekday} className="bg-surface px-2 py-1 font-medium text-muted">
              {t(locale, weekday)}
            </div>
          ),
        )}
        {cells.map((day, index) => (
          <div key={index} className="min-h-24 bg-bg p-1.5">
            {day && (
              <>
                <div
                  className={cn(
                    "mb-1 text-xs text-muted",
                    day.toDateString() === today.toDateString() && "font-bold text-accent",
                  )}
                >
                  {day.getDate()}
                </div>
                <div className="space-y-1">
                  {eventsFor(day).map((row) => (
                    <Link
                      key={row.id}
                      href={`/w/${workspaceSlug}/${row.id}`}
                      className="block truncate rounded bg-surface-2 px-1.5 py-0.5 text-xs hover:bg-surface"
                    >
                      {row.title || t(locale, "untitled")}
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Form view
   --------------------------------------------------------------------------- */

/**
 * Render a database as a respondent form.
 *
 * `buildFormSchema` resolves the ordered questions from the database's
 * properties plus the stored form config (`config.form`), so computed/system
 * types (formula, relation, rollup, audit, id, button…) are skipped and stale
 * ids are tolerated. Each question is edited with the existing `Cell` editor
 * for its property type, so the form can only offer answers the rest of the app
 * accepts. On submit, `validateSubmission` gates the answers with the same
 * rules a cell write uses and `answersToPropertyValues` maps an accepted
 * submission to the `{ propertyId, value }` cells a new row stores.
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
}) {
  const fields = buildFormSchema(properties, config);
  const meta = resolveFormMeta(config);
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const editable = onSubmit !== undefined;

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
    const validation = validateSubmission(fields, answers);
    if (!validation.ok) {
      setIssues(validation.issues);
      return;
    }
    setIssues([]);
    // Hand the mapped cells to the parent before clearing, so the success
    // state can offer "Add another" without resubmitting the same answers.
    onSubmit(answersToPropertyValues(fields, answers));
    setAnswers({});
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
        <p className="text-sm font-medium">{t(locale, "done")}</p>
        <button
          type="button"
          data-testid="form-add-another"
          onClick={() => setSubmitted(false)}
          className="rounded bg-accent px-4 py-1.5 text-sm text-accent-fg hover:opacity-90"
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
                <span className="text-red-500" aria-hidden="true">
                  *
                </span>
              )}
            </div>
            <div className="rounded border border-border bg-bg px-2 py-1.5">
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
                className="space-y-0.5 text-xs text-red-500"
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
          className="rounded bg-accent px-4 py-1.5 text-sm text-accent-fg hover:opacity-90"
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

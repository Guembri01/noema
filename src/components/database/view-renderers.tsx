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
  type ViewConfig,
} from "@/lib/database-query";
import { groupRowsByProperty, visibleGroups as filterVisibleGroups } from "@/lib/board-groups";
import { reorderRows, sortByOrder } from "@/lib/row-order";
import { evaluateRowColors, type RowColorRule } from "@/lib/row-color-rules";
import {
  CARD_SIZES,
  cardFieldOrder,
  cardSizeFor,
  densityOptions,
  listRowModel,
  resolveCardPreview,
  type CardSizeName,
  type ListDensity,
} from "@/lib/view-presets";
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
}) {
  const columns = visibleColumns(
    properties as unknown as QueryProperty[],
    config,
  ) as unknown as DBProperty[];
  const frozen = config.freezeFirstColumn !== false;
  const orderedRows = orderRows(rows, rowOrder);
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
                          onReorderRows(
                            reorderRows(
                              orderedRows.map((entry) => entry.id),
                              rowIndex,
                              rowIndex - 1,
                            ),
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
                          onReorderRows(
                            reorderRows(
                              orderedRows.map((entry) => entry.id),
                              rowIndex,
                              rowIndex + 1,
                            ),
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
                      onReorderRows(
                        reorderRows(
                          orderedRows.map((entry) => entry.id),
                          rowIndex,
                          rowIndex - 1,
                        ),
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
                      onReorderRows(
                        reorderRows(
                          orderedRows.map((entry) => entry.id),
                          rowIndex,
                          rowIndex + 1,
                        ),
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
  /** Per-column visibility: a column key mapped to `false` is hidden. */
  visibleGroups?: Record<string, boolean>;
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
  const counts = new Map(columns.map((column) => [column.key, column.rows.length]));

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {columns.map((column) => {
        const groupRows = column.rows;
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
              <span className="text-muted">{counts.get(column.key)}</span>
            </div>
            <div className="space-y-2">
              {groupRows.map((row) => (
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
              ))}
            </div>
          </div>
        );
      })}
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
  const coverPropertyId = properties.find((property) => property.type === "FILES")?.id ?? null;
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
   View settings (filter / sort / group)
   --------------------------------------------------------------------------- */

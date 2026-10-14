"use client";

import { Cell, PropertyHeader } from "./view-parts";
import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, ExternalLink, LayoutTemplate, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  formatCell,
  hasStatusGroups,
  statusGroupColumns,
  visibleColumns,
  type QueryProperty,
  type ViewConfig,
} from "@/lib/database-query";
import { OPTION_COLORS, type DBProperty, type DBRow, type HeaderConfig } from "@/components/database/database-types";

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
}) {
  const columns = visibleColumns(
    properties as unknown as QueryProperty[],
    config,
  ) as unknown as DBProperty[];
  const frozen = config.freezeFirstColumn !== false;
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
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + 1}
                className="px-3 py-8 text-center text-sm text-muted"
              >
                {t(locale, "dbNoRowsClick")}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const rowStripe = (() => {
              const color = colorOf(row);
              return color
                ? `3px solid ${OPTION_COLORS[color] ?? color}`
                : undefined;
            })();
            return (
            <tr
              key={row.id}
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
}: {
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  valueFor: (row: DBRow, propertyId: string) => unknown;
  editable: boolean;
  locale: string;
}) {
  const status = properties.find(
    (p) => p.type === "STATUS" || p.type === "SELECT",
  );
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {rows.map((row) => {
        const value = status ? (valueFor(row, status.id) as { optionId?: string }) : undefined;
        const option = status?.config?.options?.find((o) => o.id === value?.optionId);
        return (
          <li key={row.id}>
            <Link
              href={`/w/${workspaceSlug}/${row.id}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2"
            >
              <span className="w-4 text-center">{row.icon ?? "📄"}</span>
              <span className="flex-1 truncate text-sm">
                {row.title || t(locale, "untitled")}
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
          </li>
        );
      })}
      {rows.length === 0 && (
        <li className="px-4 py-8 text-center text-sm text-muted">{t(locale, "dbNoRows")}</li>
      )}
    </ul>
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
  // Done) drives one column per bucket; every other grouping keeps the
  // per-option columns it always had.
  const localizedGroups: Record<string, string> = {
    todo: t(locale, "statusGroupTodo"),
    doing: t(locale, "statusGroupDoing"),
    done: t(locale, "statusGroupDone"),
  };
  const columns = hasStatusGroups(property)
    ? statusGroupColumns(rows, properties, property.id, t(locale, "noValue")).map(
        (column) =>
          localizedGroups[column.id]
            ? { ...column, name: localizedGroups[column.id] }
            : column,
      )
    : [
        ...(property.config?.options ?? []).map((option) => ({
          ...option,
          rows: rows.filter(
            (row) =>
              ((valueFor(row, property.id) as { optionId?: string } | undefined)
                ?.optionId ?? "") === option.id,
          ),
        })),
        {
          id: "__none",
          name: t(locale, "noValue"),
          color: "gray",
          rows: rows.filter(
            (row) =>
              !(
                (valueFor(row, property.id) as { optionId?: string } | undefined)
                  ?.optionId
              ),
          ),
        },
      ];

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {columns.map((option) => {
        const groupRows = option.rows;
        return (
          <div key={option.id} className="w-64 shrink-0">
            <div className="mb-2 flex items-center gap-2 text-sm">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{
                  backgroundColor: OPTION_COLORS[option.color] ?? "#8a8a85",
                }}
              />
              <span className="font-medium" data-testid={`board-column-${option.id}`}>
                {option.name}
              </span>
              <span className="text-muted">{groupRows.length}</span>
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
}: {
  locale: string;
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  primary: DBProperty | null;
  valueFor: (row: DBRow, propertyId: string) => unknown;
  computedFor?: (row: DBRow, property: DBProperty) => string | undefined;
}) {
  const preview = properties
    .filter((p) => p.id !== primary?.id && !p.config?.primary)
    .slice(0, 3);
  const fileProperties = properties.filter((p) => p.type === "FILES");

  /** First attached image across the row's FILES properties (card banner). */
  const bannerFor = (row: DBRow): { url: string; name: string } | null => {
    for (const property of fileProperties) {
      const value = valueFor(row, property.id) as
        | { files?: { name?: string; url?: string }[] }
        | undefined;
      for (const file of value?.files ?? []) {
        const url = file?.url ?? "";
        const image =
          url.startsWith("data:image/") || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(url);
        if (url && image) return { url, name: file?.name ?? "" };
      }
    }
    return null;
  };

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
        {t(locale, "noCardsYet")}
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => {
        const banner = bannerFor(row);
        return (
          <Link
            key={row.id}
            href={`/w/${workspaceSlug}/${row.id}`}
            className="overflow-hidden rounded-lg border border-border bg-bg transition hover:bg-surface-2"
          >
            <div
              className="grid h-24 place-items-center overflow-hidden bg-surface text-3xl"
              data-testid="gallery-banner"
            >
              {banner ? (
                /* eslint-disable-next-line @next/next/no-img-element -- raw attachment URLs are not statically analysable for next/image */
                <img src={banner.url} alt={banner.name} className="h-full w-full object-cover" />
              ) : (
                row.icon ?? "📄"
              )}
            </div>
            <div className="p-3">
              <p className="truncate text-sm font-medium">{row.title || t(locale, "untitled")}</p>
              <dl className="mt-2 space-y-1">
                {preview.map((property) => (
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

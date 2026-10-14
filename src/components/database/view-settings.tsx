"use client";

import {
  ArrowUpDown,
  Columns3,
  Filter as FilterIcon,
  Layers,
  Palette,
  Plus,
  X } from "lucide-react";
import {
  COLOR_CHOICES,
  CONTROL_CLASS,
  type DBProperty,
} from "@/components/database/database-types";
import {
  addFilter,
  addSort,
  moveSort,
  operatorsFor,
  removeSort,
  type ColorRule,
  type Filter,
  type Sort,
  type ViewConfig,
} from "@/lib/database-query";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Filter / sort / group / colour-rule / column-visibility controls for one
 * database view. Everything here writes into `config`, which the caller
 * persists per view — so each tab keeps its own settings across reloads.
 */

export function ViewSettings({
  locale,
  properties,
  config,
  editable,
  onChange,
}: {
  properties: DBProperty[];
  config: ViewConfig;
  editable: boolean;
  onChange: (patch: Partial<ViewConfig>) => void;
  locale: string;
}) {
  if (!editable) return null;

  const filters = config.filters ?? [];
  const sorts = config.sorts ?? [];
  const groupBy = config.groupByPropertyId ?? "";
  const groupable = properties.filter((p) =>
    ["SELECT", "STATUS", "MULTI_SELECT"].includes(p.type),
  );
  const defaultProperty =
    properties.find((p) => !p.config?.primary) ?? properties[0];

  const secondary = properties.filter((p) => !p.config?.primary);
  const visibleIds =
    config.visiblePropertyIds === undefined
      ? null
      : new Set(config.visiblePropertyIds);
  const hiddenCount =
    visibleIds === null ? 0 : secondary.filter((p) => !visibleIds.has(p.id)).length;

  /** Toggle one column in this view's visibility list (primary is pinned). */
  const toggleProperty = (propertyId: string) => {
    const current = visibleIds
      ? [...visibleIds]
      : secondary.map((property) => property.id);
    const next = current.includes(propertyId)
      ? current.filter((id) => id !== propertyId)
      : [...current, propertyId];
    onChange({ visiblePropertyIds: next });
  };

  /**
   * First non-primary property that is not already covered by a default new
   * filter row — so "Add filter" always adds a row instead of no-op'ing.
   */
  const addableFilterProperty =
    properties
      .filter((property) => !property.config?.primary)
      .find(
        (property) =>
          !filters.some(
            (filter) =>
              filter.propertyId === property.id && filter.operator === "contains",
          ),
      ) ??
    properties.find(
      (property) =>
        !filters.some(
          (filter) =>
            filter.propertyId === property.id && filter.operator === "contains",
        ),
    );

  /** First non-primary property that is not already a sort key. */
  const addableSortProperty =
    properties
      .filter((property) => !property.config?.primary)
      .find((property) => !sorts.some((sort) => sort.propertyId === property.id)) ??
    properties.find((property) => !sorts.some((sort) => sort.propertyId === property.id));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
      {/* Filter */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="filter-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              filters.length > 0 && "bg-surface-2 text-fg",
            )}
          >
            <FilterIcon className="h-3.5 w-3.5" />
            {t(locale, "dbFilter")}{filters.length > 0 ? ` (${filters.length})` : ""}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80" data-testid="db-filter-popover">
          <div className="space-y-2">
            {filters.length === 0 && (
              <p className="text-xs text-muted">No filters — all rows are shown.</p>
            )}
            {filters.map((filter, index) => {
              const property = properties.find((p) => p.id === filter.propertyId);
              const noValue = ["is_empty", "is_not_empty", "checked", "unchecked"].includes(
                filter.operator,
              );
              return (
                <div key={index} className="space-y-1 rounded border border-border p-2">
                  <div className="flex items-center gap-1">
                    <select
                      value={filter.propertyId}
                      data-testid="filter-property"
                      onChange={(e) => onChange({
                        filters: filters.map((f, i) =>
                          i === index ? { ...f, propertyId: e.target.value } : f,
                        ),
                      })}
                      className={cn(CONTROL_CLASS, "flex-1")}
                    >
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label="Remove filter"
                      onClick={() => onChange({ filters: filters.filter((_, i) => i !== index) })}
                      className="text-muted hover:text-red-500"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <select
                    value={filter.operator}
                    data-testid="filter-operator"
                    onChange={(e) => onChange({
                      filters: filters.map((f, i) =>
                        i === index ? { ...f, operator: e.target.value as Filter["operator"] } : f,
                      ),
                    })}
                    className={cn(CONTROL_CLASS, "w-full")}
                  >
                    {operatorsFor(property?.type ?? "TEXT").map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>
                  {!noValue && (
                    <input
                      value={filter.value ?? ""}
                      data-testid="filter-value"
                      onChange={(e) => onChange({
                        filters: filters.map((f, i) =>
                          i === index ? { ...f, value: e.target.value } : f,
                        ),
                      })}
                      placeholder="Value"
                      className={cn(CONTROL_CLASS, "w-full")}
                    />
                  )}
                </div>
              );
            })}
            <button
              type="button"
              data-testid="add-filter"
              disabled={!addableFilterProperty}
              onClick={() =>
                onChange({
                  filters: addFilter(filters, {
                    propertyId: addableFilterProperty?.id ?? "",
                    operator: "contains",
                    value: "",
                  }),
                })
              }
              className="flex items-center gap-1 text-xs text-accent disabled:opacity-50"
            >
              <Plus className="h-3 w-3" /> Add filter
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {filters.length > 1 && (
        <label className="flex items-center gap-1 text-xs text-muted">
          Match
          <select
            value={config.filterMode ?? "and"}
            onChange={(e) =>
              onChange({ filterMode: e.target.value as "and" | "or" })
            }
            className={cn(CONTROL_CLASS, "h-7")}
          >
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
        </label>
      )}

      {/* Color */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              (config.colorRules?.length ?? 0) > 0 && "bg-surface-2 text-fg",
            )}
          >
            <Palette className="h-3.5 w-3.5" />
            Color
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="space-y-2">
            {(config.colorRules?.length ?? 0) === 0 && (
              <p className="text-xs text-muted">No color rules — cards stay plain.</p>
            )}
            {(config.colorRules ?? []).map((rule, index) => (
              <div key={index} className="space-y-1 rounded border border-border p-2">
                <div className="flex items-center gap-1">
                  <select
                    value={rule.propertyId}
                    onChange={(e) =>
                      onChange({
                        colorRules: (config.colorRules ?? []).map((r, i) =>
                          i === index ? { ...r, propertyId: e.target.value } : r,
                        ),
                      })
                    }
                    className={cn(CONTROL_CLASS, "flex-1")}
                  >
                    {properties.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <select
                    value={rule.color}
                    onChange={(e) =>
                      onChange({
                        colorRules: (config.colorRules ?? []).map((r, i) =>
                          i === index ? { ...r, color: e.target.value } : r,
                        ),
                      })
                    }
                    className={cn(CONTROL_CLASS, "w-24")}
                  >
                    {COLOR_CHOICES.map((color) => (
                      <option key={color} value={color}>{color}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label="Remove rule"
                    onClick={() =>
                      onChange({
                        colorRules: (config.colorRules ?? []).filter((_, i) => i !== index),
                      })
                    }
                    className="text-muted hover:text-red-500"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <select
                    value={rule.operator}
                    onChange={(e) =>
                      onChange({
                        colorRules: (config.colorRules ?? []).map((r, i) =>
                          i === index
                            ? { ...r, operator: e.target.value as Filter["operator"] }
                            : r,
                        ),
                      })
                    }
                    className={cn(CONTROL_CLASS, "flex-1")}
                  >
                    {operatorsFor(
                      properties.find((p) => p.id === rule.propertyId)?.type ?? "TEXT",
                    ).map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>
                  <input
                    value={rule.value ?? ""}
                    onChange={(e) =>
                      onChange({
                        colorRules: (config.colorRules ?? []).map((r, i) =>
                          i === index ? { ...r, value: e.target.value } : r,
                        ),
                      })
                    }
                    placeholder="Value"
                    className={cn(CONTROL_CLASS, "flex-1")}
                  />
                </div>
              </div>
            ))}
            <button
              type="button"
              disabled={!defaultProperty}
              onClick={() =>
                onChange({
                  colorRules: [
                    ...(config.colorRules ?? []),
                    {
                      propertyId: defaultProperty?.id ?? "",
                      operator: "is",
                      value: "",
                      color: "blue",
                    } as ColorRule,
                  ],
                })
              }
              className="flex items-center gap-1 text-xs text-accent disabled:opacity-50"
            >
              <Plus className="h-3 w-3" /> Add rule
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Sort */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="sort-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              sorts.length > 0 && "bg-surface-2 text-fg",
            )}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            Sort{sorts.length > 0 ? ` (${sorts.length})` : ""}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72" data-testid="db-sort-popover">
          <div className="space-y-2">
            {sorts.length === 0 && <p className="text-xs text-muted">No sorts applied.</p>}
            {sorts.map((sort, index) => {
              const sortName =
                properties.find((p) => p.id === sort.propertyId)?.name ?? "";
              return (
              <div key={`${sort.propertyId}-${index}`} className="space-y-1 rounded border border-border p-2">
                <div className="flex items-center gap-1">
                  <span className="w-6 shrink-0 text-[10px] text-muted" title={t(locale, "dbSort")}>
                    {index + 1}.
                  </span>
                  <select
                    value={sort.propertyId}
                    data-testid="sort-property"
                    aria-label={`${t(locale, "dbSort")} ${index + 1}: ${sortName}`}
                    onChange={(e) => onChange({
                      sorts: sorts.map((s, i) =>
                        i === index ? { ...s, propertyId: e.target.value } : s,
                      ),
                    })}
                    className={cn(CONTROL_CLASS, "flex-1")}
                  >
                    {properties.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={`${t(locale, "dbMoveUp")}: ${sortName}`}
                    disabled={index === 0}
                    onClick={() => onChange({ sorts: moveSort(sorts, index, index - 1) })}
                    className="flex h-6 w-5 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
                  >
                    <span aria-hidden>↑</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`${t(locale, "dbMoveDown")}: ${sortName}`}
                    disabled={index === sorts.length - 1}
                    onClick={() => onChange({ sorts: moveSort(sorts, index, index + 1) })}
                    className="flex h-6 w-5 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
                  >
                    <span aria-hidden>↓</span>
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <select
                    value={sort.direction}
                    data-testid="sort-direction"
                    aria-label={`${t(locale, "dbSort")} ${index + 1} ${t(locale, "dbSortDir")}`}
                    onChange={(e) => onChange({
                      sorts: sorts.map((s, i) =>
                        i === index ? { ...s, direction: e.target.value as Sort["direction"] } : s,
                      ),
                    })}
                    className={cn(CONTROL_CLASS, "flex-1")}
                  >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                  <button
                    type="button"
                    aria-label={`${t(locale, "remove")} ${t(locale, "dbSort")} ${index + 1}: ${sortName}`}
                    onClick={() => onChange({ sorts: removeSort(sorts, sort.propertyId) })}
                    className="text-muted hover:text-red-500"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              );
            })}
            <button
              type="button"
              data-testid="add-sort"
              disabled={!addableSortProperty}
              onClick={() =>
                onChange({
                  sorts: addSort(sorts, addableSortProperty?.id ?? "", "asc"),
                })
              }
              className="flex items-center gap-1 text-xs text-accent disabled:opacity-50"
            >
              <Plus className="h-3 w-3" /> Add sort
            </button>
            {sorts.length > 1 && (
              <p className="text-[11px] text-muted">
                Sorted by the first key, then the next ones break ties.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Group */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              groupBy && "bg-surface-2 text-fg",
            )}
          >
            <Layers className="h-3.5 w-3.5" />
            Group
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <label className="mb-1 block text-xs text-muted" htmlFor="group-by">
            Group by
          </label>
          <select
            id="group-by"
            value={groupBy}
            onChange={(e) => onChange({ groupByPropertyId: e.target.value || null })}
            className={cn(CONTROL_CLASS, "w-full")}
          >
            <option value="">None</option>
            {groupable.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted">
            Grouping stacks rows by a select/status property (used by Board).
          </p>
        </PopoverContent>
      </Popover>

      {/* Show / hide properties (per view) */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="properties-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              hiddenCount > 0 && "bg-surface-2 text-fg",
            )}
          >
            <Columns3 className="h-3.5 w-3.5" />
            {t(locale, "dbProperties")}
            {hiddenCount > 0 ? ` (${hiddenCount})` : ""}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64" data-testid="db-properties-popover">
          <p className="mb-2 text-xs text-muted">{t(locale, "dbPropertiesHint")}</p>
          <ul className="space-y-1">
            {properties.map((property) => {
              const isPrimary = Boolean(property.config?.primary);
              const shown = isPrimary || visibleIds === null || visibleIds.has(property.id);
              return (
                <li key={property.id}>
                  <label
                    className={cn(
                      "flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-2",
                      isPrimary && "opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={shown}
                      disabled={isPrimary}
                      aria-label={`${t(locale, "dbProperties")}: ${property.name}`}
                      onChange={() => toggleProperty(property.id)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="truncate">{property.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <label className="mt-3 flex items-center gap-2 border-t border-border pt-2 text-sm">
            <input
              type="checkbox"
              checked={config.freezeFirstColumn !== false}
              aria-label={t(locale, "dbFreezeFirst")}
              onChange={() =>
                onChange({ freezeFirstColumn: config.freezeFirstColumn === false })
              }
              className="accent-[var(--accent)]"
            />
            {t(locale, "dbFreezeFirst")}
          </label>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Timeline & Chart views
   --------------------------------------------------------------------------- */

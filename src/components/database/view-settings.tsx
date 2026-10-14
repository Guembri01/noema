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
  type FilterNode,
  type Sort,
  type ViewConfig,
} from "@/lib/database-query";
import {
  countActiveFilters,
  hasActiveFilters,
  isFilterGroup,
  removeFilterById,
  replaceFilter,
  type FilterGroup,
  type FilterTreeLeaf,
  type FilterTreeNode,
} from "@/lib/filter-tree";
import {
  mergeLayout,
  toggleColumnVisibility,
  visibleColumns,
  type ColumnLayout,
} from "@/lib/column-layout";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/* ---------------------------------------------------------------------------
   Nested filter groups (AND/OR to any depth)
   The nested counterpart to the flat filter rows: a `FilterGroup` tree from
   `@/lib/filter-tree`. It is persisted as the view's `filterTree` (the very
   shape `applyFilterTree` evaluates), so both engines agree. While a tree is
   present the flat `filters` are ignored, which the UI says out loud.
   --------------------------------------------------------------------------- */

let newLeafSeq = 0;
/** A fresh leaf with a stable-until-persisted id for `replaceFilter`/`removeFilterById`. */
function newLeaf(filter: Filter): FilterTreeLeaf {
  newLeafSeq += 1;
  const leaf: FilterTreeLeaf = {
    propertyId: filter.propertyId,
    operator: filter.operator,
    id: `filter-new-${newLeafSeq}`,
  };
  if (filter.value !== undefined) leaf.value = filter.value;
  return leaf;
}

/** `config.filterTree` (`FilterNode[]`) → one `FilterGroup` tree, or null when absent. */
function treeFromConfig(config: ViewConfig): FilterGroup | null {
  const nodes = config.filterTree;
  if (!nodes || nodes.length === 0) return null;
  return {
    conjunction: config.filterMode === "or" ? "OR" : "AND",
    children: nodes.map((node, index) => fromFilterNode(node, [index])),
  };
}

function fromFilterNode(node: FilterNode, path: number[]): FilterTreeNode {
  if ("and" in node) {
    return {
      conjunction: "AND",
      children: node.and.map((child, index) => fromFilterNode(child, [...path, index])),
    };
  }
  if ("or" in node) {
    return {
      conjunction: "OR",
      children: node.or.map((child, index) => fromFilterNode(child, [...path, index])),
    };
  }
  // Path-based ids keep the leaf addressable across re-renders.
  const leaf: FilterTreeLeaf = {
    propertyId: node.propertyId,
    operator: node.operator,
    id: `filter-${path.join("-")}`,
  };
  if (node.value !== undefined) leaf.value = node.value;
  return leaf;
}

/** A `FilterGroup` tree → the persisted `filterTree` node list (ids are dropped). */
function toFilterNodes(tree: FilterGroup): FilterNode[] {
  return tree.children.map(toFilterNode);
}

function toFilterNode(node: FilterTreeNode): FilterNode {
  if (isFilterGroup(node)) {
    const children = node.children.map(toFilterNode);
    return node.conjunction === "AND" ? { and: children } : { or: children };
  }
  const filter: Filter = { propertyId: node.propertyId, operator: node.operator };
  if (node.value !== undefined) filter.value = node.value;
  return filter;
}

/** Immutable edit of the node at `path` (index path from the root). */
function updateAtPath(
  tree: FilterTreeNode,
  path: number[],
  update: (node: FilterTreeNode) => FilterTreeNode,
): FilterTreeNode {
  if (path.length === 0) return update(tree);
  if (!isFilterGroup(tree)) return tree;
  const [head, ...rest] = path;
  const children = tree.children.map((child, index) =>
    index === head ? updateAtPath(child, rest, update) : child,
  );
  return { ...tree, children };
}

/**
 * Immutable removal of the node (leaf or group) at `path` — the sibling of
 * `removeFilterById` for groups, which that engine deliberately preserves. The
 * root itself is never removed (an empty tree is neutral, not absent).
 */
function removeNodeAtPath(root: FilterGroup, path: number[]): FilterGroup {
  if (path.length === 0) return root;
  const [head, ...rest] = path;
  const children: FilterTreeNode[] = [];
  root.children.forEach((child, index) => {
    if (index !== head) {
      children.push(child);
    } else if (rest.length > 0 && isFilterGroup(child)) {
      children.push(removeNodeAtPath(child, rest));
    }
    // index === head with an empty tail → drop this node.
  });
  return { ...root, children };
}

/** One condition (leaf) row inside a group. */
function FilterLeafRow({
  leaf,
  properties,
  onSetField,
  onRemove,
}: {
  leaf: FilterTreeLeaf;
  properties: DBProperty[];
  onSetField: (leaf: FilterTreeLeaf, patch: Partial<Filter>) => void;
  onRemove: (leaf: FilterTreeLeaf) => void;
}) {
  const property = properties.find((p) => p.id === leaf.propertyId);
  const noValue = ["is_empty", "is_not_empty", "checked", "unchecked"].includes(
    leaf.operator,
  );
  return (
    <div className="space-y-1 rounded border border-border p-2">
      <div className="flex items-center gap-1">
        <select
          value={leaf.propertyId}
          aria-label="Filter group property"
          onChange={(e) => onSetField(leaf, { propertyId: e.target.value })}
          className={cn(CONTROL_CLASS, "flex-1")}
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Remove condition"
          onClick={() => onRemove(leaf)}
          className="text-muted hover:text-red-500"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <select
        value={leaf.operator}
        aria-label="Filter group operator"
        onChange={(e) =>
          onSetField(leaf, { operator: e.target.value as Filter["operator"] })
        }
        className={cn(CONTROL_CLASS, "w-full")}
      >
        {operatorsFor(property?.type ?? "TEXT").map((op) => (
          <option key={op.value} value={op.value}>
            {op.label}
          </option>
        ))}
      </select>
      {!noValue && (
        <input
          value={leaf.value ?? ""}
          aria-label="Filter group value"
          onChange={(e) => onSetField(leaf, { value: e.target.value })}
          placeholder="Value"
          className={cn(CONTROL_CLASS, "w-full")}
        />
      )}
    </div>
  );
}

/** A group of conditions/subgroups combined with one AND/OR conjunction. */
function FilterGroupRows({
  node,
  path,
  depth,
  properties,
  onAddCondition,
  onAddGroup,
  onRemoveGroup,
  onSetConjunction,
  onSetLeafField,
  onRemoveLeaf,
}: {
  node: FilterGroup;
  path: number[];
  depth: number;
  properties: DBProperty[];
  onAddCondition: (path: number[]) => void;
  onAddGroup: (path: number[]) => void;
  onRemoveGroup: (path: number[]) => void;
  onSetConjunction: (path: number[], conjunction: "AND" | "OR") => void;
  onSetLeafField: (leaf: FilterTreeLeaf, patch: Partial<Filter>) => void;
  onRemoveLeaf: (leaf: FilterTreeLeaf) => void;
}) {
  return (
    <div
      className={cn(
        "space-y-2 rounded border border-border p-2",
        depth > 0 && "bg-surface-2/40",
      )}
    >
      <div className="flex items-center gap-1">
        <select
          value={node.conjunction === "OR" ? "or" : "and"}
          aria-label="Filter group match"
          onChange={(e) =>
            onSetConjunction(path, e.target.value === "or" ? "OR" : "AND")
          }
          className={cn(CONTROL_CLASS, "h-7")}
        >
          <option value="and">all</option>
          <option value="or">any</option>
        </select>
        <span className="text-xs text-muted">of these</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAddCondition(path)}
            className="flex items-center gap-1 text-xs text-accent"
          >
            <Plus className="h-3 w-3" /> Condition
          </button>
          <button
            type="button"
            onClick={() => onAddGroup(path)}
            className="flex items-center gap-1 text-xs text-accent"
          >
            <Plus className="h-3 w-3" /> Group
          </button>
          {depth > 0 && (
            <button
              type="button"
              aria-label="Remove group"
              onClick={() => onRemoveGroup(path)}
              className="text-muted hover:text-red-500"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {node.children.length === 0 && (
        <p className="text-xs text-muted">Empty group — matches every row.</p>
      )}
      {node.children.map((child, index) =>
        isFilterGroup(child) ? (
          <FilterGroupRows
            key={index}
            node={child}
            path={[...path, index]}
            depth={depth + 1}
            properties={properties}
            onAddCondition={onAddCondition}
            onAddGroup={onAddGroup}
            onRemoveGroup={onRemoveGroup}
            onSetConjunction={onSetConjunction}
            onSetLeafField={onSetLeafField}
            onRemoveLeaf={onRemoveLeaf}
          />
        ) : (
          <FilterLeafRow
            key={index}
            leaf={child}
            properties={properties}
            onSetField={onSetLeafField}
            onRemove={onRemoveLeaf}
          />
        ),
      )}
    </div>
  );
}

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
  layout,
  onLayoutChange,
}: {
  properties: DBProperty[];
  config: ViewConfig;
  editable: boolean;
  onChange: (patch: Partial<ViewConfig>) => void;
  locale: string;
  /**
   * Saved column layout (order/widths/hidden). Optional: when omitted it is
   * derived from this view's `visiblePropertyIds`, so existing configs and
   * callers that have not wired the layout keep behaving exactly as before.
   */
  layout?: ColumnLayout;
  /**
   * Persist a new column layout. Optional: without it, toggling writes the
   * legacy `visiblePropertyIds` list exactly as it always has.
   */
  onLayoutChange?: (layout: ColumnLayout) => void;
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

  // Nested filters: a non-empty `config.filterTree` takes over from the flat
  // `filters` — the same precedence `applyView` uses. The tree editor below
  // edits it through `@/lib/filter-tree`.
  const tree = treeFromConfig(config);
  const filterCount = tree ? countActiveFilters(tree) : filters.length;
  const filterActive = tree ? hasActiveFilters(tree) : filters.length > 0;

  // Column layout: merge the saved layout (or one derived from the legacy
  // `visiblePropertyIds`) with the live schema, then read visibility through
  // `visibleColumns` so this popover agrees with the table header.
  const columnIds = properties.map((property) => property.id);
  const baseLayout: ColumnLayout = layout ?? {
    order: [],
    widths: {},
    hidden:
      config.visiblePropertyIds === undefined
        ? {}
        : Object.fromEntries(
            secondary
              .filter(
                (property) => !config.visiblePropertyIds?.includes(property.id),
              )
              .map((property) => [property.id, true] as const),
          ),
  };
  const mergedLayout = mergeLayout(baseLayout, columnIds);
  const visibleSet = new Set(visibleColumns(baseLayout, columnIds));
  const hiddenCount = secondary.filter(
    (property) => !visibleSet.has(property.id),
  ).length;

  /** Toggle one column's visibility (primary is pinned). */
  const toggleProperty = (propertyId: string) => {
    if (onLayoutChange) {
      onLayoutChange(toggleColumnVisibility(mergedLayout, propertyId));
      return;
    }
    // Legacy path: write the flat `visiblePropertyIds` list.
    const current = secondary
      .map((property) => property.id)
      .filter((id) => visibleSet.has(id));
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

  // --- Nested filter-tree actions -----------------------------------------
  /** A brand-new condition seeded with an addable property. */
  const defaultFilter = (): Filter => ({
    propertyId: (addableFilterProperty ?? defaultProperty)?.id ?? "",
    operator: "contains",
    value: "",
  });

  /** Persist a tree, dropping the flat filters it replaces. */
  const commitTree = (next: FilterGroup) => {
    onChange({ filterTree: toFilterNodes(next), filters: [] });
  };

  /** Convert the current flat filters (or one blank condition) into a tree. */
  const startTree = () => {
    commitTree({
      conjunction: config.filterMode === "or" ? "OR" : "AND",
      children:
        filters.length > 0 ? filters.map(newLeaf) : [newLeaf(defaultFilter())],
    });
  };

  const addConditionAt = (path: number[]) => {
    if (!tree) return;
    commitTree(
      updateAtPath(tree, path, (node) =>
        isFilterGroup(node)
          ? { ...node, children: [...node.children, newLeaf(defaultFilter())] }
          : node,
      ) as FilterGroup,
    );
  };

  const addGroupAt = (path: number[]) => {
    if (!tree) return;
    commitTree(
      updateAtPath(tree, path, (node) =>
        isFilterGroup(node)
          ? {
              ...node,
              children: [
                ...node.children,
                { conjunction: "AND", children: [newLeaf(defaultFilter())] },
              ],
            }
          : node,
      ) as FilterGroup,
    );
  };

  const removeGroupAt = (path: number[]) => {
    if (!tree) return;
    commitTree(removeNodeAtPath(tree, path));
  };

  const setConjunctionAt = (path: number[], conjunction: "AND" | "OR") => {
    if (!tree) return;
    if (path.length === 0) {
      // The root's conjunction persists as `filterMode` (see `applyFilterTree`).
      onChange({ filterMode: conjunction === "OR" ? "or" : "and" });
      return;
    }
    commitTree(
      updateAtPath(tree, path, (node) =>
        isFilterGroup(node) ? { ...node, conjunction } : node,
      ) as FilterGroup,
    );
  };

  const setLeafField = (leaf: FilterTreeLeaf, patch: Partial<Filter>) => {
    if (!tree || !leaf.id) return;
    commitTree(
      replaceFilter(tree, leaf.id, { ...leaf, ...patch }) as FilterGroup,
    );
  };

  const removeLeaf = (leaf: FilterTreeLeaf) => {
    if (!tree || !leaf.id) return;
    const next = removeFilterById(tree, leaf.id);
    if (isFilterGroup(next)) commitTree(next);
  };

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
              filterActive && "bg-surface-2 text-fg",
            )}
          >
            <FilterIcon className="h-3.5 w-3.5" />
            {t(locale, "dbFilter")}{filterCount > 0 ? ` (${filterCount})` : ""}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80" data-testid="db-filter-popover">
          <div className="space-y-2">
            {tree ? (
              <>
                <FilterGroupRows
                  node={tree}
                  path={[]}
                  depth={0}
                  properties={properties}
                  onAddCondition={addConditionAt}
                  onAddGroup={addGroupAt}
                  onRemoveGroup={removeGroupAt}
                  onSetConjunction={setConjunctionAt}
                  onSetLeafField={setLeafField}
                  onRemoveLeaf={removeLeaf}
                />
                <button
                  type="button"
                  data-testid="filters-flatten"
                  onClick={() => onChange({ filterTree: [] })}
                  className="text-xs text-muted hover:text-fg"
                >
                  Use simple filters
                </button>
              </>
            ) : (
              <>
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
                <button
                  type="button"
                  data-testid="add-filter-group"
                  onClick={startTree}
                  className="flex items-center gap-1 text-xs text-accent"
                >
                  <Plus className="h-3 w-3" /> Add filter group
                </button>
              </>
            )}
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
                    value={rule.target ?? "row"}
                    aria-label="Color rule target"
                    data-testid="color-rule-target"
                    onChange={(e) =>
                      onChange({
                        colorRules: (config.colorRules ?? []).map((r, i) =>
                          i === index
                            ? { ...r, target: e.target.value as ColorRule["target"] }
                            : r,
                        ),
                      })
                    }
                    className={cn(CONTROL_CLASS, "w-20")}
                  >
                    <option value="row">{t(locale, "rowLabel")}</option>
                    <option value="cell">Cell</option>
                  </select>
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
                      target: "row",
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
              const shown = isPrimary || visibleSet.has(property.id);
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

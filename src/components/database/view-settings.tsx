"use client";

import { useEffect, useState } from "react";
import {
  ArrowUpDown,
  BarChart3,
  Bookmark,
  Columns3,
  Eye,
  Filter as FilterIcon,
  Gauge,
  Image as ImageIcon,
  Layers,
  Maximize2,
  Palette,
  Plus,
  RotateCcw,
  Sigma,
  Trash2,
  X } from "lucide-react";
import {
  COLOR_CHOICES,
  CONTROL_CLASS,
  type DBProperty,
  type DBRow,
} from "@/components/database/database-types";
import {
  addFilter,
  addSort,
  isFilterOperator,
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
  groupRowsByProperty,
  visibleGroups as filterVisibleGroups,
  type BoardPropertyDescriptor,
  type GroupVisibility,
} from "@/lib/board-groups";
import { checkWip, wipSummary, type WipLimits } from "@/lib/kanban-wip";
import { AGGREGATION_FUNCTIONS, type AggregationFn } from "@/lib/aggregations";
import type { ChartType } from "@/lib/charts";
import {
  normalizeViewConfig as normalizeSchemaViewConfig,
  validateViewConfig,
  type ViewColorRule,
  type ViewProperty as SchemaViewProperty,
} from "@/lib/view-config-schema";
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
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_MAX_WIDTH,
  DEFAULT_MIN_WIDTH,
  autoFitWidths,
  clampWidth,
  deserializeLayout,
  mergeLayout,
  serializeLayout,
  setColumnWidth,
  toggleColumnVisibility,
  visibleColumns,
  type ColumnLayout,
} from "@/lib/column-layout";
import {
  applySavedView,
  deserializeSavedViews,
  parseSavedView,
  type SavedView,
  type ViewConfigLike,
} from "@/lib/saved-views";
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

/* ---------------------------------------------------------------------------
   Saved views — named presets over the current view config
   `@/lib/saved-views` owns a storage-only preset shape that deliberately does
   not import the query layer. These three helpers bridge it to the app's
   `ViewConfig` without coupling either side:
     - `presetViewConfig`   ViewConfig → the loose `ViewConfigLike` base.
     - `presetFromConfig`   ViewConfig → a `SavedView` (id derived from name).
     - `configPatchForPreset` merged `ViewConfigLike` → a `Partial<ViewConfig>`.
   `visiblePropertyIds` round-trips as the *inverse* (`hidden`) so a preset can
   say which columns it hides without pinning the ones a later schema adds.
   --------------------------------------------------------------------------- */

/** Property ids a preset may hide — everything but the pinned primary. */
function presetSecondaryIds(properties: DBProperty[]): string[] {
  return properties
    .filter((property) => !property.config?.primary)
    .map((property) => property.id);
}

/** The current `ViewConfig` as the loose base a preset is applied over. */
function presetViewConfig(config: ViewConfig, secondary: string[]): ViewConfigLike {
  const like: ViewConfigLike = {};
  // Nested trees take precedence over the flat list, mirroring `applyView`.
  const filter = config.filterTree ?? config.filters;
  if (filter) like.filter = filter.map((node) => ({ ...node })) as ViewConfigLike["filter"];
  if (config.sorts) {
    like.sort = config.sorts.map((sort) => ({
      propertyId: sort.propertyId,
      direction: sort.direction,
    }));
  }
  if (config.groupByPropertyId) like.group = config.groupByPropertyId;
  if (config.visiblePropertyIds !== undefined) {
    const visible = config.visiblePropertyIds;
    like.hidden = secondary.filter((id) => !visible.includes(id));
  }
  return like;
}

/** A named preset capturing the current config (id derived from the name). */
function presetFromConfig(
  name: string,
  config: ViewConfig,
  secondary: string[],
): SavedView | null {
  const like = presetViewConfig(config, secondary);
  return parseSavedView({
    name,
    scope: "database",
    filter: like.filter,
    sort: like.sort,
    group: like.group,
    hidden: like.hidden,
  });
}

/** The `ViewConfig` patch that writes a merged preset back onto the view. */
function configPatchForPreset(
  merged: ViewConfigLike,
  secondary: string[],
): Partial<ViewConfig> {
  const patch: Partial<ViewConfig> = {};
  if (merged.filter !== undefined) {
    // Presets store a generic node list; adopt it as the nested tree and drop
    // the flat filters it replaces (the same trade `commitTree` makes).
    patch.filterTree = merged.filter as unknown as FilterNode[];
    patch.filters = [];
  }
  if (merged.sort !== undefined) {
    patch.sorts = merged.sort.map((sort) => ({
      propertyId: sort.propertyId,
      direction: sort.direction === "desc" ? "desc" : "asc",
    }));
  }
  if (merged.group !== undefined) patch.groupByPropertyId = merged.group;
  if (merged.hidden !== undefined) {
    const hidden = merged.hidden;
    patch.visiblePropertyIds = secondary.filter((id) => !hidden.includes(id));
  }
  return patch;
}

/* ---------------------------------------------------------------------------
   Config sanitisation + per-column WIP limits
   Two pure bridges for this toolbar:
     - `sanitizeViewSettings` reads the untrusted view config through
       `@/lib/view-config-schema`'s tolerant `normalizeViewConfig` against the
       live property schema, so a stale key or a reference to a since-deleted
       property is dropped before the UI reads — or rewrites — it. The schema
       speaks its own key names (`sort` / `group` / `rowColorRules`), so a small
       map converts both ways; fields it does not model (`filters`,
       `filterTree`, `filterMode`, `freezeFirstColumn`, `wipLimits`) ride
       through untouched. `validateViewConfig` is the strict safety net.
     - `normalizeWipLimits` keeps only finite, non-negative integer limits for
       the per-column WIP editor backed by `@/lib/kanban-wip`.
   --------------------------------------------------------------------------- */

/** The app view config plus the optional swimlane/WIP keys this toolbar persists. */
type ViewSettingsConfig = ViewConfig & {
  /**
   * BOARD: an optional second property id that slices the board into horizontal
   * swimlanes (the "Group by (lanes)" picker below). Like `wipLimits`, it is a
   * view-config key this toolbar owns and rides through `sanitizeViewSettings`
   * untouched; the swimlane engine validates the id at render time.
   */
  laneBy?: string;
  wipLimits?: WipLimits;
  /**
   * BOARD: per-column visibility keyed by column key (option id, or the empty
   * group key `__empty`). A key mapped to `false` is hidden and a missing key
   * stays visible — the exact semantics of `visibleGroups` in
   * `@/lib/board-groups`, which the board renderer filters with. Like
   * `wipLimits`, it is a view-config key this toolbar owns and rides through
   * `sanitizeViewSettings`; "hide every group" is a real persisted state.
   */
  visibleGroups?: GroupVisibility;
  /**
   * The serialized `ColumnLayout` (see `@/lib/column-layout`) this toolbar
   * persists when the caller does not wire `onLayoutChange` — the view config's
   * own column layout. Read back through `deserializeLayout`, so a malformed
   * value degrades to an empty layout instead of throwing.
   */
  columnLayout?: string;
  /**
   * CHART: the render shape `ChartView` draws. A view-config key this toolbar
   * owns and rides through `sanitizeViewSettings` untouched; the chart engine
   * defaults to a bar chart when it is unset, and the picker mirrors that
   * default so it shows what would render.
   */
  chartType?: string;
  /**
   * CHART: the aggregation applied per group, in the table-footer vocabulary
   * (`AggregationFn` in `@/lib/aggregations`). Owned here like `chartType`; the
   * chart engine defaults to a plain row count when it is unset.
   */
  chartAggregate?: string;
  /**
   * GALLERY: the property whose value each card shows as its preview image.
   * Passed to `resolveCardPreview` (as the cover property) and to
   * `cardFieldOrder` (as the field to skip); unset (or blank) means the gallery
   * picks the first cover-eligible property itself, as before.
   */
  previewPropertyId?: string | null;
  /**
   * BOARD: the property whose cells feed each board column's group summary
   * (Sum / Average / Count) — the "Summarize by property" picker below. Like
   * `laneBy`/`wipLimits`, it is a view-config key this toolbar owns and rides
   * through `sanitizeViewSettings` untouched; `BoardView` (feat/q03) reads it
   * and falls back to the first NUMBER column when it is unset or unknown.
   */
  aggregationPropertyId?: string | null;
};

/** A JSON object (not an array, not null), or `null` for anything else. */
function wipRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** An app colour rule → the schema's row-colour shape (its condition lives in `filter`). */
function colorRuleToSchema(rule: ColorRule): Record<string, unknown> {
  const condition: Record<string, unknown> = {
    propertyId: rule.propertyId,
    operator: rule.operator,
  };
  if (rule.value !== undefined) condition.value = rule.value;
  const schemaRule: Record<string, unknown> = {
    propertyId: rule.propertyId,
    color: rule.color,
    filter: condition,
  };
  if (rule.target) schemaRule.target = rule.target;
  return schemaRule;
}

/** The schema-shaped projection of an app config, the input to normalise/validate. */
function toSchemaConfig(config: ViewSettingsConfig): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (config.sorts) {
    raw.sort = config.sorts.map((sort) => ({
      propertyId: sort.propertyId,
      direction: sort.direction,
    }));
  }
  if (config.groupByPropertyId) raw.group = config.groupByPropertyId;
  if (config.visiblePropertyIds !== undefined) {
    raw.visiblePropertyIds = config.visiblePropertyIds;
  }
  if (config.colorRules) raw.rowColorRules = config.colorRules.map(colorRuleToSchema);
  return raw;
}

/**
 * A schema row-colour rule → an app colour rule. A rule whose property the
 * schema dropped (deleted property) or whose condition is unreadable is
 * skipped, so a dangling rule never reaches the editor.
 */
function colorRuleFromSchema(rule: ViewColorRule): ColorRule | null {
  if (!rule.propertyId) return null;
  const condition = rule.filter ?? {};
  const operator = condition.operator;
  if (!isFilterOperator(operator)) return null;
  const next: ColorRule = { propertyId: rule.propertyId, operator, color: rule.color };
  if (typeof condition.value === "string") next.value = condition.value;
  if (rule.target) next.target = rule.target;
  return next;
}

/** Keep only finite, non-negative integer limits; an empty map means "no limits". */
function normalizeWipLimits(input: unknown): WipLimits | undefined {
  const record = wipRecord(input);
  if (!record) return undefined;
  const limits: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "") continue;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      limits[key] = value;
    }
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/**
 * Keep only boolean group-visibility entries; an empty map normalises away, so
 * "all groups visible" is the absence of the key rather than `{}` — the same
 * rule the WIP limits use. Round-trips through `visibleGroups` in
 * `@/lib/board-groups`, where a missing key means visible.
 */
function normalizeVisibleGroups(input: unknown): GroupVisibility | undefined {
  const record = wipRecord(input);
  if (!record) return undefined;
  const visibility: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "") continue;
    if (typeof value === "boolean") visibility[key] = value;
  }
  return Object.keys(visibility).length > 0 ? visibility : undefined;
}

/**
 * Read an untrusted config into the shape this toolbar edits: schema-normalised
 * against `properties`, with WIP limits validated. Unknown top-level keys are
 * preserved; only the fields this toolbar owns are rewritten.
 */
function sanitizeViewSettings(
  config: ViewSettingsConfig,
  properties: SchemaViewProperty[],
): ViewSettingsConfig {
  const normalized = normalizeSchemaViewConfig(toSchemaConfig(config), properties);

  const sanitized: ViewSettingsConfig = { ...config };
  sanitized.sorts = normalized.sort ?? [];
  sanitized.groupByPropertyId = normalized.group ?? null;
  if (config.visiblePropertyIds === undefined) {
    delete sanitized.visiblePropertyIds;
  } else {
    sanitized.visiblePropertyIds = normalized.visiblePropertyIds ?? [];
  }
  sanitized.colorRules = (normalized.rowColorRules ?? [])
    .map(colorRuleFromSchema)
    .filter((rule): rule is ColorRule => rule !== null);

  const wipLimits = normalizeWipLimits(config.wipLimits);
  if (wipLimits) sanitized.wipLimits = wipLimits;
  else delete sanitized.wipLimits;

  const visibleGroups = normalizeVisibleGroups(config.visibleGroups);
  if (visibleGroups) sanitized.visibleGroups = visibleGroups;
  else delete sanitized.visibleGroups;

  return sanitized;
}

/**
 * Nominal table width the "Auto-fit" action shares across the visible columns.
 * The settings popover has no measured pixel width, so `autoFitWidths` spreads
 * this reference width evenly (clamped per column) to reset a table to a tidy,
 * uniform set of columns.
 */
const AUTO_FIT_WIDTH = 960;

/**
 * The chart shapes `ChartView` renders, in menu order. Local to the picker
 * because the chart engine exports the `ChartType` union but no menu.
 */
const CHART_TYPE_OPTIONS: { value: ChartType; label: string }[] = [
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "pie", label: "Pie" },
  { value: "donut", label: "Donut" },
];

/**
 * The database property types a gallery card can draw a preview from. These are
 * the upper-case counterparts of `COVER_PROPERTY_TYPES` in `@/lib/view-presets`
 * (`files`/`url`; there is no `media` type in the schema), so the picker only
 * offers properties `resolveCardPreview` would actually honour.
 */
const GALLERY_PREVIEW_TYPES: DBProperty["type"][] = ["FILES", "URL"];

/**
 * Filter / sort / group / colour-rule / column-visibility controls for one
 * database view. Everything here writes into `config`, which the caller
 * persists per view — so each tab keeps its own settings across reloads.
 */

export function ViewSettings({
  locale,
  properties,
  config: incoming,
  editable,
  onChange,
  layout,
  onLayoutChange,
  rows,
}: {
  properties: DBProperty[];
  /** The view's untrusted config; sanitised against `properties` below. */
  config: ViewSettingsConfig;
  editable: boolean;
  /** Persist a config patch (may carry the optional `wipLimits` key). */
  onChange: (patch: Partial<ViewSettingsConfig>) => void;
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
  /**
   * Rows the view is rendering, when known. Optional: it feeds the `checkWip`
   * status shown by the WIP-limit editor. Without it every column reports zero
   * rows, so only the limits themselves are editable.
   */
  rows?: DBRow[];
}) {
  // Sanitise the untrusted config against the live property schema before the
  // toolbar reads it, so stale keys and references to deleted properties are
  // already gone by the time a control writes its patch back.
  const schemaProperties: SchemaViewProperty[] = properties.map((property) => ({
    id: property.id,
    type: property.type,
  }));
  const config = sanitizeViewSettings(incoming, schemaProperties);
  // Strict safety net: shape problems the tolerant read path cannot express.
  const configIssues = validateViewConfig(toSchemaConfig(config)).filter(
    (issue) => issue.code !== "invalid_view_type",
  );
  const persistedWipLimits = config.wipLimits ?? {};

  // Saved views live for the session only (no server persistence yet). The
  // hooks sit above the `editable` early return so the call order is stable.
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewName, setSavedViewName] = useState("");
  // WIP limits are edited locally so the number inputs stay responsive while
  // the server round-trips the config; each change is still written through
  // `onChange` (see `setWipLimit`).
  const [wipLimits, setWipLimits] = useState<WipLimits>(persistedWipLimits);
  const persistedWipKey = JSON.stringify(persistedWipLimits);
  useEffect(() => {
    setWipLimits(persistedWipLimits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedWipKey]);

  if (!editable) return null;

  const filters = config.filters ?? [];
  const sorts = config.sorts ?? [];
  const groupBy = config.groupByPropertyId ?? "";
  const laneBy = config.laneBy ?? "";
  const groupable = properties.filter((p) =>
    ["SELECT", "STATUS", "MULTI_SELECT"].includes(p.type),
  );
  const defaultProperty =
    properties.find((p) => !p.config?.primary) ?? properties[0];

  const secondary = properties.filter((p) => !p.config?.primary);

  // --- Chart + gallery settings --------------------------------------------
  // Both are plain view-config keys this toolbar owns (like `laneBy`): the
  // chart/gallery engines read them at render time, so a picker only needs the
  // current value and a patch. The defaults below mirror the engines' own
  // (`ChartView` draws a bar chart aggregating by count; an unset gallery
  // preview falls back to the first cover-eligible property).
  const chartType = config.chartType ?? "bar";
  const chartAggregate = config.chartAggregate ?? "count";
  const previewPropertyId = config.previewPropertyId ?? "";
  const previewable = properties.filter((property) =>
    GALLERY_PREVIEW_TYPES.includes(property.type),
  );

  // --- Board group summary (summarize by property) -------------------------
  // The property each board column aggregates (Sum / Average / Count). Like
  // `laneBy`/`wipLimits`, it is a view-config key this toolbar owns and rides
  // through `sanitizeViewSettings` untouched; `BoardView` (feat/q03) falls back
  // to the first NUMBER column when it is unset or unknown, so an empty value
  // here mirrors that "Automatic" default. Only NUMBER properties are offered,
  // since that is all the per-column aggregation maths can summarize.
  const aggregationPropertyId = config.aggregationPropertyId ?? "";
  const numericProperties = properties.filter(
    (property) => property.type === "NUMBER",
  );

  // --- WIP limits (board columns) ------------------------------------------
  // A board's columns are the declared options of the group property plus the
  // trailing "No value" bucket — exactly what `groupRowsByProperty` builds.
  // Limits are keyed by that column key, and `checkWip` grades each column
  // against its limit; the editor below shows the grade and persists the map.
  const wipProperty = properties.find((property) => property.id === groupBy) ?? null;
  const boardProperties: BoardPropertyDescriptor[] = properties.map((property) => ({
    id: property.id,
    name: property.name,
    type: property.type,
    config: property.config,
  }));
  const wipGroups = wipProperty
    ? groupRowsByProperty(rows ?? [], boardProperties, wipProperty.id)
    : [];
  const wipCheck = checkWip(wipGroups, wipLimits);
  const wipRollup = wipSummary(wipGroups, wipLimits);
  const wipStatusByKey = new Map(
    wipCheck.columns.map((column) => [column.key, column]),
  );
  const limitedCount = Object.keys(wipLimits).length;

  // --- Group visibility (board columns) ------------------------------------
  // The same buckets the WIP editor grades, filtered through the engine's
  // `visibleGroups` so this editor agrees with what the board renders: a key
  // mapped to `false` hides its column and missing keys stay visible. The map
  // is owned here and persisted as the view's `visibleGroups`.
  const groupVisibility: GroupVisibility = config.visibleGroups ?? {};
  const groupColumns = wipProperty ? wipGroups : [];
  const hiddenGroupCount =
    groupColumns.length - filterVisibleGroups(groupColumns, groupVisibility).length;

  /** Show or hide one board column and persist the visibility map. */
  const setGroupVisible = (key: string, visible: boolean) => {
    const next: Record<string, boolean> = { ...groupVisibility };
    if (visible) delete next[key];
    else next[key] = false;
    onChange({ visibleGroups: next });
  };

  /** Set (or clear, on blank) one column's limit and persist the map. */
  const setWipLimit = (key: string, value: string) => {
    const next: Record<string, number> = { ...wipLimits };
    if (value.trim() === "") {
      delete next[key];
    } else {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) return;
      next[key] = parsed;
    }
    setWipLimits(next);
    onChange({ wipLimits: next });
  };

  // --- Saved-view actions --------------------------------------------------
  const secondaryIds = presetSecondaryIds(properties);

  /** Overlay a stored preset onto the current config (base fields it omits survive). */
  const applyPreset = (view: SavedView) => {
    const merged = applySavedView(presetViewConfig(config, secondaryIds), view);
    onChange(configPatchForPreset(merged, secondaryIds));
  };

  /** Capture the current config as a named preset (updating a same-named one). */
  const savePreset = () => {
    const name = savedViewName.trim();
    if (!name) return;
    const preset = presetFromConfig(name, config, secondaryIds);
    if (!preset) return;
    setSavedViews((previous) =>
      deserializeSavedViews([
        ...previous.filter(
          (view) => view.name.trim().toLowerCase() !== name.toLowerCase(),
        ),
        preset,
      ]),
    );
    setSavedViewName("");
  };

  const removeSavedView = (view: SavedView) => {
    setSavedViews((previous) => previous.filter((candidate) => candidate.id !== view.id));
  };

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
  // When the caller does not pass a layout, fall back to the view config's own
  // serialized `columnLayout`; visibility still seeds from the legacy
  // `visiblePropertyIds` list when that is set, so older configs are unchanged.
  const storedLayout = deserializeLayout(config.columnLayout);
  const legacyHidden =
    config.visiblePropertyIds === undefined
      ? storedLayout.hidden
      : Object.fromEntries(
          secondary
            .filter(
              (property) => !config.visiblePropertyIds?.includes(property.id),
            )
            .map((property) => [property.id, true] as const),
        );
  const baseLayout: ColumnLayout = layout ?? {
    order: storedLayout.order,
    widths: storedLayout.widths,
    hidden: legacyHidden,
  };
  const mergedLayout = mergeLayout(baseLayout, columnIds);
  const visibleSet = new Set(visibleColumns(baseLayout, columnIds));
  const hiddenCount = secondary.filter(
    (property) => !visibleSet.has(property.id),
  ).length;

  /** Visible column ids in layout order — the columns a width applies to. */
  const visibleIds = visibleColumns(mergedLayout, columnIds);

  /**
   * Commit a column layout. Through `onLayoutChange` when the caller wires it
   * (database-view keeps the session layout and mirrors visibility), else
   * serialized into the view config's `columnLayout` so widths survive a read
   * back through `deserializeLayout`.
   */
  const commitLayout = (next: ColumnLayout) => {
    if (onLayoutChange) {
      onLayoutChange(next);
      return;
    }
    onChange({ columnLayout: serializeLayout(mergeLayout(next, columnIds)) });
  };

  /** Set one column's width (clamped); blank or non-numeric input is ignored. */
  const setWidth = (propertyId: string, raw: string) => {
    if (raw.trim() === "") return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    commitLayout(setColumnWidth(mergedLayout, propertyId, clampWidth(parsed)));
  };

  /** Reset every column to `DEFAULT_COLUMN_WIDTH`, keeping order and visibility. */
  const resetWidths = () => {
    commitLayout({ ...mergedLayout, widths: {} });
  };

  /** Share the nominal table width evenly across the visible columns. */
  const autoFitWidthsForView = () => {
    commitLayout({
      ...mergedLayout,
      widths: {
        ...mergedLayout.widths,
        ...autoFitWidths(AUTO_FIT_WIDTH, visibleIds),
      },
    });
  };

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
              (groupBy || laneBy) && "bg-surface-2 text-fg",
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
          <div className="mt-3 border-t border-border pt-2">
            <label className="mb-1 block text-xs text-muted" htmlFor="lane-by">
              Group by (lanes)
            </label>
            <select
              id="lane-by"
              data-testid="lane-by"
              value={laneBy}
              onChange={(e) => onChange({ laneBy: e.target.value || undefined })}
              className={cn(CONTROL_CLASS, "w-full")}
            >
              <option value="">None</option>
              {groupable.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="mt-2 text-xs text-muted">
              A second grouping slices the board into horizontal lanes
              (swimlanes).
            </p>
          </div>
        </PopoverContent>
      </Popover>

      {/* WIP limits — one per board column, persisted in the view config */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="wip-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              limitedCount > 0 && "bg-surface-2 text-fg",
              wipRollup.overCount > 0 && "text-red-500",
            )}
          >
            <Gauge className="h-3.5 w-3.5" />
            WIP limits{limitedCount > 0 ? ` (${limitedCount})` : ""}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72" data-testid="wip-popover">
          {wipProperty ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Work-in-progress limits for “{wipProperty.name}”. Leave a field
                blank for no limit.
              </p>
              {wipGroups.map((group) => {
                const status = wipStatusByKey.get(group.key);
                const limit = wipLimits[group.key];
                return (
                  <div key={group.key} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{group.label}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      {group.rows.length}
                      {limit !== undefined ? ` / ${limit}` : ""}
                    </span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={limit ?? ""}
                      data-testid={`wip-limit-${group.key}`}
                      aria-label={`${group.label} WIP limit`}
                      placeholder="∞"
                      onChange={(event) => setWipLimit(group.key, event.target.value)}
                      className={cn(CONTROL_CLASS, "w-16")}
                    />
                    {status?.status === "over" && (
                      <span
                        data-testid={`wip-status-${group.key}`}
                        className="shrink-0 text-xs text-red-500"
                      >
                        over
                      </span>
                    )}
                    {status?.status === "at" && (
                      <span
                        data-testid={`wip-status-${group.key}`}
                        className="shrink-0 text-xs text-amber-500"
                      >
                        at limit
                      </span>
                    )}
                  </div>
                );
              })}
              {wipRollup.limitedColumns > 0 && (
                <p className="border-t border-border pt-2 text-xs text-muted">
                  {wipRollup.limitedColumns} limited · {wipRollup.overCount} over ·{" "}
                  {wipRollup.remainingCapacity} slots free
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted">
              Group by a select or status property to set per-column limits.
            </p>
          )}
        </PopoverContent>
      </Popover>

      {/* Groups — show/hide board columns, persisted per view as `visibleGroups` */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="groups-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              hiddenGroupCount > 0 && "bg-surface-2 text-fg",
            )}
          >
            <Eye className="h-3.5 w-3.5" />
            Groups{hiddenGroupCount > 0 ? ` (${hiddenGroupCount})` : ""}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64" data-testid="db-groups-popover">
          {wipProperty ? (
            <div className="space-y-1">
              <p className="mb-2 text-xs text-muted">
                Show or hide the columns of “{wipProperty.name}”.
              </p>
              <ul className="space-y-1">
                {groupColumns.map((group) => (
                  <li key={group.key}>
                    <label className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-2">
                      <input
                        type="checkbox"
                        checked={groupVisibility[group.key] !== false}
                        data-testid={`group-visibility-${group.key}`}
                        aria-label={`${group.label} visible`}
                        onChange={(event) =>
                          setGroupVisible(group.key, event.target.checked)
                        }
                        className="accent-[var(--accent)]"
                      />
                      <span className="flex-1 truncate">{group.label}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {group.rows.length}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {hiddenGroupCount > 0 && (
                <button
                  type="button"
                  data-testid="groups-show-all"
                  onClick={() => onChange({ visibleGroups: {} })}
                  className="flex items-center gap-1 border-t border-border pt-2 text-xs text-accent"
                >
                  <RotateCcw className="h-3 w-3" /> Show all groups
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted">
              Group by a select or status property to hide or show groups.
            </p>
          )}
        </PopoverContent>
      </Popover>

      {/* Summarize by — the metric each board column aggregates (Sum / Average
          / Count), persisted as the view's `aggregationPropertyId` for the
          per-column summary in `BoardView` (feat/q03). */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="aggregation-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              aggregationPropertyId && "bg-surface-2 text-fg",
            )}
          >
            <Sigma className="h-3.5 w-3.5" />
            Summarize
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64" data-testid="db-aggregation-popover">
          <label className="mb-1 block text-xs text-muted" htmlFor="aggregation-property">
            Summarize by property
          </label>
          <select
            id="aggregation-property"
            data-testid="aggregation-property"
            value={aggregationPropertyId}
            onChange={(e) =>
              onChange({ aggregationPropertyId: e.target.value || null })
            }
            className={cn(CONTROL_CLASS, "w-full")}
          >
            <option value="">Automatic (first number)</option>
            {numericProperties.map((property) => (
              <option key={property.id} value={property.id}>{property.name}</option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted">
            The value each board column sums, averages or counts.
          </p>
          {numericProperties.length === 0 && (
            <p className="mt-2 text-xs text-muted">
              Add a number property to summarize by one.
            </p>
          )}
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
                <li key={property.id} className="flex items-center gap-1">
                  <label
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-2",
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
                  <input
                    type="number"
                    min={DEFAULT_MIN_WIDTH}
                    max={DEFAULT_MAX_WIDTH}
                    step={10}
                    value={mergedLayout.widths[property.id] ?? DEFAULT_COLUMN_WIDTH}
                    data-testid={`column-width-${property.id}`}
                    aria-label={`${property.name} width`}
                    disabled={!shown}
                    onChange={(event) => setWidth(property.id, event.target.value)}
                    className={cn(CONTROL_CLASS, "w-16 shrink-0 disabled:opacity-40")}
                  />
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex items-center gap-3 border-t border-border pt-2">
            <button
              type="button"
              data-testid="columns-auto-fit"
              onClick={autoFitWidthsForView}
              className="flex items-center gap-1 text-xs text-accent"
            >
              <Maximize2 className="h-3 w-3" /> Auto-fit widths
            </button>
            <button
              type="button"
              data-testid="columns-reset-widths"
              onClick={resetWidths}
              className="flex items-center gap-1 text-xs text-muted hover:text-fg"
            >
              <RotateCcw className="h-3 w-3" /> Reset widths
            </button>
          </div>
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

      {/* Saved views — named filter/sort/group presets for this database.
          In-session only: each preset overlays the current config through
          `applySavedView`, and the config can be captured under a name. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="saved-views-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              savedViews.length > 0 && "bg-surface-2 text-fg",
            )}
          >
            <Bookmark className="h-3.5 w-3.5" />
            {t(locale, "savedViews")}
            {savedViews.length > 0 ? ` (${savedViews.length})` : ""}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72" data-testid="saved-views-popover">
          <div className="space-y-2">
            {savedViews.length === 0 && (
              <p className="text-xs text-muted">No saved views yet.</p>
            )}
            {savedViews.map((view) => (
              <div key={view.id} className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid={`apply-saved-view-${view.id}`}
                  onClick={() => applyPreset(view)}
                  className="flex-1 truncate rounded px-1 py-0.5 text-left text-sm hover:bg-surface-2"
                >
                  {view.name}
                </button>
                <button
                  type="button"
                  aria-label={`${t(locale, "delete")} ${view.name}`}
                  onClick={() => removeSavedView(view)}
                  className="text-muted hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-1 border-t border-border pt-2">
              <input
                value={savedViewName}
                data-testid="saved-view-name"
                aria-label={t(locale, "savedViews")}
                placeholder="Name this view"
                onChange={(event) => setSavedViewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") savePreset();
                }}
                className={cn(CONTROL_CLASS, "flex-1")}
              />
              <button
                type="button"
                data-testid="save-saved-view"
                disabled={savedViewName.trim().length === 0}
                onClick={savePreset}
                className="flex items-center gap-1 text-xs text-accent disabled:opacity-50"
              >
                <Plus className="h-3 w-3" /> {t(locale, "save")}
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Chart — shape + aggregation, persisted as `chartType`/`chartAggregate`
          for `ChartView`. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="chart-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              (config.chartType || config.chartAggregate) && "bg-surface-2 text-fg",
            )}
          >
            <BarChart3 className="h-3.5 w-3.5" />
            Chart
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64" data-testid="db-chart-popover">
          <label className="mb-1 block text-xs text-muted" htmlFor="chart-type">
            Chart type
          </label>
          <select
            id="chart-type"
            data-testid="chart-type"
            value={chartType}
            onChange={(e) => onChange({ chartType: e.target.value as ChartType })}
            className={cn(CONTROL_CLASS, "w-full")}
          >
            {CHART_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <label className="mt-3 mb-1 block text-xs text-muted" htmlFor="chart-aggregate">
            Aggregate
          </label>
          <select
            id="chart-aggregate"
            data-testid="chart-aggregate"
            value={chartAggregate}
            onChange={(e) =>
              onChange({ chartAggregate: e.target.value as AggregationFn })
            }
            className={cn(CONTROL_CLASS, "w-full")}
          >
            {AGGREGATION_FUNCTIONS.map((fn) => (
              <option key={fn.id} value={fn.id}>{fn.label}</option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted">
            The shape and totals the Chart view draws per group.
          </p>
        </PopoverContent>
      </Popover>

      {/* Gallery — the preview property cards show, persisted as
          `previewPropertyId` for `resolveCardPreview`. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="gallery-trigger"
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-surface-2",
              previewPropertyId && "bg-surface-2 text-fg",
            )}
          >
            <ImageIcon className="h-3.5 w-3.5" />
            Gallery
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64" data-testid="db-gallery-popover">
          <label className="mb-1 block text-xs text-muted" htmlFor="gallery-preview">
            Preview property
          </label>
          <select
            id="gallery-preview"
            data-testid="gallery-preview-property"
            value={previewPropertyId}
            onChange={(e) => onChange({ previewPropertyId: e.target.value || null })}
            className={cn(CONTROL_CLASS, "w-full")}
          >
            <option value="">Automatic (first image)</option>
            {previewable.map((property) => (
              <option key={property.id} value={property.id}>{property.name}</option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted">
            The image a card shows; falls back to the page icon.
          </p>
        </PopoverContent>
      </Popover>

      {configIssues.length > 0 && (
        <span
          data-testid="view-config-issues"
          title={configIssues.map((issue) => issue.message).join("\n")}
          className="rounded px-1.5 py-0.5 text-xs text-amber-500"
        >
          {configIssues.length} config warning{configIssues.length === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Timeline & Chart views
   --------------------------------------------------------------------------- */

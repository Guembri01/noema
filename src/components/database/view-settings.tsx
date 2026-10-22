"use client";

import { useEffect, useState } from "react";
import {
  ArrowUpDown,
  BarChart3,
  Bookmark,
  Calculator,
  Columns3,
  Eye,
  Filter as FilterIcon,
  Gauge,
  Image as ImageIcon,
  Layers,
  LayoutTemplate,
  Maximize2,
  Palette,
  Plus,
  RotateCcw,
  Sigma,
  Star,
  Trash2,
  X } from "lucide-react";
import {
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
  type QueryProperty,
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
  addNode as addBuilderNode,
  describeTree as describeBuilderTree,
  findPath as findBuilderPath,
  isGroup as isBuilderGroup,
  makeGroup as makeBuilderGroup,
  makeLeaf as makeBuilderLeaf,
  moveNode as moveBuilderNode,
  normalizeTree as normalizeBuilderTree,
  removeNode as removeBuilderNode,
  updateNode as updateBuilderNode,
  validateTree as validateBuilderTree,
  type FilterGroup as BuilderGroup,
  type FilterLeaf as BuilderLeaf,
  type FilterLeafPatch as BuilderLeafPatch,
  type FilterNode as BuilderNode,
} from "@/lib/filter-tree-ui";
import {
  describeLayout,
  moveProperty,
  parsePropertyLayout,
  resolveLayout,
  responsivePlan,
  setSpan,
  toggleColumns,
  validateLayout,
  type LayoutProperty,
  type PropertyLayout,
  type PropertySpan,
} from "@/lib/property-layout-engine";
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
import {
  COLOR_TOKENS,
  isSafeColor,
  isConditionOp,
  parseFormatRule,
  type FormatRule,
} from "@/lib/conditional-format";
import {
  footerFunctionsForType,
  parseFooterSpec,
  type FooterSpec,
} from "@/lib/footer-calculations";
import { useAction } from "@/lib/actions-client";
import {
  reorderTemplatesAction,
  setDefaultTemplateAction,
} from "@/server/actions/database";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import { Tooltip } from "@/components/ui/tooltip";
import type { ReactNode } from "react";

/* ---------------------------------------------------------------------------
   Shared chrome + option builders for every settings popover
   `SettingsPopoverContent` layers the design system on the Popover primitive:
   the primitive already supplies `.surface-raised`, `animate-rise` and
   `Z.popover`; this adds a sticky header, a `.scrollbar-thin` scrolling body and
   a sticky footer. The `*Options` helpers turn the app's domain lists into the
   `Select` primitive's row shape, and `ColorChips` is the `Tag`-based hue
   picker used by the conditional-format rule editor.
   --------------------------------------------------------------------------- */

/** `DBProperty[]` → `Select` rows (id/value). */
import {
  propertyOptions,
  operatorOptions,
  SettingsPopoverContent,
  ColorChips,
  newLeaf,
  treeFromConfig,
  fromFilterNode,
  toFilterNodes,
  toFilterNode,
  updateAtPath,
  removeNodeAtPath,
  FilterLeafRow,
  FilterGroupRows,
  BUILDER_VALUELESS_OPERATORS,
  collectBuilderGroupOptions,
  setBuilderGroupOp,
  BuilderLeafRow,
  BuilderGroupRows,
  presetSecondaryIds,
  presetViewConfig,
  presetFromConfig,
  configPatchForPreset,
  ViewSettingsConfig,
  ViewTemplateOption,
  wipRecord,
  colorRuleToSchema,
  toSchemaConfig,
  colorRuleFromSchema,
  normalizeWipLimits,
  normalizeVisibleGroups,
  normalizeStringList,
  normalizeAggregationFn,
  normalizeToggle,
  moveColorRule,
  colorRuleToFormatRule,
  colorRulesToFormatRules,
  formatRuleToColorRule,
  formatRulesToColorRules,
  setFooterFunction,
  removeFooterFunction,
  moveTemplate,
  sanitizeViewSettings,
} from "./view-settings-model";
export * from "./view-settings-model";

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
  templates,
  databasePageId,
  variant = "all",
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
  /**
   * The database's saved templates. Optional: the "Templates" popover (default
   * toggle + reorder, backed by `setDefaultTemplateAction` /
   * `reorderTemplatesAction`) only renders once the caller supplies them.
   */
  templates?: ViewTemplateOption[];
  /**
   * The database page the template actions operate on. Optional for the same
   * reason as `templates`; without both the popover stays hidden.
   */
  databasePageId?: string;
  /**
   * `all` keeps the original toolbar. `primary` is the short row (filter, sort,
   * group, colour, properties); `advanced` is the disclosure panel behind
   * "More". The database screen composes the two.
   */
  variant?: "all" | "primary" | "advanced";
}) {
  const primaryIds = new Set(["filter", "sort", "group", "color", "properties"]);
  const show = (id: string) =>
    variant === "all" || (variant === "primary" ? primaryIds.has(id) : !primaryIds.has(id));
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

  const persistedFooter = config.footer ?? [];
  // Templates: the default slot and the dense order are edited locally so the
  // popover stays responsive while the server round-trips the template actions;
  // each change still goes through `setDefaultTemplateAction` /
  // `reorderTemplatesAction` in the handlers below.
  const templateIds = (templates ?? []).map((template) => template.id);
  const persistedDefaultTemplateId =
    templates?.find((template) => template.isDefault)?.id ?? null;
  const [templateOrder, setTemplateOrder] = useState<string[]>(templateIds);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(
    persistedDefaultTemplateId,
  );
  const templateKey = templateIds.join("|");
  useEffect(() => {
    setTemplateOrder((previous) => {
      const known = templateIds;
      const kept = previous.filter((id) => known.includes(id));
      const appended = known.filter((id) => !previous.includes(id));
      return [...kept, ...appended];
    });
    setDefaultTemplateId(persistedDefaultTemplateId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey, persistedDefaultTemplateId]);

  // Footer calculations: edited locally for the same reason as the WIP limits;
  // the resulting `{ propertyId, fn }[]` is written through `onChange` and read
  // back by the table footer engine.
  const [footerSpec, setFooterSpec] = useState<FooterSpec>(persistedFooter);
  const persistedFooterKey = JSON.stringify(persistedFooter);
  useEffect(() => {
    setFooterSpec(persistedFooter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedFooterKey]);

  // One toast + pending flag for every template action, like every other action
  // call site (`@/lib/actions-client`). `run` ignores a rejected transport and
  // surfaces it as an error toast instead of an unhandled rejection.
  const { run: runAction } = useAction(locale);

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

  // --- Group ordering + per-group aggregation (view config) ----------------
  // The same buckets the WIP editor grades, but ordered through this view's
  // saved `groupOrder` (option ids; the "No value" bucket always stays last) —
  // exactly the `optionOrder` the board engine reads back. `groupAggregation`
  // is the summary each group shows. Both are view-config keys this toolbar
  // owns and rides through `sanitizeViewSettings` untouched.
  const groupOrder = config.groupOrder ?? [];
  const groupAggregation = config.groupAggregation ?? "";
  const orderedGroupColumns = wipProperty
    ? groupRowsByProperty(rows ?? [], boardProperties, wipProperty.id, {
        optionOrder: groupOrder,
      })
    : [];
  const orderableGroups = orderedGroupColumns.filter((group) => group.optionId !== null);
  const orderableIds = orderableGroups.map((group) => group.key);

  /** Show or hide one board column and persist the visibility map. */
  const setGroupVisible = (key: string, visible: boolean) => {
    const next: Record<string, boolean> = { ...groupVisibility };
    if (visible) delete next[key];
    else next[key] = false;
    onChange({ visibleGroups: next });
  };

  /**
   * Move the group at `index` by `delta` places and persist the resulting
   * option-id order. The trailing "No value" bucket never enters `groupOrder`,
   * so it stays last however the user reorders.
   */
  const moveGroupOrder = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= orderableIds.length) return;
    const next = [...orderableIds];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    onChange({ groupOrder: next });
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

  // --- AND/OR builder tree (filter-tree-ui) --------------------------------
  // An additive sibling of the filter-tree editor: it edits a `FilterGroup`
  // (stable ids, index-path edits, move/validate/normalize/describe) persisted
  // as `config.filterBuilder`. `applyView` gives it precedence and lowers it
  // through `toQueryExpr`, so a saved builder tree really filters the rows.
  const builderTree = config.filterBuilder ?? null;
  const builderProperties = properties as unknown as QueryProperty[];
  const builderGroupOptions = builderTree ? collectBuilderGroupOptions(builderTree) : [];
  const builderIssues = builderTree
    ? validateBuilderTree(builderTree, { properties: builderProperties })
    : [];
  const builderDescription = builderTree
    ? describeBuilderTree(builderTree, {
        propertyName: (id) => properties.find((p) => p.id === id)?.name ?? id,
      })
    : "";
  const builderDefaultProperty = defaultProperty ?? properties[0];

  const commitBuilder = (next: BuilderGroup) => onChange({ filterBuilder: next });

  const createBuilderTree = () => {
    if (!builderDefaultProperty) return;
    const op = config.filterMode === "or" ? "or" : "and";
    const children: BuilderNode[] =
      filters.length > 0
        ? filters.map((filter) =>
            makeBuilderLeaf({
              propertyId: filter.propertyId,
              op: filter.operator,
              value: filter.value,
            }),
          )
        : [
            makeBuilderLeaf({
              propertyId: builderDefaultProperty.id,
              op: "contains",
              value: "",
            }),
          ];
    commitBuilder(makeBuilderGroup(op, children));
  };

  const addBuilderConditionAt = (path: number[]) => {
    if (!builderTree || !builderDefaultProperty) return;
    commitBuilder(
      addBuilderNode(
        builderTree,
        path,
        makeBuilderLeaf({
          propertyId: builderDefaultProperty.id,
          op: "contains",
          value: "",
        }),
      ),
    );
  };

  const addBuilderGroupAt = (path: number[]) => {
    if (!builderTree || !builderDefaultProperty) return;
    const child = makeBuilderLeaf({
      propertyId: builderDefaultProperty.id,
      op: "contains",
      value: "",
    });
    commitBuilder(addBuilderNode(builderTree, path, makeBuilderGroup("and", [child])));
  };

  const removeBuilderAt = (path: number[]) => {
    if (!builderTree) return;
    commitBuilder(removeBuilderNode(builderTree, path));
  };

  const setBuilderOpAt = (path: number[], op: "and" | "or") => {
    if (!builderTree) return;
    commitBuilder(setBuilderGroupOp(builderTree, path, op));
  };

  const setBuilderLeafAt = (path: number[], patch: BuilderLeafPatch) => {
    if (!builderTree) return;
    commitBuilder(updateBuilderNode(builderTree, path, patch));
  };

  const moveBuilderAt = (path: number[], destinationId: string) => {
    if (!builderTree) return;
    const destination = findBuilderPath(builderTree, destinationId);
    if (!destination) return;
    commitBuilder(moveBuilderNode(builderTree, path, destination));
  };

  const normalizeBuilder = () => {
    if (!builderTree) return;
    commitBuilder(normalizeBuilderTree(builderTree));
  };

  const clearBuilder = () => onChange({ filterBuilder: undefined });

  // --- Two-column page property layout (property-layout-engine) -------------
  // The persisted layout's order is merged with the live schema (saved ids
  // first, new properties appended), then resolved into per-property grid
  // placements and collapsed for a narrow viewport by `responsivePlan`. The
  // resolved placements are previewed here; the page property panel consumes
  // `propertyLayout` outside this file.
  const layoutSchema: LayoutProperty[] = properties.map((property) => ({
    id: property.id,
    name: property.name,
  }));
  const persistedPropertyLayout = parsePropertyLayout(config.propertyLayout);
  const schemaPropertyIds = properties.map((property) => property.id);
  const propertyLayout: PropertyLayout = {
    ...persistedPropertyLayout,
    order: [
      ...persistedPropertyLayout.order.filter((id) => schemaPropertyIds.includes(id)),
      ...schemaPropertyIds.filter((id) => !persistedPropertyLayout.order.includes(id)),
    ],
  };
  const layoutPlacements = resolveLayout(propertyLayout, { properties: layoutSchema });
  const layoutIssues = validateLayout(propertyLayout, { properties: layoutSchema });
  const narrowLayoutPlan = responsivePlan(propertyLayout, { widthBucket: "narrow" });
  const propertyLayoutSummary = describeLayout(propertyLayout, {
    propertyName: (id) => properties.find((p) => p.id === id)?.name ?? id,
  });
  const fullWidthPlacements = layoutPlacements.filter(
    (placement) => placement.span === 2,
  ).length;

  const commitPropertyLayout = (next: PropertyLayout) =>
    onChange({ propertyLayout: next });

  const togglePropertyLayoutColumns = () =>
    commitPropertyLayout(toggleColumns(propertyLayout));

  const togglePropertyLayoutDividers = () =>
    commitPropertyLayout({ ...propertyLayout, dividers: !propertyLayout.dividers });

  const movePropertyLayout = (propertyId: string, delta: number) => {
    const index = propertyLayout.order.indexOf(propertyId);
    if (index === -1) return;
    commitPropertyLayout(moveProperty(propertyLayout, propertyId, index + delta));
  };

  const togglePropertyLayoutSpan = (propertyId: string) => {
    const current: PropertySpan = propertyLayout.spans?.[propertyId] === 2 ? 2 : 1;
    commitPropertyLayout(setSpan(propertyLayout, propertyId, current === 2 ? 1 : 2));
  };

  // --- Bounded list loading (pageSize) -------------------------------------
  const pageSize = config.pageSize ?? 0;
  const setPageSize = (value: string) =>
    onChange({ pageSize: Number(value) > 0 ? Number(value) : undefined });

  // --- Templates (default toggle + reorder) --------------------------------
  // The popover only renders when the caller passes both a template list and the
  // database page, so the two actions below are only ever invoked with a real
  // target. `setDefaultTemplateAction` keeps `isDefault` a single slot per
  // database; `reorderTemplatesAction` rewrites `position` from this order.
  const orderedTemplates = templateOrder
    .map((id) => (templates ?? []).find((template) => template.id === id) ?? null)
    .filter((template): template is ViewTemplateOption => template !== null);

  const toggleDefaultTemplate = (template: ViewTemplateOption) => {
    if (!databasePageId) return;
    const nextDefault = defaultTemplateId === template.id ? null : template.id;
    setDefaultTemplateId(nextDefault);
    runAction(
      () => setDefaultTemplateAction(template.id, nextDefault === template.id),
      {
        success:
          nextDefault === template.id
            ? "Default template set"
            : "Default template cleared",
      },
    );
  };

  const moveDefaultTemplate = (index: number, delta: number) => {
    if (!databasePageId) return;
    const next = moveTemplate(templateOrder, index, delta);
    if (next.join("|") === templateOrder.join("|")) return;
    setTemplateOrder(next);
    runAction(() => reorderTemplatesAction(databasePageId, next));
  };

  // --- Footer calculations (one function per visible column) ---------------
  /** Set (or clear, on blank/unknown) one column's footer function. */
  const setColumnFooter = (property: DBProperty, value: string) => {
    const known = footerFunctionsForType(property.type);
    const next =
      value === "" || !known.includes(value as AggregationFn)
        ? removeFooterFunction(footerSpec, property.id)
        : setFooterFunction(footerSpec, property.id, value as AggregationFn);
    setFooterSpec(next);
    onChange({ footer: next });
  };

  // --- Conditional formatting (add / remove / reorder + colour) ------------
  /**
   * Persist a colour-rule edit and its conditional-format projection together.
   * `colorRules` is what the row-colour engine renders; `formatRules` is the
   * same list in the vocabulary `@/lib/conditional-format` parses — including
   * the ascending priority the array order encodes.
   */
  const commitColorRules = (next: ColorRule[]) => {
    onChange({ colorRules: next, formatRules: colorRulesToFormatRules(next) });
  };

  // --- Footer columns (visible columns, resolved from the merged layout) ----
  const footerColumns = visibleIds
    .map((id) => properties.find((property) => property.id === id) ?? null)
    .filter((property): property is DBProperty => property !== null);
  const footerFnById = new Map(
    footerSpec.map((entry) => [entry.propertyId, entry.fn] as const),
  );

  return (
    <div
      className={cn(
        "mb-3 flex items-center gap-1 text-sm",
        variant === "advanced"
          ? "flex-wrap"
          : "flex-nowrap overflow-x-auto pb-1 no-scrollbar [&>*]:shrink-0 md:flex-wrap md:overflow-visible md:pb-0",
      )}
    >
      {/* Filter */}
      {show("filter") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="filter-trigger"
            className={cn(filterActive && "bg-surface-2 text-fg")}
            leftIcon={<FilterIcon className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "dbFilter")}{filterCount > 0 ? ` (${filterCount})` : ""}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "dbFilter")}
          className="w-80"
          data-testid="db-filter-popover"
          footer={
            <div data-testid="header-quick-filter">
              <Switch
                size="sm"
                checked={config.quickFilter !== false}
                label={t(locale, "quickFilterFromHeaders")}
                aria-label={t(locale, "quickFilterFromHeaders")}
                onCheckedChange={() =>
                  onChange({ quickFilter: config.quickFilter === false })
                }
              />
            </div>
          }
        >
          <div className="space-y-2">
            {tree ? (
              <>
                <FilterGroupRows
                  locale={locale}
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
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="filters-flatten"
                  onClick={() => onChange({ filterTree: [] })}
                >
                  Use simple filters
                </Button>
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
                        <span className="min-w-0 flex-1" data-testid="filter-property">
                          <Select
                            size="sm"
                            allowClear={false}
                            options={propertyOptions(properties)}
                            value={filter.propertyId}
                            aria-label={t(locale, "dbFilter")}
                            onChange={(value) => onChange({
                              filters: filters.map((f, i) =>
                                i === index ? { ...f, propertyId: value } : f,
                              ),
                            })}
                          />
                        </span>
                        <Tooltip label={t(locale, "removeFilter")}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t(locale, "removeFilter")}
                            onClick={() => onChange({ filters: filters.filter((_, i) => i !== index) })}
                          >
                            <X className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </Tooltip>
                      </div>
                      <div data-testid="filter-operator">
                        <Select
                          size="sm"
                          allowClear={false}
                          options={operatorOptions(property?.type)}
                          value={filter.operator}
                          aria-label={t(locale, "filterOperatorAria")}
                          onChange={(value) => onChange({
                            filters: filters.map((f, i) =>
                              i === index ? { ...f, operator: value as Filter["operator"] } : f,
                            ),
                          })}
                        />
                      </div>
                      {!noValue && (
                        <Input
                          value={filter.value ?? ""}
                          data-testid="filter-value"
                          onChange={(e) => onChange({
                            filters: filters.map((f, i) =>
                              i === index ? { ...f, value: e.target.value } : f,
                            ),
                          })}
                          placeholder={t(locale, "valuePlaceholder")}
                        />
                      )}
                    </div>
                  );
                })}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="add-filter"
                    disabled={!addableFilterProperty}
                    leftIcon={<Plus className="h-3 w-3" aria-hidden />}
                    onClick={() =>
                      onChange({
                        filters: addFilter(filters, {
                          propertyId: addableFilterProperty?.id ?? "",
                          operator: "contains",
                          value: "",
                        }),
                      })
                    }
                  >
                    Add filter
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="add-filter-group"
                    leftIcon={<Plus className="h-3 w-3" aria-hidden />}
                    onClick={startTree}
                  >
                    Add filter group
                  </Button>
                </div>
              </>
            )}
          </div>
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* AND/OR builder tree — the richer sibling of the filter-tree editor.
          Persisted as `config.filterBuilder` (filter-tree-ui) and lowered by
          `applyView` through `toQueryExpr`, so a saved tree really filters. */}
      {show("builder") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="builder-trigger"
            className={cn(builderTree && "bg-surface-2 text-fg")}
            leftIcon={<FilterIcon className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "builderWord")}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "builderWord")}
          className="w-96"
          data-testid="db-builder-popover"
          footer={
            builderTree ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="builder-normalize"
                  leftIcon={<RotateCcw className="h-3 w-3" aria-hidden />}
                  onClick={normalizeBuilder}
                >
                  Normalize
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="builder-clear"
                  onClick={clearBuilder}
                >
                  Clear
                </Button>
              </div>
            ) : undefined
          }
        >
          {builderTree ? (
            <div className="space-y-2">
              <BuilderGroupRows
                locale={locale}
                node={builderTree}
                path={[]}
                depth={0}
                properties={properties}
                groupOptions={builderGroupOptions}
                onAddCondition={addBuilderConditionAt}
                onAddGroup={addBuilderGroupAt}
                onRemove={removeBuilderAt}
                onSetOp={setBuilderOpAt}
                onSetLeafField={setBuilderLeafAt}
                onMove={moveBuilderAt}
              />
              <p className="text-xs text-muted" data-testid="builder-description">
                {builderDescription || "Empty builder — matches every row."}
              </p>
              {builderIssues.length > 0 && (
                <ul className="space-y-0.5 text-xs text-warning" data-testid="builder-issues">
                  {builderIssues.map((issue) => (
                    <li key={`${issue.path.join("-")}-${issue.code}`}>
                      {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Build an AND/OR tree of conditions to any depth. It takes
                precedence over the simple filters while saved.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="builder-create"
                disabled={!builderDefaultProperty}
                leftIcon={<Plus className="h-3 w-3" aria-hidden />}
                onClick={createBuilderTree}
              >
                Create filter group
              </Button>
            </div>
          )}
        </SettingsPopoverContent>
      </Popover>
      )}

      {filters.length > 1 && (
        <span className="flex items-center gap-1 text-xs text-muted">
          Match
          <span className="w-24">
            <Select
              size="sm"
              allowClear={false}
              options={[
                { value: "and", label: "all" },
                { value: "or", label: "any" },
              ]}
              value={config.filterMode ?? "and"}
              aria-label={t(locale, "filterMatchModeAria")}
              onChange={(value) =>
                onChange({ filterMode: value as "and" | "or" })
              }
            />
          </span>
        </span>
      )}

      {/* Color — conditional formatting rules. Array order is the precedence the
          row-colour engine reads (first match wins), so the up/down buttons
          persist `colorRules` order and each edit also writes the same list as
          `formatRules` for the conditional-format engine. */}
      {show("color") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="color-trigger"
            className={cn((config.colorRules?.length ?? 0) > 0 && "bg-surface-2 text-fg")}
            leftIcon={<Palette className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "colorLabel")}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "colorLabel")}
          className="w-80"
          footer={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="add-color-rule"
              disabled={!defaultProperty || config.conditionalFormat === false}
              leftIcon={<Plus className="h-3 w-3" aria-hidden />}
              onClick={() =>
                commitColorRules([
                  ...(config.colorRules ?? []),
                  {
                    propertyId: defaultProperty?.id ?? "",
                    operator: "is",
                    value: "",
                    color: "blue",
                    target: "row",
                  } as ColorRule,
                ])
              }
            >
              Add rule
            </Button>
          }
        >
          <div className="space-y-2">
            {/* Conditional-formatting authoring entry (R89.5): rules are on by
                default; a view can switch the entry off without discarding the
                rules it saved. Unset means enabled. */}
            <div data-testid="conditional-format-toggle">
              <Switch
                size="sm"
                checked={config.conditionalFormat !== false}
                label={t(locale, "conditionalFormatting")}
                aria-label={t(locale, "conditionalFormatting")}
                onCheckedChange={() =>
                  onChange({ conditionalFormat: config.conditionalFormat === false })
                }
              />
            </div>
            {(config.colorRules?.length ?? 0) === 0 && (
              <p className="text-xs text-muted">No color rules — cards stay plain.</p>
            )}
            {(config.colorRules ?? []).map((rule, index) => (
              <div key={index} className="space-y-2 rounded border border-border p-2">
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1">
                    <Select
                      size="sm"
                      allowClear={false}
                      options={propertyOptions(properties)}
                      value={rule.propertyId}
                      aria-label={t(locale, "rulePropertyAria")}
                      onChange={(value) =>
                        commitColorRules(
                          (config.colorRules ?? []).map((r, i) =>
                            i === index ? { ...r, propertyId: value } : r,
                          ),
                        )
                      }
                    />
                  </span>
                  <Tooltip label={`Move rule ${index + 1} up`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move rule ${index + 1} up`}
                      data-testid={`color-rule-up-${index}`}
                      disabled={index === 0}
                      onClick={() =>
                        commitColorRules(moveColorRule(config.colorRules ?? [], index, -1))
                      }
                    >
                      <span aria-hidden>↑</span>
                    </Button>
                  </Tooltip>
                  <Tooltip label={`Move rule ${index + 1} down`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move rule ${index + 1} down`}
                      data-testid={`color-rule-down-${index}`}
                      disabled={index === (config.colorRules?.length ?? 0) - 1}
                      onClick={() =>
                        commitColorRules(moveColorRule(config.colorRules ?? [], index, 1))
                      }
                    >
                      <span aria-hidden>↓</span>
                    </Button>
                  </Tooltip>
                  <Tooltip label={t(locale, "removeRule")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t(locale, "removeRule")}
                      onClick={() =>
                        commitColorRules(
                          (config.colorRules ?? []).filter((_, i) => i !== index),
                        )
                      }
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </Tooltip>
                </div>
                <div data-testid={`color-rule-color-${index}`}>
                  <ColorChips
                    value={rule.color}
                    label={t(locale, "ruleColour")}
                    onSelect={(color) =>
                      commitColorRules(
                        (config.colorRules ?? []).map((r, i) =>
                          i === index ? { ...r, color } : r,
                        ),
                      )
                    }
                  />
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-24" data-testid="color-rule-target">
                    <Select
                      size="sm"
                      allowClear={false}
                      options={[
                        { value: "row", label: t(locale, "rowLabel") },
                        { value: "cell", label: "Cell" },
                      ]}
                      value={rule.target ?? "row"}
                      aria-label={t(locale, "colorRuleTargetAria")}
                      onChange={(value) =>
                        commitColorRules(
                          (config.colorRules ?? []).map((r, i) =>
                            i === index
                              ? { ...r, target: value as ColorRule["target"] }
                              : r,
                          ),
                        )
                      }
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <Select
                      size="sm"
                      allowClear={false}
                      options={operatorOptions(
                        properties.find((p) => p.id === rule.propertyId)?.type,
                      )}
                      value={rule.operator}
                      aria-label={t(locale, "colorRuleOperatorAria")}
                      onChange={(value) =>
                        commitColorRules(
                          (config.colorRules ?? []).map((r, i) =>
                            i === index
                              ? { ...r, operator: value as Filter["operator"] }
                              : r,
                          ),
                        )
                      }
                    />
                  </span>
                </div>
                <Input
                  value={rule.value ?? ""}
                  aria-label={t(locale, "colorRuleValueAria")}
                  onChange={(e) =>
                    commitColorRules(
                      (config.colorRules ?? []).map((r, i) =>
                        i === index ? { ...r, value: e.target.value } : r,
                      ),
                    )
                  }
                  placeholder={t(locale, "valuePlaceholder")}
                />
              </div>
            ))}
          </div>
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Sort */}
      {show("sort") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="sort-trigger"
            className={cn(sorts.length > 0 && "bg-surface-2 text-fg")}
            leftIcon={<ArrowUpDown className="h-3.5 w-3.5" aria-hidden />}
          >
            Sort{sorts.length > 0 ? ` (${sorts.length})` : ""}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "dbSort")}
          className="w-72"
          data-testid="db-sort-popover"
          footer={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="add-sort"
              disabled={!addableSortProperty}
              leftIcon={<Plus className="h-3 w-3" aria-hidden />}
              onClick={() =>
                onChange({
                  sorts: addSort(sorts, addableSortProperty?.id ?? "", "asc"),
                })
              }
            >
              Add sort
            </Button>
          }
        >
          <div className="space-y-2">
            {sorts.length === 0 && <p className="text-xs text-muted">No sorts applied.</p>}
            {sorts.map((sort, index) => {
              const sortName =
                properties.find((p) => p.id === sort.propertyId)?.name ?? "";
              return (
              <div key={`${sort.propertyId}-${index}`} className="space-y-1 rounded border border-border p-2">
                <div className="flex items-center gap-1">
                  <span className="w-6 shrink-0 text-3xs text-muted" title={t(locale, "dbSort")}>
                    {index + 1}.
                  </span>
                  <span className="min-w-0 flex-1" data-testid="sort-property">
                    <Select
                      size="sm"
                      allowClear={false}
                      options={propertyOptions(properties)}
                      value={sort.propertyId}
                      aria-label={`${t(locale, "dbSort")} ${index + 1}: ${sortName}`}
                      onChange={(value) =>
                        onChange({
                          sorts: sorts.map((s, i) =>
                            i === index ? { ...s, propertyId: value } : s,
                          ),
                        })
                      }
                    />
                  </span>
                  <Tooltip label={`${t(locale, "dbMoveUp")}: ${sortName}`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${t(locale, "dbMoveUp")}: ${sortName}`}
                      disabled={index === 0}
                      onClick={() => onChange({ sorts: moveSort(sorts, index, index - 1) })}
                    >
                      <span aria-hidden>↑</span>
                    </Button>
                  </Tooltip>
                  <Tooltip label={`${t(locale, "dbMoveDown")}: ${sortName}`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${t(locale, "dbMoveDown")}: ${sortName}`}
                      disabled={index === sorts.length - 1}
                      onClick={() => onChange({ sorts: moveSort(sorts, index, index + 1) })}
                    >
                      <span aria-hidden>↓</span>
                    </Button>
                  </Tooltip>
                </div>
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1" data-testid="sort-direction">
                    <Select
                      size="sm"
                      allowClear={false}
                      options={[
                        { value: "asc", label: "Ascending" },
                        { value: "desc", label: "Descending" },
                      ]}
                      value={sort.direction}
                      aria-label={`${t(locale, "dbSort")} ${index + 1} ${t(locale, "dbSortDir")}`}
                      onChange={(value) =>
                        onChange({
                          sorts: sorts.map((s, i) =>
                            i === index ? { ...s, direction: value as Sort["direction"] } : s,
                          ),
                        })
                      }
                    />
                  </span>
                  <Tooltip label={`${t(locale, "remove")} ${t(locale, "dbSort")} ${index + 1}: ${sortName}`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${t(locale, "remove")} ${t(locale, "dbSort")} ${index + 1}: ${sortName}`}
                      onClick={() => onChange({ sorts: removeSort(sorts, sort.propertyId) })}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </Tooltip>
                </div>
              </div>
              );
            })}
            {sorts.length > 1 && (
              <p className="text-2xs text-muted">
                Sorted by the first key, then the next ones break ties.
              </p>
            )}
          </div>
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Group */}
      {show("group") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn((groupBy || laneBy) && "bg-surface-2 text-fg")}
            leftIcon={<Layers className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "dbGroup")}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent title={t(locale, "dbGroup")} className="w-64">
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-muted">Group by</p>
              <Select
                size="sm"
                allowClear={false}
                placeholder={t(locale, "colorNone")}
                value={groupBy}
                options={[{ value: "", label: t(locale, "colorNone") }, ...propertyOptions(groupable)]}
                aria-label={t(locale, "groupByLabel")}
                onChange={(value) => onChange({ groupByPropertyId: value || null })}
              />
              <p className="mt-2 text-xs text-muted">
                Grouping stacks rows by a select/status property (used by Board).
              </p>
            </div>
            <div className="border-t border-border pt-2">
              <p className="mb-1 text-xs text-muted">Group by (lanes)</p>
              <div data-testid="lane-by">
                <Select
                  size="sm"
                  allowClear={false}
                  placeholder={t(locale, "colorNone")}
                  value={laneBy}
                  options={[{ value: "", label: t(locale, "colorNone") }, ...propertyOptions(groupable)]}
                  aria-label={t(locale, "groupByLanesLabel")}
                  onChange={(value) => onChange({ laneBy: value || undefined })}
                />
              </div>
              <p className="mt-2 text-xs text-muted">
                A second grouping slices the board into horizontal lanes
                (swimlanes).
              </p>
            </div>
            {/* Group aggregation (R89.4): the summary each group shows, in the
                same aggregation vocabulary as the chart/footer. Owned here and
                persisted as `groupAggregation`. */}
            {groupBy && (
              <div className="border-t border-border pt-2">
                <p className="mb-1 text-xs text-muted">Summarize groups</p>
                <div data-testid="group-aggregation">
                  <Select
                    size="sm"
                    allowClear={false}
                    placeholder={t(locale, "colorNone")}
                    value={groupAggregation}
                    options={[
                      { value: "", label: t(locale, "colorNone") },
                      ...AGGREGATION_FUNCTIONS.map((fn) => ({
                        value: fn.id,
                        label: fn.label,
                      })),
                    ]}
                    aria-label={t(locale, "summarizeGroupsAria")}
                    onChange={(value) =>
                      onChange({ groupAggregation: value || undefined })
                    }
                  />
                </div>
                <p className="mt-2 text-xs text-muted">
                  The summary each group shows. “None” leaves the group a plain
                  count.
                </p>
              </div>
            )}
            {/* Group ordering (R89.3): reorder the buckets, persisted as the
                view's `groupOrder` (option ids); "No value" always stays last. */}
            {groupBy && orderableGroups.length > 0 && (
              <div className="border-t border-border pt-2">
                <p className="mb-1 text-xs text-muted">Order groups</p>
                <ul className="space-y-1">
                  {orderableGroups.map((group, index) => (
                    <li key={group.key} className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {group.label}
                      </span>
                      <Tooltip label={`Move ${group.label} up`}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Move ${group.label} up`}
                          data-testid={`group-order-up-${group.key}`}
                          disabled={index === 0}
                          onClick={() => moveGroupOrder(index, -1)}
                        >
                          <span aria-hidden>↑</span>
                        </Button>
                      </Tooltip>
                      <Tooltip label={`Move ${group.label} down`}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Move ${group.label} down`}
                          data-testid={`group-order-down-${group.key}`}
                          disabled={index === orderableGroups.length - 1}
                          onClick={() => moveGroupOrder(index, 1)}
                        >
                          <span aria-hidden>↓</span>
                        </Button>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* WIP limits — one per board column, persisted in the view config */}
      {show("wip") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="wip-trigger"
            className={cn(
              limitedCount > 0 && "bg-surface-2 text-fg",
              wipRollup.overCount > 0 && "text-danger",
            )}
            leftIcon={<Gauge className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "wipLimits")}{limitedCount > 0 ? ` (${limitedCount})` : ""}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "wipLimits")}
          className="w-72"
          data-testid="wip-popover"
        >
          {wipProperty ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Work-in-progress limits for “{wipProperty.name}”. Set 0 for no
                limit.
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
                    <span className="block w-24" data-testid={`wip-limit-${group.key}`}>
                      <Stepper
                        value={limit ?? 0}
                        min={0}
                        step={1}
                        aria-label={`${group.label} WIP limit`}
                        onValueChange={(next) =>
                          setWipLimit(group.key, next === 0 ? "" : String(next))
                        }
                      />
                    </span>
                    {status?.status === "over" && (
                      <span
                        data-testid={`wip-status-${group.key}`}
                        className="shrink-0 text-xs text-danger"
                      >
                        over
                      </span>
                    )}
                    {status?.status === "at" && (
                      <span
                        data-testid={`wip-status-${group.key}`}
                        className="shrink-0 text-xs text-warning"
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
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Groups — show/hide board columns, persisted per view as `visibleGroups` */}
      {show("groups") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="groups-trigger"
            className={cn(hiddenGroupCount > 0 && "bg-surface-2 text-fg")}
            leftIcon={<Eye className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "groupsWord")}{hiddenGroupCount > 0 ? ` (${hiddenGroupCount})` : ""}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "groupsWord")}
          className="w-64"
          data-testid="db-groups-popover"
          footer={
            hiddenGroupCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="groups-show-all"
                leftIcon={<RotateCcw className="h-3 w-3" aria-hidden />}
                onClick={() => onChange({ visibleGroups: {} })}
              >
                Show all groups
              </Button>
            ) : undefined
          }
        >
          {wipProperty ? (
            <div className="space-y-1">
              <p className="mb-2 text-xs text-muted">
                Show or hide the columns of “{wipProperty.name}”.
              </p>
              <ul className="space-y-1">
                {groupColumns.map((group) => (
                  <li key={group.key}>
                    <div
                      className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-2"
                      data-testid={`group-visibility-${group.key}`}
                    >
                      <Checkbox
                        size="sm"
                        checked={groupVisibility[group.key] !== false}
                        aria-label={`${group.label} visible`}
                        onCheckedChange={(checked) =>
                          setGroupVisible(group.key, checked)
                        }
                      />
                      <span className="flex-1 truncate">{group.label}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {group.rows.length}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted">
              Group by a select or status property to hide or show groups.
            </p>
          )}
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Summarize by — the metric each board column aggregates (Sum / Average
          / Count), persisted as the view's `aggregationPropertyId` for the
          per-column summary in `BoardView` (feat/q03). */}
      {show("summarize") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="aggregation-trigger"
            className={cn(aggregationPropertyId && "bg-surface-2 text-fg")}
            leftIcon={<Sigma className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "summarizeWord")}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "summarizeWord")}
          className="w-64"
          data-testid="db-aggregation-popover"
        >
          <p className="mb-1 text-xs text-muted">Summarize by property</p>
          <div data-testid="aggregation-property">
            <Select
              size="sm"
              allowClear={false}
              placeholder={t(locale, "autoFirstNumber")}
              value={aggregationPropertyId}
              options={[
                { value: "", label: t(locale, "autoFirstNumber") },
                ...propertyOptions(numericProperties),
              ]}
              aria-label={t(locale, "summarizeByProperty")}
              onChange={(value) =>
                onChange({ aggregationPropertyId: value || undefined })
              }
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            The value each board column sums, averages or counts.
          </p>
          {numericProperties.length === 0 && (
            <p className="mt-2 text-xs text-muted">
              Add a number property to summarize by one.
            </p>
          )}
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Calculations — one footer function per visible column, persisted as
          the view's `footer` in the `{ propertyId, fn }[]` shape
          `@/lib/footer-calculations` parses (TableView renders each value). */}
      {show("calculations") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="footer-trigger"
            className={cn(footerSpec.length > 0 && "bg-surface-2 text-fg")}
            leftIcon={<Calculator className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "calculationsWord")}{footerSpec.length > 0 ? ` (${footerSpec.length})` : ""}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "calculationsWord")}
          className="w-72"
          data-testid="db-footer-popover"
        >
          <p className="mb-2 text-xs text-muted">
            Show a calculation under a column. “None” removes it.
          </p>
          {footerColumns.length === 0 ? (
            <p className="text-xs text-muted">No visible columns.</p>
          ) : (
            <ul className="space-y-1">
              {footerColumns.map((property) => (
                <li key={property.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {property.name}
                  </span>
                  <span className="w-32" data-testid={`footer-fn-${property.id}`}>
                    <Select
                      size="sm"
                      allowClear={false}
                      placeholder={t(locale, "colorNone")}
                      value={footerFnById.get(property.id) ?? ""}
                      options={[
                        { value: "", label: t(locale, "colorNone") },
                        ...footerFunctionsForType(property.type).map((fn) => ({
                          value: fn,
                          label: fn,
                        })),
                      ]}
                      aria-label={`${property.name} footer calculation`}
                      onChange={(value) => setColumnFooter(property, value)}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Templates — the database default (a single slot) and the authored
          order. Only rendered when the caller supplies the template list and
          the database page the two template actions operate on. */}
      {show("templates") && databasePageId && orderedTemplates.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="templates-trigger"
              className={cn(defaultTemplateId && "bg-surface-2 text-fg")}
              leftIcon={<LayoutTemplate className="h-3.5 w-3.5" aria-hidden />}
            >
              {t(locale, "templates")}{defaultTemplateId ? " (1)" : ""}
            </Button>
          </PopoverTrigger>
          <SettingsPopoverContent
            title={t(locale, "templates")}
            className="w-72"
            data-testid="db-templates-popover"
          >
            <p className="mb-2 text-xs text-muted">
              Set the default template and reorder the list.
            </p>
            <ul className="space-y-1">
              {orderedTemplates.map((template, index) => (
                <li key={template.id} className="flex items-center gap-1">
                  <Tooltip
                    label={
                      defaultTemplateId === template.id
                        ? `Clear default template ${template.name}`
                        : `Set default template ${template.name}`
                    }
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={
                        defaultTemplateId === template.id
                          ? `Clear default template ${template.name}`
                          : `Set default template ${template.name}`
                      }
                      data-testid={`template-default-${template.id}`}
                      onClick={() => toggleDefaultTemplate(template)}
                    >
                      <Star
                        aria-hidden
                        className={cn(
                          "h-3.5 w-3.5",
                          defaultTemplateId === template.id
                            ? "fill-warning text-warning"
                            : "text-muted",
                        )}
                      />
                    </Button>
                  </Tooltip>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span aria-hidden>{template.icon ?? "📄"}</span> {template.name}
                  </span>
                  <Tooltip label={`Move template ${template.name} up`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move template ${template.name} up`}
                      data-testid={`template-up-${template.id}`}
                      disabled={index === 0}
                      onClick={() => moveDefaultTemplate(index, -1)}
                    >
                      <span aria-hidden>↑</span>
                    </Button>
                  </Tooltip>
                  <Tooltip label={`Move template ${template.name} down`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move template ${template.name} down`}
                      data-testid={`template-down-${template.id}`}
                      disabled={index === orderedTemplates.length - 1}
                      onClick={() => moveDefaultTemplate(index, 1)}
                    >
                      <span aria-hidden>↓</span>
                    </Button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </SettingsPopoverContent>
        </Popover>
      )}

      {/* Show / hide properties (per view) */}
      {show("properties") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="properties-trigger"
            className={cn(hiddenCount > 0 && "bg-surface-2 text-fg")}
            leftIcon={<Columns3 className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "dbProperties")}
            {hiddenCount > 0 ? ` (${hiddenCount})` : ""}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "dbProperties")}
          description={t(locale, "dbPropertiesHint")}
          className="w-64"
          data-testid="db-properties-popover"
          footer={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="columns-auto-fit"
                leftIcon={<Maximize2 className="h-3 w-3" aria-hidden />}
                onClick={autoFitWidthsForView}
              >
                Auto-fit widths
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="columns-reset-widths"
                leftIcon={<RotateCcw className="h-3 w-3" aria-hidden />}
                onClick={resetWidths}
              >
                Reset widths
              </Button>
            </div>
          }
        >
          <ul className="space-y-1">
            {properties.map((property) => {
              const isPrimary = Boolean(property.config?.primary);
              const shown = isPrimary || visibleSet.has(property.id);
              return (
                <li key={property.id} className="flex items-center gap-1">
                  <div
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-2",
                      isPrimary && "opacity-60",
                    )}
                  >
                    <Checkbox
                      size="sm"
                      checked={shown}
                      disabled={isPrimary}
                      aria-label={`${t(locale, "dbProperties")}: ${property.name}`}
                      onCheckedChange={() => toggleProperty(property.id)}
                    />
                    <span className="truncate">{property.name}</span>
                  </div>
                  <span
                    className="block w-20 shrink-0"
                    data-testid={`column-width-${property.id}`}
                  >
                    <Stepper
                      value={
                        mergedLayout.widths[property.id] ?? DEFAULT_COLUMN_WIDTH
                      }
                      min={DEFAULT_MIN_WIDTH}
                      max={DEFAULT_MAX_WIDTH}
                      step={10}
                      disabled={!shown}
                      aria-label={`${property.name} width`}
                      onValueChange={(next) => setWidth(property.id, String(next))}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 border-t border-border pt-2" data-testid="freeze-first-column">
            <Switch
              size="sm"
              checked={config.freezeFirstColumn !== false}
              label={t(locale, "dbFreezeFirst")}
              aria-label={t(locale, "dbFreezeFirst")}
              onCheckedChange={() =>
                onChange({ freezeFirstColumn: config.freezeFirstColumn === false })
              }
            />
          </div>
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Two-column page property layout — persisted as `config.propertyLayout`
          and resolved through the property-layout-engine. The resolved grid
          placements and the narrow-viewport collapse are summarised here; the
          page property panel renders them outside this file. */}
      {show("layout") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="layout-trigger"
            className={cn(propertyLayout.columns === 2 && "bg-surface-2 text-fg")}
            leftIcon={<LayoutTemplate className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "layoutWord")}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "layoutWord")}
          className="w-72"
          data-testid="db-layout-popover"
        >
          <div className="space-y-2">
            <div data-testid="layout-two-columns">
              <Switch
                size="sm"
                checked={propertyLayout.columns === 2}
                label={t(locale, "twoColumnsLabel")}
                aria-label={t(locale, "twoColumnLayoutAria")}
                onCheckedChange={togglePropertyLayoutColumns}
              />
            </div>
            <div data-testid="layout-dividers">
              <Switch
                size="sm"
                checked={propertyLayout.dividers === true}
                label={t(locale, "columnDividerAria")}
                aria-label={t(locale, "columnDividerAria")}
                onCheckedChange={togglePropertyLayoutDividers}
              />
            </div>
            <ul className="space-y-1 border-t border-border pt-2">
              {propertyLayout.order.map((id, index) => {
                const fullWidth = propertyLayout.spans?.[id] === 2;
                const name = properties.find((p) => p.id === id)?.name ?? id;
                return (
                  <li key={id} className="flex items-center gap-1 text-sm">
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <div
                      className="flex items-center gap-1 text-xs text-muted"
                      data-testid={`layout-span-${id}`}
                    >
                      <Checkbox
                        size="sm"
                        checked={fullWidth}
                        disabled={propertyLayout.columns === 1}
                        aria-label={`${name} full width`}
                        onCheckedChange={() => togglePropertyLayoutSpan(id)}
                      />
                      full
                    </div>
                    <Tooltip label={`Move ${name} up`}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Move ${name} up`}
                        data-testid={`layout-up-${id}`}
                        disabled={index === 0}
                        onClick={() => movePropertyLayout(id, -1)}
                      >
                        <span aria-hidden>↑</span>
                      </Button>
                    </Tooltip>
                    <Tooltip label={`Move ${name} down`}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Move ${name} down`}
                        data-testid={`layout-down-${id}`}
                        disabled={index === propertyLayout.order.length - 1}
                        onClick={() => movePropertyLayout(id, 1)}
                      >
                        <span aria-hidden>↓</span>
                      </Button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
            <p className="border-t border-border pt-2 text-xs text-muted" data-testid="layout-summary">
              {propertyLayoutSummary}
            </p>
            <p className="text-xs text-muted" data-testid="layout-placement">
              {layoutPlacements.length} properties · {fullWidthPlacements} full-width
              {narrowLayoutPlan.collapsed ? " · collapses on narrow screens" : ""}
            </p>
            {layoutIssues.issues.length > 0 && (
              <p className="text-xs text-warning" data-testid="layout-issues">
                {layoutIssues.issues.length} layout warning
                {layoutIssues.issues.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Bounded list loading: rows per page, consumed by `paginateRows`
          (`@/lib/pagination-window`) so a large view loads a window at a time. */}
      {show("rows") && (
        <span className="flex items-center gap-1 text-xs text-muted">
          Rows
          <span className="w-20" data-testid="page-size">
            <Select
              size="sm"
              allowClear={false}
              aria-label={t(locale, "rowsPerPage")}
              value={pageSize === 0 ? "0" : String(pageSize)}
              options={[
                { value: "0", label: "All" },
                { value: "25", label: "25" },
                { value: "50", label: "50" },
                { value: "100", label: "100" },
              ]}
              onChange={(value) => setPageSize(value)}
            />
          </span>
          <span className="w-20" data-testid="row-height">
            <Select
              size="sm"
              allowClear={false}
              aria-label={t(locale, "rowsUnit")}
              value={config.rowHeight ?? "medium"}
              options={[
                { value: "short", label: "Short" },
                { value: "medium", label: "Medium" },
                { value: "tall", label: "Tall" },
              ]}
              onChange={(value) => onChange({ rowHeight: value })}
            />
          </span>
        </span>
      )}

      {/* Saved views — named filter/sort/group presets for this database.
          In-session only: each preset overlays the current config through
          `applySavedView`, and the config can be captured under a name. */}
      {show("saved") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="saved-views-trigger"
            className={cn(savedViews.length > 0 && "bg-surface-2 text-fg")}
            leftIcon={<Bookmark className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "savedViews")}
            {savedViews.length > 0 ? ` (${savedViews.length})` : ""}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "savedViews")}
          className="w-72"
          data-testid="saved-views-popover"
          footer={
            <div className="flex items-center gap-1">
              <Input
                value={savedViewName}
                data-testid="saved-view-name"
                aria-label={t(locale, "savedViews")}
                placeholder={t(locale, "nameThisView")}
                onChange={(event) => setSavedViewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") savePreset();
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="save-saved-view"
                disabled={savedViewName.trim().length === 0}
                leftIcon={<Plus className="h-3 w-3" aria-hidden />}
                onClick={savePreset}
              >
                {t(locale, "save")}
              </Button>
            </div>
          }
        >
          <div className="space-y-2">
            {savedViews.length === 0 && (
              <p className="text-xs text-muted">No saved views yet.</p>
            )}
            {savedViews.map((view) => (
              <div key={view.id} className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid={`apply-saved-view-${view.id}`}
                  onClick={() => applyPreset(view)}
                  className="min-w-0 flex-1 justify-start"
                >
                  <span className="truncate">{view.name}</span>
                </Button>
                <Tooltip label={`${t(locale, "delete")} ${view.name}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${t(locale, "delete")} ${view.name}`}
                    onClick={() => removeSavedView(view)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </Tooltip>
              </div>
            ))}
          </div>
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Chart — shape + aggregation, persisted as `chartType`/`chartAggregate`
          for `ChartView`. */}
      {show("chart") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="chart-trigger"
            className={cn((config.chartType || config.chartAggregate) && "bg-surface-2 text-fg")}
            leftIcon={<BarChart3 className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "chartWord")}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "chartWord")}
          className="w-64"
          data-testid="db-chart-popover"
        >
          <p className="mb-1 text-xs text-muted">Chart type</p>
          <div data-testid="chart-type">
            <Select
              size="sm"
              allowClear={false}
              value={chartType}
              options={CHART_TYPE_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              aria-label={t(locale, "chartType")}
              onChange={(value) => onChange({ chartType: value as ChartType })}
            />
          </div>
          <p className="mt-3 mb-1 text-xs text-muted">Aggregate</p>
          <div data-testid="chart-aggregate">
            <Select
              size="sm"
              allowClear={false}
              value={chartAggregate}
              options={AGGREGATION_FUNCTIONS.map((fn) => ({
                value: fn.id,
                label: fn.label,
              }))}
              aria-label={t(locale, "chartAggregate")}
              onChange={(value) =>
                onChange({ chartAggregate: value as AggregationFn })
              }
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            The shape and totals the Chart view draws per group.
          </p>
        </SettingsPopoverContent>
      </Popover>
      )}

      {/* Gallery — the preview property cards show, persisted as
          `previewPropertyId` for `resolveCardPreview`. */}
      {show("gallery") && (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="gallery-trigger"
            className={cn(previewPropertyId && "bg-surface-2 text-fg")}
            leftIcon={<ImageIcon className="h-3.5 w-3.5" aria-hidden />}
          >
            {t(locale, "galleryWord")}
          </Button>
        </PopoverTrigger>
        <SettingsPopoverContent
          title={t(locale, "galleryWord")}
          className="w-64"
          data-testid="db-gallery-popover"
        >
          <p className="mb-1 text-xs text-muted">Preview property</p>
          <div data-testid="gallery-preview-property">
            <Select
              size="sm"
              allowClear={false}
              placeholder={t(locale, "autoFirstImage")}
              value={previewPropertyId}
              options={[
                { value: "", label: t(locale, "autoFirstImage") },
                ...propertyOptions(previewable),
              ]}
              aria-label={t(locale, "galleryPreview")}
              onChange={(value) => onChange({ previewPropertyId: value || null })}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            The image a card shows; falls back to the page icon.
          </p>
        </SettingsPopoverContent>
      </Popover>
      )}

      {configIssues.length > 0 && (
        <span
          data-testid="view-config-issues"
          title={configIssues.map((issue) => issue.message).join("\n")}
          className="rounded px-1.5 py-0.5 text-xs text-warning"
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

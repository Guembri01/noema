"use client";

/**
 * Model and filter-builder UI for the database view settings.
 *
 * Extracted from ./view-settings; the public import path stays stable through
 * that module's re-export. Pure config transforms, color-rule mapping and the
 * nested filter builder live here; ViewSettings owns the toolbar composition.
 */
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
export function propertyOptions(properties: readonly DBProperty[]): SelectOption[] {
  return properties.map((property) => ({ value: property.id, label: property.name }));
}

/** Operator choices for a property type, as `Select` rows. */
export function operatorOptions(type: string | undefined): SelectOption[] {
  return operatorsFor(type ?? "TEXT").map((op) => ({ value: op.value, label: op.label }));
}

/**
 * The shared popover chrome: `.surface-raised` + `animate-rise` + `Z.popover`
 * come from `PopoverContent`; the sticky header, `.scrollbar-thin` body and
 * sticky footer are added here so every settings popover scrolls the same way.
 */
export function SettingsPopoverContent({
  title,
  description,
  footer,
  className,
  children,
  "data-testid": testId,
}: {
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <PopoverContent
      data-testid={testId}
      className={cn(
        // Every settings popover is width-matched to its content; the viewport
        // cap keeps the 24rem Builder panel from spilling off a 320px phone.
        "flex max-h-[70vh] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0",
        className,
      )}
    >
      <div className="sticky top-0 z-10 shrink-0 border-b border-border bg-surface-2/95 px-3 py-2 backdrop-blur">
        <p className="text-xs font-medium text-fg">{title}</p>
        {description ? (
          <p className="mt-0.5 text-2xs text-muted">{description}</p>
        ) : null}
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3 text-sm">
        {children}
      </div>
      {footer ? (
        <div className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-surface-2/95 px-3 py-2 backdrop-blur">
          {footer}
        </div>
      ) : null}
    </PopoverContent>
  );
}

/**
 * A hue picker rendered as a row of `Tag` chips. Selecting a chip persists the
 * same colour id a `<select>` used to, so the stored rule shape is unchanged.
 */
export function ColorChips({
  value,
  label,
  onSelect,
}: {
  value: string;
  label: string;
  onSelect: (color: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {COLOR_TOKENS.map((color) => (
        <Tag
          key={color}
          hue={color}
          size="sm"
          dot
          selected={value === color}
          aria-label={`${label}: ${color}`}
          onSelectedChange={() => onSelect(color)}
        >
          {color}
        </Tag>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Nested filter groups (AND/OR to any depth)
   The nested counterpart to the flat filter rows: a `FilterGroup` tree from
   `@/lib/filter-tree`. It is persisted as the view's `filterTree` (the very
   shape `applyFilterTree` evaluates), so both engines agree. While a tree is
   present the flat `filters` are ignored, which the UI says out loud.
   --------------------------------------------------------------------------- */

let newLeafSeq = 0;
/** A fresh leaf with a stable-until-persisted id for `replaceFilter`/`removeFilterById`. */
export function newLeaf(filter: Filter): FilterTreeLeaf {
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
export function treeFromConfig(config: ViewConfig): FilterGroup | null {
  const nodes = config.filterTree;
  if (!nodes || nodes.length === 0) return null;
  return {
    conjunction: config.filterMode === "or" ? "OR" : "AND",
    children: nodes.map((node, index) => fromFilterNode(node, [index])),
  };
}

export function fromFilterNode(node: FilterNode, path: number[]): FilterTreeNode {
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
export function toFilterNodes(tree: FilterGroup): FilterNode[] {
  return tree.children.map(toFilterNode);
}

export function toFilterNode(node: FilterTreeNode): FilterNode {
  if (isFilterGroup(node)) {
    const children = node.children.map(toFilterNode);
    return node.conjunction === "AND" ? { and: children } : { or: children };
  }
  const filter: Filter = { propertyId: node.propertyId, operator: node.operator };
  if (node.value !== undefined) filter.value = node.value;
  return filter;
}

/** Immutable edit of the node at `path` (index path from the root). */
export function updateAtPath(
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
export function removeNodeAtPath(root: FilterGroup, path: number[]): FilterGroup {
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
export function FilterLeafRow({
  locale,
  leaf,
  properties,
  onSetField,
  onRemove,
}: {
  locale: string;
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
    <div className="space-y-1 rounded-control border border-border p-2">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1">
          <Select
            size="sm"
            allowClear={false}
            options={propertyOptions(properties)}
            value={leaf.propertyId}
            aria-label={t(locale, "filterGroupPropertyAria")}
            onChange={(value) => onSetField(leaf, { propertyId: value })}
          />
        </span>
        <Tooltip label={t(locale, "removeCondition")}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(locale, "removeCondition")}
            onClick={() => onRemove(leaf)}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </Tooltip>
      </div>
      <Select
        size="sm"
        allowClear={false}
        options={operatorOptions(property?.type)}
        value={leaf.operator}
        aria-label={t(locale, "filterGroupOperatorAria")}
        onChange={(value) => onSetField(leaf, { operator: value as Filter["operator"] })}
      />
      {!noValue && (
        <Input
          value={leaf.value ?? ""}
          aria-label={t(locale, "filterGroupValueAria")}
          onChange={(e) => onSetField(leaf, { value: e.target.value })}
          placeholder={t(locale, "valuePlaceholder")}
        />
      )}
    </div>
  );
}

/** A group of conditions/subgroups combined with one AND/OR conjunction. */
export function FilterGroupRows({
  locale,
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
  locale: string;
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
        "space-y-2 rounded-control border border-border p-2",
        depth > 0 && "bg-surface-2/40",
      )}
    >
      <div className="flex items-center gap-1">
        <span className="w-24">
          <Select
            size="sm"
            allowClear={false}
            options={[
              { value: "and", label: "all" },
              { value: "or", label: "any" },
            ]}
            value={node.conjunction === "OR" ? "or" : "and"}
            aria-label={t(locale, "filterGroupMatchAria")}
            onChange={(value) =>
              onSetConjunction(path, value === "or" ? "OR" : "AND")
            }
          />
        </span>
        <span className="text-xs text-muted">of these</span>
        <div className="ms-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            leftIcon={<Plus className="h-3 w-3" aria-hidden />}
            onClick={() => onAddCondition(path)}
          >
            Condition
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            leftIcon={<Plus className="h-3 w-3" aria-hidden />}
            onClick={() => onAddGroup(path)}
          >
            Group
          </Button>
          {depth > 0 && (
            <Tooltip label={t(locale, "removeGroup")}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t(locale, "removeGroup")}
                onClick={() => onRemoveGroup(path)}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </Tooltip>
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
            locale={locale}
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
            locale={locale}
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
   AND/OR builder tree (filter-tree-ui)
   The richer sibling of the flat/nested `@/lib/filter-tree` editor above: this
   panel edits a `FilterGroup` from `@/lib/filter-tree-ui`, which addresses
   nodes by index path, supports moving a node between groups, normalises
   redundant structure, validates against the property schema and renders a
   sentence. It persists as `config.filterBuilder`; `applyView` (database-query)
   lowers the saved tree through `toQueryExpr`, so the tree genuinely filters.
   --------------------------------------------------------------------------- */

/** Operators that take no target value (the input is hidden for these). */
export const BUILDER_VALUELESS_OPERATORS = ["is_empty", "is_not_empty", "checked", "unchecked"];

/** Every group in the tree as a move destination, labelled by discovery order. */
export function collectBuilderGroupOptions(
  tree: BuilderGroup,
): { id: string; label: string }[] {
  const options: { id: string; label: string }[] = [];
  const walk = (node: BuilderNode): void => {
    if (!isBuilderGroup(node)) return;
    options.push({
      id: node.id,
      label: `Group ${options.length + 1} (${node.op === "or" ? "ANY" : "ALL"})`,
    });
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return options;
}

/** Change a group's conjunction in place (immutably); path `[]` is the root. */
export function setBuilderGroupOp(
  tree: BuilderGroup,
  path: number[],
  op: "and" | "or",
): BuilderGroup {
  if (path.length === 0) return { ...tree, op };
  const [head, ...rest] = path;
  return {
    ...tree,
    children: tree.children.map((child, index) =>
      index === head && isBuilderGroup(child)
        ? setBuilderGroupOp(child, rest, op)
        : child,
    ),
  };
}

/** One condition (leaf) row inside the builder tree. */
export function BuilderLeafRow({
  locale,
  leaf,
  path,
  properties,
  groupOptions,
  onSetField,
  onRemove,
  onMove,
}: {
  locale: string;
  leaf: BuilderLeaf;
  path: number[];
  properties: DBProperty[];
  groupOptions: { id: string; label: string }[];
  onSetField: (path: number[], patch: BuilderLeafPatch) => void;
  onRemove: (path: number[]) => void;
  onMove: (path: number[], destinationId: string) => void;
}) {
  const property = properties.find((p) => p.id === leaf.propertyId);
  const noValue = BUILDER_VALUELESS_OPERATORS.includes(leaf.op);
  return (
    <div className="space-y-1 rounded-control border border-border p-2">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1" data-testid="builder-property">
          <Select
            size="sm"
            allowClear={false}
            options={propertyOptions(properties)}
            value={leaf.propertyId}
            aria-label={t(locale, "builderPropertyAria")}
            onChange={(value) => {
              const next = properties.find((p) => p.id === value);
              const ops = operatorsFor(next?.type ?? "TEXT");
              const op = ops.some((spec) => spec.value === leaf.op)
                ? leaf.op
                : ops[0].value;
              onSetField(path, { propertyId: value, op });
            }}
          />
        </span>
        {groupOptions.length > 1 && (
          <span className="w-24" data-testid="builder-move">
            <Select
              size="sm"
              allowClear={false}
              placeholder={t(locale, "movePlaceholder")}
              options={groupOptions.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              value=""
              aria-label={t(locale, "moveConditionIntoGroup")}
              onChange={(value) => {
                if (value) onMove(path, value);
              }}
            />
          </span>
        )}
        <Tooltip label={t(locale, "removeCondition")}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(locale, "removeCondition")}
            onClick={() => onRemove(path)}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </Tooltip>
      </div>
      <div data-testid="builder-operator">
        <Select
          size="sm"
          allowClear={false}
          options={operatorOptions(property?.type)}
          value={leaf.op}
          aria-label={t(locale, "builderOperatorAria")}
          onChange={(value) =>
            onSetField(path, { op: value as Filter["operator"] })
          }
        />
      </div>
      {!noValue && (
        <Input
          value={leaf.value ?? ""}
          aria-label={t(locale, "builderValueAria")}
          data-testid="builder-value"
          onChange={(event) => onSetField(path, { value: event.target.value })}
          placeholder={t(locale, "valuePlaceholder")}
        />
      )}
    </div>
  );
}

/** A group of conditions/subgroups combined with one AND/OR conjunction. */
export function BuilderGroupRows({
  locale,
  node,
  path,
  depth,
  properties,
  groupOptions,
  onAddCondition,
  onAddGroup,
  onRemove,
  onSetOp,
  onSetLeafField,
  onMove,
}: {
  locale: string;
  node: BuilderGroup;
  path: number[];
  depth: number;
  properties: DBProperty[];
  groupOptions: { id: string; label: string }[];
  onAddCondition: (path: number[]) => void;
  onAddGroup: (path: number[]) => void;
  onRemove: (path: number[]) => void;
  onSetOp: (path: number[], op: "and" | "or") => void;
  onSetLeafField: (path: number[], patch: BuilderLeafPatch) => void;
  onMove: (path: number[], destinationId: string) => void;
}) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-control border border-border p-2",
        depth > 0 && "bg-surface-2/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-24" data-testid={depth === 0 ? "builder-root-op" : undefined}>
          <Select
            size="sm"
            allowClear={false}
            options={[
              { value: "and", label: "all" },
              { value: "or", label: "any" },
            ]}
            value={node.op}
            aria-label={t(locale, "builderGroupMatchAria")}
            onChange={(value) => onSetOp(path, value === "or" ? "or" : "and")}
          />
        </span>
        <span className="text-xs text-muted">of these</span>
        <div className="ms-auto flex items-center gap-1">
          {depth > 0 && groupOptions.length > 1 && (
            <span className="w-24" data-testid="builder-group-move">
              <Select
                size="sm"
                allowClear={false}
                placeholder={t(locale, "movePlaceholder")}
                options={groupOptions
                  .filter((option) => option.id !== node.id)
                  .map((option) => ({ value: option.id, label: option.label }))}
                value=""
                aria-label={t(locale, "moveGroupIntoGroup")}
                onChange={(value) => {
                  if (value) onMove(path, value);
                }}
              />
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            leftIcon={<Plus className="h-3 w-3" aria-hidden />}
            onClick={() => onAddCondition(path)}
          >
            Condition
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            leftIcon={<Plus className="h-3 w-3" aria-hidden />}
            onClick={() => onAddGroup(path)}
          >
            Group
          </Button>
          {depth > 0 && (
            <Tooltip label={t(locale, "removeGroup")}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t(locale, "removeGroup")}
                onClick={() => onRemove(path)}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {node.children.length === 0 && (
        <p className="text-xs text-muted">Empty group — matches every row.</p>
      )}
      {node.children.map((child, index) =>
        isBuilderGroup(child) ? (
          <BuilderGroupRows
            key={child.id}
            locale={locale}
            node={child}
            path={[...path, index]}
            depth={depth + 1}
            properties={properties}
            groupOptions={groupOptions}
            onAddCondition={onAddCondition}
            onAddGroup={onAddGroup}
            onRemove={onRemove}
            onSetOp={onSetOp}
            onSetLeafField={onSetLeafField}
            onMove={onMove}
          />
        ) : (
          <BuilderLeafRow
            key={child.id}
            locale={locale}
            leaf={child}
            path={[...path, index]}
            properties={properties}
            groupOptions={groupOptions}
            onSetField={onSetLeafField}
            onRemove={onRemove}
            onMove={onMove}
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
export function presetSecondaryIds(properties: DBProperty[]): string[] {
  return properties
    .filter((property) => !property.config?.primary)
    .map((property) => property.id);
}

/** The current `ViewConfig` as the loose base a preset is applied over. */
export function presetViewConfig(config: ViewConfig, secondary: string[]): ViewConfigLike {
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
export function presetFromConfig(
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
export function configPatchForPreset(
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
export type ViewSettingsConfig = ViewConfig & {
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
  /**
   * GROUPS: the per-view ordering of the group buckets, given as option ids
   * (docs/specs/database-deep.md R89.3, "Group ordering"). Like `laneBy`, it is
   * a view-config key this toolbar owns and rides through `sanitizeViewSettings`
   * untouched; it is read back as the `optionOrder` argument of
   * `groupRowsByProperty`, so this editor's order is exactly what the board
   * engine derives. Listed ids come first in the listed order, unlisted
   * declared options keep their declared order, and the trailing "No value"
   * bucket always stays last. An empty list means "use the declared order".
   */
  groupOrder?: string[];
  /**
   * GROUPS: the summary each group shows, in the `AggregationFn` vocabulary of
   * `@/lib/aggregations` (docs/specs/database-deep.md R89.4, "Group
   * aggregation"). Owned here like `chartAggregate`; the group engine falls
   * back to a plain row count when it is unset, so an empty value mirrors that.
   */
  groupAggregation?: string;
  /**
   * TABLE: whether every column header offers a quick filter into this panel
   * (docs/specs/database-deep.md R89.6, "Quick filter from header"). Unset means
   * enabled, so existing views keep the entry point.
   */
  quickFilter?: boolean;
  /**
   * Conditional formatting authoring entry: rules are enabled by default, and a
   * view may switch the entry off (docs/specs/database-deep.md R89.5) without
   * discarding the rules it already saved. Unset means enabled.
   */
  conditionalFormat?: boolean;
  /**
   * TABLE: the per-column calculations footer, in exactly the shape
   * `@/lib/footer-calculations` parses — `{ propertyId, fn }[]`, one entry per
   * calculated column. This toolbar owns the key; `TableView` resolves it
   * through `parseFooterSpec`/`resolveFooterCalculations` and renders each
   * value, falling back to the `aggregationPropertyId` column when it is unset.
   */
  footer?: FooterSpec;
  /**
   * CONDITIONAL FORMATTING: the same rules as `colorRules`, projected into the
   * richer vocabulary `@/lib/conditional-format` parses (`FormatRule` — a
   * `condition.op` plus a `style`, with an ascending `priority`). Kept in step
   * with `colorRules` on every edit so the conditional-format engine always has
   * a rule list it understands.
   */
  formatRules?: FormatRule[];
};

/**
 * The template rows the "Templates" popover edits. A structural subset of the
 * server's `Template` record — just the fields the default toggle and the
 * up/down reorder need, so the caller can pass its own template list without
 * this toolbar importing the query layer.
 */
export type ViewTemplateOption = {
  id: string;
  name: string;
  icon?: string | null;
  /** The database's single default template, when one is set. */
  isDefault?: boolean;
};

/** A JSON object (not an array, not null), or `null` for anything else. */
export function wipRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** An app colour rule → the schema's row-colour shape (its condition lives in `filter`). */
export function colorRuleToSchema(rule: ColorRule): Record<string, unknown> {
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
export function toSchemaConfig(config: ViewSettingsConfig): Record<string, unknown> {
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
export function colorRuleFromSchema(rule: ViewColorRule): ColorRule | null {
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
export function normalizeWipLimits(input: unknown): WipLimits | undefined {
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
export function normalizeVisibleGroups(input: unknown): GroupVisibility | undefined {
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
 * Keep only non-empty, de-duplicated strings, preserving order; an empty list
 * normalises away, so "declared order" is the absence of the key rather than
 * `[]` — the same rule the WIP limits and visibility maps use. This is the read
 * guard for `groupOrder` (option ids) before it reaches `groupRowsByProperty`.
 */
export function normalizeStringList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string" || entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    list.push(entry);
  }
  return list.length > 0 ? list : undefined;
}

/**
 * Keep a group-aggregation id only when the aggregation catalogue knows it;
 * anything else normalises away so the engine keeps its plain row-count default
 * rather than receiving an unknown id.
 */
export function normalizeAggregationFn(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  return AGGREGATION_FUNCTIONS.some((fn) => fn.id === input) ? input : undefined;
}

/** Keep a boolean flag only when the view set one; absent leaves the default. */
export function normalizeToggle(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined;
}

/* ---------------------------------------------------------------------------
   Wiring maps for the footer + conditional-format engines
   Both engines own a vocabulary this toolbar does not: `@/lib/footer-calculations`
   parses `{ propertyId, fn }[]` and `@/lib/conditional-format` parses
   `FormatRule`. The helpers below are the pure, node-testable bridges between
   what the editors hold and exactly what those engines read.
   --------------------------------------------------------------------------- */

/**
 * Move the colour rule at `index` by `delta` places, returning a new list. The
 * array order is the precedence the row-colour engine reads (first match wins),
 * so this is what the up/down buttons persist. An out-of-range move returns a
 * copy unchanged.
 */
export function moveColorRule(
  rules: readonly ColorRule[],
  index: number,
  delta: number,
): ColorRule[] {
  const target = index + delta;
  if (index < 0 || index >= rules.length || target < 0 || target >= rules.length) {
    return rules.slice();
  }
  const next = rules.slice();
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return next;
  next.splice(target, 0, moved);
  return next;
}

/**
 * An app colour rule → one rule in the conditional-format engine's vocabulary.
 * `null` when the rule's operator is outside `CONDITION_OPS` (the engine cannot
 * evaluate `before`/`after`/`checked`/`unchecked`), so the caller drops it.
 * `priority` is assigned by the caller from the surviving order.
 */
export function colorRuleToFormatRule(
  rule: ColorRule,
  priority: number,
): FormatRule | null {
  if (!isConditionOp(rule.operator)) return null;
  const format: FormatRule = {
    id: `view-color-${priority}`,
    target: rule.target === "cell" ? "cell" : "row",
    propertyId: rule.propertyId,
    condition: { op: rule.operator },
    style: { background: rule.color },
    priority,
  };
  if (rule.value !== undefined) format.condition.value = rule.value;
  return format;
}

/**
 * The whole colour-rule list projected into `FormatRule[]`, dropping the rules
 * the engine cannot evaluate and re-indexing priorities densely.
 */
export function colorRulesToFormatRules(rules: readonly ColorRule[]): FormatRule[] {
  const formats: FormatRule[] = [];
  for (const rule of rules) {
    const format = colorRuleToFormatRule(rule, formats.length);
    if (format) formats.push(format);
  }
  return formats;
}

/**
 * A conditional-format engine rule → an app colour rule, or `null` when it
 * paints nothing (no safe background, no property). The inverse of
 * `colorRulesToFormatRules` for the operators both vocabularies share.
 */
export function formatRuleToColorRule(rule: FormatRule): ColorRule | null {
  const color = rule.style?.background;
  if (!isSafeColor(color)) return null;
  const propertyId = rule.propertyId;
  if (typeof propertyId !== "string" || propertyId === "") return null;
  const converted: ColorRule = {
    propertyId,
    operator: rule.condition.op,
    color,
  };
  if (rule.condition.value !== undefined) converted.value = rule.condition.value;
  if (rule.target === "cell") converted.target = "cell";
  return converted;
}

/** The whole `FormatRule[]` projected back into the app's `ColorRule[]`. */
export function formatRulesToColorRules(rules: readonly FormatRule[]): ColorRule[] {
  return rules
    .map(formatRuleToColorRule)
    .filter((rule): rule is ColorRule => rule !== null);
}

/**
 * Upsert one column's footer function into a `@/lib/footer-calculations` spec,
 * preserving first-appearance order (a replaced entry keeps its position, a new
 * one appends).
 */
export function setFooterFunction(
  spec: FooterSpec,
  propertyId: string,
  fn: AggregationFn,
): FooterSpec {
  const byProperty = new Map(spec.map((entry) => [entry.propertyId, entry.fn] as const));
  byProperty.set(propertyId, fn);
  return [...byProperty].map(([id, value]) => ({ propertyId: id, fn: value }));
}

/** Drop one column's footer function from a spec (no-op when it is absent). */
export function removeFooterFunction(
  spec: FooterSpec,
  propertyId: string,
): FooterSpec {
  return spec.filter((entry) => entry.propertyId !== propertyId);
}

/**
 * Move the template id at `index` by `delta` places, returning a new list; the
 * order is exactly what `reorderTemplatesAction` persists. An out-of-range move
 * returns a copy unchanged.
 */
export function moveTemplate(
  ids: readonly string[],
  index: number,
  delta: number,
): string[] {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) {
    return ids.slice();
  }
  const next = ids.slice();
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return next;
  next.splice(target, 0, moved);
  return next;
}

/**
 * Read an untrusted config into the shape this toolbar edits: schema-normalised
 * against `properties`, with WIP limits validated. Unknown top-level keys are
 * preserved; only the fields this toolbar owns are rewritten.
 */
export function sanitizeViewSettings(
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

  const groupOrder = normalizeStringList(config.groupOrder);
  if (groupOrder) sanitized.groupOrder = groupOrder;
  else delete sanitized.groupOrder;

  const groupAggregation = normalizeAggregationFn(config.groupAggregation);
  if (groupAggregation) sanitized.groupAggregation = groupAggregation;
  else delete sanitized.groupAggregation;

  const quickFilter = normalizeToggle(config.quickFilter);
  if (quickFilter !== undefined) sanitized.quickFilter = quickFilter;
  else delete sanitized.quickFilter;

  const conditionalFormat = normalizeToggle(config.conditionalFormat);
  if (conditionalFormat !== undefined) sanitized.conditionalFormat = conditionalFormat;
  else delete sanitized.conditionalFormat;

  // Footer spec: read through the engine's parser so a hand-edited or stale
  // entry (unknown fn, missing property id) never reaches the editor or the
  // table. An empty spec normalises away, matching the other optional keys.
  const footer = parseFooterSpec(config.footer);
  if (footer.length > 0) sanitized.footer = footer;
  else delete sanitized.footer;

  // Conditional-format rules: parsed through the engine's own reader so a rule
  // it could not consume is dropped before the editor reads it.
  const formatRules = Array.isArray(config.formatRules)
    ? config.formatRules
        .map(parseFormatRule)
        .filter((rule): rule is FormatRule => rule !== null)
    : [];
  if (formatRules.length > 0) sanitized.formatRules = formatRules;
  else delete sanitized.formatRules;

  return sanitized;
}

/**
 * Nominal table width the "Auto-fit" action shares across the visible columns.
 * The settings popover has no measured pixel width, so `autoFitWidths` spreads
 * this reference width evenly (clamped per column) to reset a table to a tidy,
 * uniform set of columns.
 */

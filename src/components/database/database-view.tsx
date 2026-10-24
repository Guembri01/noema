"use client";

import dynamic from "next/dynamic";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { PromptDialog } from "@/components/prompt-dialog";
import { useAction } from "@/lib/actions-client";
import { useUndoRedo } from "@/components/providers/undo-redo-provider";
import { useRouter } from "next/navigation";
import {
  Ban,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  History,
  Inbox,
  LayoutTemplate,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X } from "lucide-react";
import {
  createPropertyAction as rawCreatePropertyAction,
  createRowAction as rawCreateRowAction,
  createViewAction as rawCreateViewAction,
  deletePropertyAction as rawDeletePropertyAction,
  deleteRowAction as rawDeleteRowAction,
  duplicateDatabaseAction as rawDuplicateDatabaseAction,
  duplicateViewAction as rawDuplicateViewAction,
  importCsvAction as rawImportCsvAction,
  createRowFromTemplateAction as rawCreateRowFromTemplateAction,
  listDeletedRowsAction as rawListDeletedRowsAction,
  loadMoreDatabaseRowsAction as rawLoadMoreDatabaseRowsAction,
  reorderPropertiesAction as rawReorderPropertiesAction,
  saveRowAsTemplateAction as rawSaveRowAsTemplateAction,
  setPropertyValueAction as rawSetPropertyValueAction,
  setRelationTwoWayAction as rawSetRelationTwoWayAction,
  setSubItemParentAction as rawSetSubItemParentAction,
  submitFormAction as rawSubmitFormAction,
  updatePropertyAction as rawUpdatePropertyAction,
  updateViewAction as rawUpdateViewAction } from "@/server/actions/database";
import {
  restorePageAction as rawRestorePageAction,
  toggleSchemaLockAction as rawToggleSchemaLockAction,
  updatePageAction as rawUpdatePageAction } from "@/server/actions/pages";
import { guarded } from "@/lib/actions-client";

// Every action call in this screen goes through the transport guard, so a
// dropped connection becomes a `{ error }` result instead of an unhandled
// rejection. `useAction` (inside the component) adds the toast/refresh wrapper
// for the relation controls; these aliases keep the other call sites safe.
const createPropertyAction = guarded(rawCreatePropertyAction) as typeof rawCreatePropertyAction;
const createRowAction = guarded(rawCreateRowAction) as typeof rawCreateRowAction;
const createViewAction = guarded(rawCreateViewAction) as typeof rawCreateViewAction;
const deletePropertyAction =
  guarded(rawDeletePropertyAction) as typeof rawDeletePropertyAction;
const deleteRowAction = guarded(rawDeleteRowAction) as typeof rawDeleteRowAction;
const duplicateDatabaseAction =
  guarded(rawDuplicateDatabaseAction) as typeof rawDuplicateDatabaseAction;
const duplicateViewAction =
  guarded(rawDuplicateViewAction) as typeof rawDuplicateViewAction;
const importCsvAction = guarded(rawImportCsvAction) as typeof rawImportCsvAction;
const createRowFromTemplateAction =
  guarded(rawCreateRowFromTemplateAction) as typeof rawCreateRowFromTemplateAction;
const listDeletedRowsAction =
  guarded(rawListDeletedRowsAction) as typeof rawListDeletedRowsAction;
const loadMoreDatabaseRowsAction =
  guarded(rawLoadMoreDatabaseRowsAction) as typeof rawLoadMoreDatabaseRowsAction;
const reorderPropertiesAction =
  guarded(rawReorderPropertiesAction) as typeof rawReorderPropertiesAction;
const saveRowAsTemplateAction =
  guarded(rawSaveRowAsTemplateAction) as typeof rawSaveRowAsTemplateAction;
const setPropertyValueAction =
  guarded(rawSetPropertyValueAction) as typeof rawSetPropertyValueAction;
const setRelationTwoWayAction =
  guarded(rawSetRelationTwoWayAction) as typeof rawSetRelationTwoWayAction;
const setSubItemParentAction =
  guarded(rawSetSubItemParentAction) as typeof rawSetSubItemParentAction;
const submitFormAction = guarded(rawSubmitFormAction) as typeof rawSubmitFormAction;
const updatePropertyAction =
  guarded(rawUpdatePropertyAction) as typeof rawUpdatePropertyAction;
const updateViewAction = guarded(rawUpdateViewAction) as typeof rawUpdateViewAction;
const restorePageAction = guarded(rawRestorePageAction) as typeof rawRestorePageAction;
const toggleSchemaLockAction =
  guarded(rawToggleSchemaLockAction) as typeof rawToggleSchemaLockAction;
const updatePageAction = guarded(rawUpdatePageAction) as typeof rawUpdatePageAction;
import { DUR } from "@/lib/design-tokens";
import { toast } from "sonner";
import {
  applyView,
  formatCell,
  parseViewConfig,
  rowColor,
  type QueryProperty,
  type QueryRow,
  type ViewConfig } from "@/lib/database-query";
import { evaluateFormula } from "@/lib/formula";
import { aggregate, type RollupFunction } from "@/lib/rollup";
import { AGGREGATION_FUNCTIONS, type AggregationFn } from "@/lib/aggregations";
import type { ChartType } from "@/lib/charts";
import type { RowColorRule } from "@/lib/row-color-rules";
import { mergeLayout, type ColumnLayout } from "@/lib/column-layout";
import type { DependencyEdge } from "@/lib/dependencies";
import {
  buildSubIssueTree,
  canMoveSubIssue,
  dependencyTree as buildSubIssueDependencyTree,
  describeRollup as describeSubIssueRollup,
  flattenTree as flattenSubIssueTree,
  moveSubIssue,
  rollupEstimates,
  type DependencyEdge as SubIssueDependencyEdge,
  type NodeRollup,
} from "@/lib/sub-issues";
import {
  computeRollup as computeRelationRollup,
  createRelationPair,
  createRelationState,
  setRollupConfig,
  symmetricPairs,
  type RelationState,
  type RollupFn as RelationRollupFn,
} from "@/lib/relation-pairs";
import { normalizeRollupConfig } from "@/lib/rollup-config";
import { normalizeRelationConfig } from "@/lib/relation-config";
import {
  canEditSchema,
  describeLock,
  toggleLock,
  type LockRole,
  type LockState } from "@/lib/database-lock";
import { childrenOf as subItemChildrenOf } from "@/lib/sub-items";
import { CARD_SIZES, type CardSizeName } from "@/lib/view-presets";
import type { RelationData } from "@/server/queries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import {
  type DBProperty,
  type DBRow,
  type DBView } from "@/components/database/database-types";
import {
  DatabaseViewTabs,
  VIEW_TYPES,
  type ViewTypeName,
} from "@/components/database/view-tabs";
import { DatabaseViewToolbar } from "@/components/database/view-toolbar";
import { DatabasePeek } from "@/components/database/database-peek";
import { DatabaseActions } from "@/components/database/database-actions";
import { FormBuilder } from "@/components/database/form-builder";
import { Dialog } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import {
  applyTemplate,
  resolveDefaultTemplate,
  type DatabaseTemplate,
} from "@/lib/database-templates";

export type {
  DBProperty,
  DBRow,
  DBView,
  HeaderConfig,
} from "@/components/database/database-types";
import { stableTime } from "@/lib/time";
import { AddPropertyForm } from "./view-parts";
import {
  TableView,
  ListView,
  BoardView,
  GalleryView,
  resolveTableRowHeight,
  skeletonCount,
  type TableFooterCalculation,
  type TableRowHeight,
  type ViewKind,
} from "./view-renderers";

function ViewFallback() {
  return <Skeleton variant="table" rows={6} cols={4} />;
}

const LazyCalendarView = dynamic(
  () =>
    import("@/components/database/timeline-chart-views").then((mod) => ({
      default: mod.CalendarView,
    })),
  { ssr: false, loading: () => <ViewFallback /> },
);
const LazyTimelineView = dynamic(
  () =>
    import("@/components/database/timeline-chart-views").then((mod) => ({
      default: mod.TimelineView,
    })),
  { ssr: false, loading: () => <ViewFallback /> },
);
const LazyChartView = dynamic(
  () =>
    import("@/components/database/timeline-chart-views").then((mod) => ({
      default: mod.ChartView,
    })),
  { ssr: false, loading: () => <ViewFallback /> },
);
/**
 * The dependency editor is only needed while a row peek is open; keeping it in
 * its own chunk protects the database route's first-load budget.
 */
const LazyRowDependencies = dynamic(
  () =>
    import("@/components/database/row-dependencies").then((mod) => ({
      default: mod.RowDependencies,
    })),
  { ssr: false },
);
const LazyFormView = dynamic(
  () =>
    import("@/components/database/form-view").then((mod) => ({
      default: mod.FormView,
    })),
  { ssr: false, loading: () => <ViewFallback /> },
);
const LazyPropertyOptionsEditor = dynamic(
  () =>
    import("@/components/database/property-options-editor").then((mod) => ({
      default: mod.PropertyOptionsEditor,
    })),
  { ssr: false },
);

export {
  COLOR_CHOICES,
  CONTROL_CLASS,
  OPTION_FOREGROUND,
} from "@/components/database/database-types";

/**
 * A saved row template as the database view receives it. The display fields
 * (name/icon) are always present; the planner inputs (`config.values`,
 * `content`, `isDefault`) are optional so the view typechecks against today's
 * `getDatabase` projection and lights up automatically once it exposes them
 * (docs/specs/database-deep.md R89.16). Everything below is additive.
 */
type ViewTemplate = {
  id: string;
  name: string;
  icon: string | null;
  recurrence?: string | null;
  /** `Template.config`, the saved `{ values }` property defaults. */
  config?: { values?: { propertyId: string; value: unknown }[] } | null;
  /** `Template.content` (a ProseMirror doc once the query exposes it). */
  content?: unknown;
  isDefault?: boolean;
};

/**
 * Project a view template onto `@/lib/database-templates`' input shape. The
 * planner spreads `content` as an array of body blocks, so a non-array value
 * (e.g. the `{ type: "doc", content: [...] }` a row stores) is treated as
 * "no body the planner can represent" rather than spread blindly.
 */
function toEngineTemplate(template: ViewTemplate): DatabaseTemplate {
  return {
    id: template.id,
    name: template.name,
    icon: template.icon,
    isDefault: template.isDefault,
    content: Array.isArray(template.content) ? template.content : null,
    propertyDefaults: Object.fromEntries(
      (template.config?.values ?? []).map((value) => [value.propertyId, value.value]),
    ),
  };
}

/**
 * Keep only the boolean entries of a stored BOARD `visibleGroups` map. Unknown
 * keys and non-boolean values are dropped, so a malformed value leaves every
 * group visible — the same rendering as a view with no visibility map at all.
 */
function normalizeVisibleGroups(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

/**
 * A GALLERY view's forced `cardSize`, or `undefined` when the stored value is
 * absent / not one of the known presets. Returning `undefined` keeps the card
 * size following the measured container, exactly as before.
 */
function normalizeCardSize(value: unknown): CardSizeName | undefined {
  if (typeof value !== "string") return undefined;
  return Object.prototype.hasOwnProperty.call(CARD_SIZES, value)
    ? (value as CardSizeName)
    : undefined;
}

/** The chart shapes `ChartView` renders (mirrors the `ChartType` union). */
const CHART_TYPE_NAMES = ["bar", "line", "pie", "donut"] as const;

/**
 * A view's forced CHART shape, or `undefined` when the stored value is absent /
 * not one of the shapes `@/lib/charts` understands. Returning `undefined` keeps
 * `ChartView`'s own "bar" default, exactly as the view rendered before.
 */
function normalizeChartType(value: unknown): ChartType | undefined {
  return typeof value === "string" &&
    (CHART_TYPE_NAMES as readonly string[]).includes(value)
    ? (value as ChartType)
    : undefined;
}

/**
 * A view's CHART aggregation, or `undefined` when the stored value is not one
 * of the aggregations the chart engine knows. `undefined` keeps `ChartView`'s
 * own row-count default, so an unstyled view is unchanged.
 */
function normalizeChartAggregate(value: unknown): AggregationFn | undefined {
  return typeof value === "string" &&
    AGGREGATION_FUNCTIONS.some((fn) => fn.id === value)
    ? (value as AggregationFn)
    : undefined;
}

/**
 * A TABLE view's persisted footer calculations (`config.footer`), or `undefined`
 * when the stored value is absent, empty or unusable. Only entries that name a
 * property id and a function the aggregator knows survive, so a stale or
 * hand-edited value can never hide the footer's own fallback: with no usable
 * pair `TableView` still summarises the view's `aggregationPropertyId` column —
 * or shows no footer at all — exactly as it rendered before this option existed.
 */
function normalizeFooterCalculations(
  value: unknown,
): TableFooterCalculation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: TableFooterCalculation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { propertyId?: unknown; fn?: unknown };
    const propertyId = candidate.propertyId;
    const fn = candidate.fn;
    if (typeof propertyId !== "string" || propertyId === "") continue;
    if (typeof fn !== "string") continue;
    if (!AGGREGATION_FUNCTIONS.some((aggregation) => aggregation.id === fn)) continue;
    entries.push({ propertyId, fn: fn as AggregationFn });
  }
  return entries.length > 0 ? entries : undefined;
}

/* ---------------------------------------------------------------------------
   Design-system wiring maps (wave 2)

   The container owns the "presentation + wiring" the design system asks for,
   but every decision a reviewer would want to prove without a DOM is a pure
   mapping here: view type → skeleton count, persisted `rowHeight` → the
   renderer's mode, and a view config → the props `TableView` receives. The JSX
   below only consumes these, so the markup and the mapping cannot disagree.
   --------------------------------------------------------------------------- */

/** View type → the renderer family `SKELETON_COUNTS` (`./view-renderers`) names. */
export const VIEW_SKELETON_KIND: Record<string, ViewKind> = {
  TABLE: "table",
  BOARD: "boardCards",
  LIST: "list",
  GALLERY: "gallery",
  CALENDAR: "calendar",
  TIMELINE: "timeline",
  CHART: "chart",
  FORM: "form",
};

/** How many skeleton rows/cards a view draws while its rows load. */
export function viewSkeletonCount(viewType: string): number {
  return skeletonCount(VIEW_SKELETON_KIND[viewType] ?? "table");
}

/** View types whose renderer draws its own layout-matching loading skeleton. */
export const LOADABLE_VIEW_TYPES: readonly string[] = [
  "TABLE",
  "LIST",
  "BOARD",
  "GALLERY",
  "FORM",
];

/** Whether `viewType`'s renderer owns the loading state (vs. the container). */
export function viewSupportsLoading(viewType: string): boolean {
  return LOADABLE_VIEW_TYPES.includes(viewType);
}

/** Row-height choices, densest to roomiest, in menu order. */
export const TABLE_ROW_HEIGHT_OPTIONS: readonly {
  value: TableRowHeight;
  label: string;
}[] = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "tall", label: "Tall" },
];

/**
 * The persisted table options a `TableView` receives: the row-height mode and
 * the per-column footer spec, both read off the same view config so a reload
 * restores exactly what the user saved. `footer` is `undefined` when the config
 * has none, which keeps the renderer's own `aggregationPropertyId` fallback.
 */
export function tableViewWiring(config: unknown): {
  rowHeight: TableRowHeight;
  footer: TableFooterCalculation[] | undefined;
} {
  const raw = (config ?? {}) as { rowHeight?: unknown; footer?: unknown };
  return {
    rowHeight: resolveTableRowHeight(raw.rowHeight),
    footer: normalizeFooterCalculations(raw.footer),
  };
}

/**
 * Display labels for the Prisma `PropertyType` codes, used by the right-hand
 * peek's property-type chip. Unknown/new codes fall through as-is, so a newer
 * schema never renders a blank chip.
 */
export const PROPERTY_TYPE_LABELS: Record<string, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  SELECT: "Select",
  MULTI_SELECT: "Multi-select",
  STATUS: "Status",
  DATE: "Date",
  CHECKBOX: "Checkbox",
  URL: "URL",
  EMAIL: "Email",
  PHONE: "Phone",
  PEOPLE: "People",
  FILES: "Files",
  FORMULA: "Formula",
  RELATION: "Relation",
  ROLLUP: "Rollup",
  CREATED_TIME: "Created time",
  CREATED_BY: "Created by",
  LAST_EDITED_TIME: "Last edited time",
  LAST_EDITED_BY: "Last edited by",
  UNIQUE_ID: "Unique ID",
  PLACE: "Place",
  BUTTON: "Button",
  AI_AUTOFILL: "AI autofill",
};

/** The display label for a property type (unknown codes pass through). */
export function propertyTypeLabel(type: string): string {
  return PROPERTY_TYPE_LABELS[type] ?? type;
}

/**
 * A view's parsed config plus the additive keys this component owns that the
 * general `ViewConfig` schema does not model — today the database `description`
 * (R89.21). Declared locally so a save can carry the extra key without widening
 * the engine's type.
 */
type EditableViewConfig = ViewConfig & {
  description?: string;
};

/**
 * The viewer's lock role as the *client* can know it. `DatabaseView` is not yet
 * handed the workspace role — the route (`page.tsx`) passes only `editable` —
 * so the strongest role the client can justify is "an editor is owner-capable".
 * That mirrors the page actions menu's own rule ("the Lock toggle must stay
 * reachable on a locked page, or it could never be unlocked") and keeps the
 * database's unlock path reachable from the toolbar; `canEditSchema` still fails
 * closed for a viewer without edit access. The server action re-derives the real
 * role and owns the owner-only unlock, so this only decides whether the toolbar
 * *offers* the control, never whether the write is allowed (R89.24: "hiding
 * buttons is cosmetic").
 */
export function clientLockRole(editable: boolean): LockRole {
  return { isOwner: editable, isMember: editable };
}

/**
 * The pure decision behind the database schema-lock toolbar control (R89.24).
 * `canEditSchema` gates the interactive toggle — an `editSchema` holder gets it,
 * everyone else keeps the read-only lock chip — and `toggleLock` derives the
 * value a click persists, so the control is unit-testable without a DOM. The
 * component routes the action through this function; the server re-checks the
 * same policy before writing.
 */
export function schemaLockToggle(
  lockState: LockState,
  role: LockRole,
): { canToggle: boolean; nextLocked: boolean } {
  return {
    canToggle: canEditSchema(lockState, role),
    nextLocked: toggleLock(lockState).locked,
  };
}

/**
 * The virtual table column that surfaces a row's dependency indicator
 * (`@/lib/dependencies`, spec R89.31). It is not a stored property: it is
 * appended to the table's schema only while the caller supplies blocking
 * edges, its cells are derived (`computedFor`), and its header controls are
 * made inert below — so it never reads or writes a `PropertyValue` and an
 * ordinary database renders exactly as before.
 */
const DEPENDENCY_COLUMN_ID = "__dependencies__";

/**
 * The additive fields the sub-items engine (`@/lib/sub-items`) reads off a
 * row. `subOfId` is persisted on `Page`, `position` is the sibling order; the
 * engine's own vocabulary stays `parentId`/`order`.
 */
type SubItemFields = { subOfId?: string | null; position?: number };
type SubItemDisplayRow = QueryRow & { parentId: string | null; order?: number };

/**
 * fix04 — additive bridges onto the newer sub-issue / relation / rollup engines
 * (`@/lib/sub-issues`, `@/lib/relation-pairs`, `@/lib/rollup-config`). Each
 * helper below is pure and exported so the mapping onto the view's row / config
 * shapes is node-testable without a DOM; `DatabaseView` is the only caller.
 */

/** Persisted sub-items are one level deep; deeper rows surface as orphans. */
export const SUB_ISSUE_MAX_DEPTH = 1;

/** `@/lib/dependencies` edges (`from` blocks `to`) → sub-issues blocking edges. */
export function toSubIssueEdges(edges: readonly DependencyEdge[]): SubIssueDependencyEdge[] {
  return edges.map((edge) => ({ blockerId: edge.from, blockedId: edge.to }));
}

/**
 * Give each blocking edge the stable id the timeline arrow router needs. The
 * pair is unique (`RowDependency` has a compound unique index), so the id is
 * deterministic across renders and server refreshes.
 */
export function toTimelineEdges(
  edges: readonly DependencyEdge[],
): { id: string; from: string; to: string }[] {
  return edges.map((edge) => ({
    id: `${edge.from}:${edge.to}`,
    from: edge.from,
    to: edge.to,
  }));
}

export type SubIssueLayout = {
  /** The visible rows, depth-first, with collapsed subtrees folded shut. */
  rows: QueryRow[];
  /** Per-row estimate/done roll-up keyed by row id (`@/lib/sub-issues`). */
  rollups: Map<string, NodeRollup>;
  /** Rows the tree could not place (unknown parents, depth cap, cycles). */
  orphans: string[];
  /** One concrete closed walk per parent cycle. */
  cycles: string[][];
};

/**
 * Map the view's rows onto the sub-issue forest and back: nest through
 * `buildSubIssueTree`, resolve the visible rows (honouring `collapsedIds`) with
 * `flattenTree`, and roll estimates up with `rollupEstimates`. Rows the tree
 * could not place are appended so no data is ever dropped from the surface.
 */
export function layoutSubIssues(
  rows: readonly SubItemDisplayRow[],
  collapsedIds: Iterable<string> = [],
  options: { maxDepth?: number } = {},
): SubIssueLayout {
  const built = buildSubIssueTree(rows, {
    maxDepth: options.maxDepth ?? SUB_ISSUE_MAX_DEPTH,
  });
  const flat = flattenSubIssueTree(built.tree, { collapsedIds });
  return {
    rows: [...flat.map((entry) => entry.row), ...built.orphans],
    rollups: rollupEstimates(built.tree),
    orphans: built.orphans.map((row) => row.id),
    cycles: built.cycles,
  };
}

/** Relation rows keyed by the property that links them, as the engine reads them. */
export type RelationPairIndex = Record<
  string,
  { pairId: string; inversePropertyId: string | null; targetDatabaseId: string }
>;

/** The relation world built from a single database's rows. */
export type BuiltRelationState = { state: RelationState; pairs: RelationPairIndex };

const pageIdsOf = (value: unknown): string[] => {
  const ids = (value as { pageIds?: unknown } | null | undefined)?.pageIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
};

/** Project a stored property value onto the primitive the rollup aggregates. */
function projectRelationValue(raw: unknown, type: string): unknown {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (type === "NUMBER") return typeof value.number === "number" ? value.number : null;
  if (type === "CHECKBOX") return typeof value.checked === "boolean" ? value.checked : false;
  if (type === "DATE") return typeof value.start === "string" ? value.start : null;
  if (type === "RELATION") return null; // link ids are read from the raw value
  return (
    formatCell(raw, {
      id: "",
      name: "",
      type,
      config: null,
    } as unknown as QueryProperty) || null
  );
}

/**
 * Build a `@/lib/relation-pairs` state from the view's own rows and the related
 * rows the query already resolved (`relationData`). RELATION properties become
 * cross-referencing pairs. The pair's inverse is the configured
 * `config.inversePropertyId` when that property still exists on the target;
 * otherwise a synthetic id keeps the pair well-formed without ever being
 * persisted. Both stored sides are projected so `symmetricPairs` sees real
 * reciprocal edges.
 */
export function buildRelationState(input: {
  databaseId: string;
  properties: readonly DBProperty[];
  rows: readonly DBRow[];
  relationData: Record<string, RelationData>;
}): BuiltRelationState {
  const relationProperties = input.properties.filter((property) => {
    if (property.type !== "RELATION") return false;
    return normalizeRelationConfig(property.config).targetDatabaseId !== null;
  });

  const valueOf = (row: DBRow, propertyId: string): unknown =>
    row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value;

  const rows: { id: string; databaseId: string; values: Record<string, unknown> }[] = [];
  for (const row of input.rows) {
    const values: Record<string, unknown> = {};
    for (const property of input.properties) {
      values[property.id] = projectRelationValue(valueOf(row, property.id), property.type);
    }
    rows.push({ id: row.id, databaseId: input.databaseId, values });
  }

  const pairs: RelationPairIndex = {};
  const definitions = [];
  const links: Record<string, Record<string, string[]>> = {};
  const seenTargets = new Set<string>();

  for (const property of relationProperties) {
    const config = normalizeRelationConfig(property.config);
    const targetDatabaseId = config.targetDatabaseId;
    if (!targetDatabaseId) continue;
    const target = input.relationData[property.id];
    const configuredInverse = config.inversePropertyId;
    const inversePropertyId =
      configuredInverse &&
      target?.properties.some(
        (candidate) =>
          candidate.id === configuredInverse && candidate.type === "RELATION",
      )
        ? configuredInverse
        : null;
    const definition = createRelationPair({
      a: { databaseId: input.databaseId, propertyId: property.id },
      b: {
        databaseId: targetDatabaseId,
        propertyId: inversePropertyId ?? `${property.id}::inverse`,
      },
      cardinality: config.multi ? "many" : "one",
    });
    definitions.push(definition);
    pairs[property.id] = {
      pairId: definition.id,
      inversePropertyId,
      targetDatabaseId,
    };

    if (target) {
      const types = new Map(target.properties.map((entry) => [entry.id, entry.type]));
      for (const [targetRowId, rawById] of Object.entries(target.valuesByRow)) {
        if (!seenTargets.has(`${targetDatabaseId}\u0000${targetRowId}`)) {
          seenTargets.add(`${targetDatabaseId}\u0000${targetRowId}`);
          const values: Record<string, unknown> = {};
          for (const [propertyId, raw] of Object.entries(rawById)) {
            values[propertyId] = projectRelationValue(raw, types.get(propertyId) ?? "TEXT");
          }
          rows.push({ id: targetRowId, databaseId: targetDatabaseId, values });
        }
        if (inversePropertyId) {
          const stored = pageIdsOf(rawById[inversePropertyId]);
          if (stored.length > 0) {
            links[inversePropertyId] = {
              ...(links[inversePropertyId] ?? {}),
              [targetRowId]: stored,
            };
          }
        }
      }
    }
  }

  for (const property of relationProperties) {
    const byRow: Record<string, string[]> = {};
    for (const row of input.rows) {
      const ids = pageIdsOf(valueOf(row, property.id));
      if (ids.length > 0) byRow[row.id] = ids;
    }
    if (Object.keys(byRow).length > 0) links[property.id] = byRow;
  }

  return {
    state: createRelationState({ pairs: definitions, rows, links }),
    pairs,
  };
}

/**
 * The rollup functions `@/lib/relation-pairs` supports natively and that share
 * an exact result with the persisted `@/lib/rollup` vocabulary — so routing the
 * cell through `computeRollup` never changes what a saved rollup displays. Any
 * other function returns `null` and the caller keeps the existing aggregator.
 */
const PAIR_ROLLUP_FNS: Readonly<Partial<Record<RollupFunction, RelationRollupFn>>> = {
  sum: "sum",
  avg: "average",
  min: "min",
  max: "max",
  median: "median",
  unique: "unique",
  checked: "checked",
  show_original: "join",
};

/**
 * Compute a rollup cell through `@/lib/relation-pairs` `computeRollup`, after
 * normalising the persisted config through `@/lib/rollup-config`. Returns the
 * formatted cell text, or `null` when the function is outside the mapped subset
 * (the caller then falls back to the legacy aggregator).
 */
export function rollupCellFromPairs(
  state: RelationState,
  rowId: string,
  storedConfig: unknown,
): string | null {
  const normalized = normalizeRollupConfig(storedConfig);
  const fn = PAIR_ROLLUP_FNS[normalized.aggregateFn];
  if (!fn || normalized.relationPropertyId === "" || normalized.targetPropertyId === "") {
    return null;
  }
  const result = computeRelationRollup(
    state,
    rowId,
    setRollupConfig({
      relationPropertyId: normalized.relationPropertyId,
      targetPropertyId: normalized.targetPropertyId,
      fn,
      separator:
        typeof (storedConfig as { separator?: unknown } | null)?.separator === "string"
          ? (storedConfig as { separator: string }).separator
          : ", ",
    }),
  );
  if (result.value === null) return "—";
  if (typeof result.value === "number") {
    return Number.isInteger(result.value) ? String(result.value) : result.value.toFixed(2);
  }
  return String(result.value);
}

/** A related row's reciprocal-edge count for `rowId` across every relation. */
export function mutualRelationCount(state: RelationState, pairId: string, rowId: string): number {
  return symmetricPairs(state, pairId).filter((edge) => edge.aRowId === rowId).length;
}

export function DatabaseView({
  locale,
  databasePageId,
  workspaceId,
  workspaceSlug,
  templates,
  relationData,
  databases,
  properties,
  views,
  rows: initialRows,
  members,
  editable,
  dependencyEdges = [],
  schemaLocked = false,
  lockedPropertyIds,
  loading = false,
  nextRowCursor = null,
}: {
  databasePageId: string;
  workspaceId: string;
  workspaceSlug: string;
  templates: ViewTemplate[];
  relationData: Record<string, RelationData>;
  databases: { id: string; title: string; icon: string | null }[];
  properties: DBProperty[];
  views: DBView[];
  rows: DBRow[];
  /** Opaque keyset token for the next row window (`null` at the end). */
  nextRowCursor?: string | null;
  /** Workspace members offered by PEOPLE cells (multi-user assignment). */
  members?: { id: string; name: string }[];
  editable: boolean;
  /** Blocking edges (`from` blocks `to`) driving the dependency indicator. */
  dependencyEdges?: DependencyEdge[];
  /** `Page.schemaLocked`: whether the database's structure is frozen (R89.24). */
  schemaLocked?: boolean;
  /** Property ids frozen by the per-property lock (R89.24 refinement). */
  lockedPropertyIds?: string[];
  /**
   * The caller is still fetching this database's rows/views: each view renders
   * its own layout-matching skeleton (and the toolbar stays put, so nothing
   * shifts when the data lands). Additive and defaulted, so an existing caller
   * renders exactly as before.
   */
  loading?: boolean;
  /** UI language (matches the tracker and cycles). */
  locale: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { run: runAction } = useAction(locale);
  const { push: pushGlobal } = useUndoRedo();
  const [extraRows, setExtraRows] = useState<DBRow[]>([]);
  const [extraDependencyEdges, setExtraDependencyEdges] = useState<DependencyEdge[]>([]);
  const [rowCursor, setRowCursor] = useState<string | null>(nextRowCursor);
  const [loadingMoreRows, setLoadingMoreRows] = useState(false);
  useEffect(() => {
    setRowCursor(nextRowCursor);
  }, [nextRowCursor]);
  const rows = useMemo(() => {
    const seen = new Set(initialRows.map((row) => row.id));
    return [...initialRows, ...extraRows.filter((row) => !seen.has(row.id))];
  }, [initialRows, extraRows]);
  const allDependencyEdges = useMemo(() => {
    const seen = new Set(
      dependencyEdges.map((edge) => `${edge.from}\u0000${edge.to}`),
    );
    return [
      ...dependencyEdges,
      ...extraDependencyEdges.filter(
        (edge) => !seen.has(`${edge.from}\u0000${edge.to}`),
      ),
    ];
  }, [dependencyEdges, extraDependencyEdges]);
  /**
   * R89.24 — the schema lock is optimistic while the server write is in
   * flight: the toolbar flips immediately, and a refused write (e.g. a member
   * trying to unlock a locked database, which only the owner may do) reverts the
   * chip and surfaces the action's error. Seeded from the `schemaLocked` prop and
   * re-synced whenever the server echoes a new value.
   */
  const [schemaLockedState, setSchemaLockedState] = useState(schemaLocked);
  const [activeViewId, setActiveViewId] = useState(views[0]?.id ?? "");
  const [addingProperty, setAddingProperty] = useState(false);
  const [editingProperty, setEditingProperty] = useState<string | null>(null);
  const [optionsEditor, setOptionsEditor] = useState<DBProperty | null>(null);
  const [peek, setPeek] = useState<DBRow | null>(null);
  /**
   * The side peek slides in once and mirrors out; it is kept mounted through the
   * exit (`peekMounted`/`peekEntered`) instead of unmounting mid-frame, which is
   * what made the drawer flicker while the open row was re-rendered. Keyed on
   * the row id so handing back an equal row never replays the entrance.
   */
  const [peekMounted, setPeekMounted] = useState(false);
  const [peekEntered, setPeekEntered] = useState(false);
  // Retains the last opened row so the panel can animate out after `peek` clears.
  const peekRowRef = useRef<DBRow | null>(null);
  if (peek) peekRowRef.current = peek;
  const shownPeek = peek ?? peekRowRef.current;
  const peekId = peek?.id ?? null;
  /**
   * Destructive-action gates: the property awaiting a `ConfirmDialog`, the row
   * id awaiting one, and whether the schema-lock write is in flight (drives the
   * toolbar `Switch`'s pending spinner).
   */
  const [propertyToDelete, setPropertyToDelete] = useState<DBProperty | null>(null);
  const [rowToDelete, setRowToDelete] = useState<string | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const [deletedRows, setDeletedRows] = useState<
    { id: string; title: string; icon: string | null; deletedAt: string }[] | null
  >(null);
  /** Latest intended view config while a save is still in flight (see below). */
  const pendingConfig = useRef<EditableViewConfig | undefined>(undefined);
  /**
   * In-session column layout (order/widths/hidden) per view. Like the manual
   * row order below it is remembered for the session and seeded from the legacy
   * `visiblePropertyIds`, so the settings popover and the table agree.
   */
  const [layoutByView, setLayoutByView] = useState<Record<string, ColumnLayout>>({});

  // A server refresh (after a successful lock write, or a concurrent change)
  // re-delivers `schemaLocked`; adopt it so the optimistic buffer never drifts
  // from the persisted value.
  useEffect(() => {
    setSchemaLockedState(schemaLocked);
  }, [schemaLocked]);

  // Play the peek entrance once per row, then replay the mirror on close:
  // `entered` drives `animate-slide-in-right`, and clearing it drives the token
  // exit transition. The panel unmounts only after `--dur-3` has elapsed, so it
  // never disappears mid-frame (the flicker the hand-rolled drawer had).
  useEffect(() => {
    if (peekId) {
      setPeekMounted(true);
      const raf = requestAnimationFrame(() => setPeekEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setPeekEntered(false);
    const timer = setTimeout(() => setPeekMounted(false), DUR.slow);
    return () => clearTimeout(timer);
  }, [peekId]);

  // The open tab is part of the view state: remember it per database so a
  // reload lands on the same tab instead of always resetting to the first one.
  // Restored in an effect (not during the initial render) so server and
  // client HTML stay identical.
  const viewStorageKey = `noema:active-view:${databasePageId}`;
  const tabRestored = useRef(false);
  useEffect(() => {
    if (tabRestored.current) return;
    tabRestored.current = true;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(viewStorageKey);
    } catch {
      stored = null;
    }
    if (stored && views.some((view) => view.id === stored)) {
      setActiveViewId(stored);
    }
  }, [viewStorageKey, views]);

  const selectView = (viewId: string) => {
    setActiveViewId(viewId);
    try {
      window.localStorage.setItem(viewStorageKey, viewId);
    } catch {
      // Private mode / storage disabled — the tab still switches.
    }
  };

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];
  const primary =
    properties.find((p) => p.config?.primary) ?? properties[0] ?? null;

  // Parsed + normalised on read: malformed or unknown stored keys are ignored.
  const viewConfig = parseViewConfig(activeView?.config);
  // Once the server echoes a config back, the props are authoritative again
  // and the optimistic buffer below can be dropped.
  const viewConfigJson = JSON.stringify(viewConfig);
  useEffect(() => {
    pendingConfig.current = undefined;
  }, [viewConfigJson]);
  const { rows: viewRows } = applyView(
    rows as unknown as QueryRow[],
    properties as unknown as QueryProperty[],
    viewConfig,
  );

  // Row lookup for the side peek: a click on a row resolves its id back to the
  // row object the drawer renders.
  const rowsById = useMemo(
    () => new Map(viewRows.map((row) => [row.id, row] as const)),
    [viewRows],
  );

  /** The row id a `/w/<slug>/<id>` link points at, or `null` for anything else. */
  const rowIdFromHref = (href: string | null): string | null => {
    if (!href) return null;
    const prefix = `/w/${workspaceSlug}/`;
    if (!href.startsWith(prefix)) return null;
    const id = href.slice(prefix.length);
    return id !== "" && !id.includes("/") ? id : null;
  };

  /**
   * Open a row in the right-hand "side peek" from a click on the row itself, so
   * a database can be browsed inline without navigating away. The row markup
   * belongs to the shared view components, so the click is delegated (capture
   * phase, so it can stop a `next/link` row from navigating): a table `<tr>`
   * opens its row, and in the card/list/gallery/calendar views the row's own
   * link opens the peek in place of the page. Clicks on inline editors and
   * action controls are left untouched, and a click that does not land on a row
   * changes nothing — the view renders exactly as before, only drawing a drawer
   * once a row is actually opened.
   */
  const openRowPeekFromClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (!target) return;
    const controlSelector =
      "a, button, input, textarea, select, label, [contenteditable='true'], [role='menu'], [role='listbox']";

    // Table view: the row is a `<tr>`; its id comes from the row's own
    // "Open as page" link. A click on a control inside the row keeps its
    // behaviour (editing a cell, the row actions, the explicit page link).
    const tableRow = target.closest("tr");
    if (tableRow) {
      if (target.closest(controlSelector)) return;
      const id = rowIdFromHref(
        tableRow
          .querySelector<HTMLAnchorElement>(`a[href^="/w/${workspaceSlug}/"]`)
          ?.getAttribute("href") ?? null,
      );
      const row = id ? rowsById.get(id) : undefined;
      if (row) setPeek(row);
      return;
    }

    // Card / list / gallery / calendar views: the whole row is a link, so open
    // the peek in place of the navigation. A nested control (a cell editor,
    // a reorder button) keeps its own behaviour; a click on a non-row link is
    // left alone.
    const link = target.closest<HTMLAnchorElement>(`a[href^="/w/${workspaceSlug}/"]`);
    if (!link) return;
    if (
      target.closest(
        "button, input, textarea, select, [contenteditable='true'], [role='menu'], [role='listbox']",
      )
    ) {
      return;
    }
    const id = rowIdFromHref(link.getAttribute("href"));
    const row = id ? rowsById.get(id) : undefined;
    if (!row) return;
    event.preventDefault();
    setPeek(row);
  };

  // R89.30 — sub-issue tree. Rows carry an optional `parentId`/`order` (read
  // defensively: today's flat rows have neither). When the "Sub-tickets" toggle
  // is on the table and list render the forest in depth-first order and fold the
  // descendants of any collapsed parent; when it is off these rows are passed
  // through untouched, so an unmigrated database is byte-for-byte unchanged.
  // This is the `@/lib/sub-issues` engine (depth cap + estimate roll-up +
  // reparent); the session-local reparent overlay mirrors `rowOrderByView`.
  const [nestSubItems, setNestSubItems] = useState(false);
  const [collapsedSubItems, setCollapsedSubItems] = useState<
    Record<string, string[]>
  >({});
  const [subIssueRowsByView, setSubIssueRowsByView] = useState<
    Record<string, SubItemDisplayRow[]>
  >({});
  const subItemRows = useMemo<SubItemDisplayRow[]>(
    () =>
      viewRows.map((row) => {
        const fields = row as QueryRow & SubItemFields;
        return {
          ...row,
          parentId: fields.subOfId ?? null,
          order: fields.position,
        };
      }),
    [viewRows],
  );
  const effectiveSubItemRows = activeView
    ? subIssueRowsByView[activeView.id] ?? subItemRows
    : subItemRows;
  const collapsedSubItemIds = new Set(
    activeView ? collapsedSubItems[activeView.id] ?? [] : [],
  );
  const subIssueLayout = useMemo(() => {
    const collapsed = activeView ? collapsedSubItems[activeView.id] ?? [] : [];
    return layoutSubIssues(effectiveSubItemRows, collapsed, {
      maxDepth: SUB_ISSUE_MAX_DEPTH,
    });
  }, [effectiveSubItemRows, collapsedSubItems, activeView]);
  const displayRows: QueryRow[] = nestSubItems ? subIssueLayout.rows : viewRows;
  const toggleSubItemCollapse = (parentId: string) => {
    if (!activeView) return;
    setCollapsedSubItems((previous) => {
      const current = previous[activeView.id] ?? [];
      const next = current.includes(parentId)
        ? current.filter((id) => id !== parentId)
        : [...current, parentId];
      return { ...previous, [activeView.id]: next };
    });
  };
  /**
   * Move a row through the pure sub-issue engine for immediate feedback, then
   * persist the same edge. A rejected move (self/cycle/depth) never reaches the
   * server; a server refusal rolls the optimistic tree back.
   */
  const moveSubIssueRow = async (id: string, parentId: string | null) => {
    if (!activeView) return;
    const options = { toParentId: parentId, maxDepth: SUB_ISSUE_MAX_DEPTH };
    if (!canMoveSubIssue(effectiveSubItemRows, id, options).ok) return;
    const previousRows = effectiveSubItemRows;
    const moved = moveSubIssue(effectiveSubItemRows, id, options);
    setSubIssueRowsByView((previous) => ({ ...previous, [activeView.id]: moved }));
    const result = await setSubItemParentAction(id, parentId);
    if ("error" in result) {
      setSubIssueRowsByView((previous) => ({
        ...previous,
        [activeView.id]: previousRows,
      }));
      toast.error(result.error);
      return;
    }
    router.refresh();
  };
  /** Promote a nested row to the top level. */
  const promoteSubIssue = (id: string) => {
    void moveSubIssueRow(id, null);
  };
  /**
   * The row a visible row would nest under: the preceding top-level row in the
   * current view order. A row that is already nested, or the first row, has no
   * target.
   */
  const nestTargetFor = (id: string): DBRow | null => {
    const current = effectiveSubItemRows.find((row) => row.id === id);
    if (!current || current.parentId !== null) return null;
    const index = viewRows.findIndex((row) => row.id === id);
    if (index <= 0) return null;
    const previous = viewRows[index - 1] as DBRow;
    if (previous.subOfId) return null;
    return previous;
  };
  /** The roll-up summary for a sub-issue parent, or `null` for a leaf. */
  const subIssueRollupText = (id: string): string | null => {
    const rollup = subIssueLayout.rollups.get(id);
    return rollup && rollup.count > 1 ? describeSubIssueRollup(rollup) : null;
  };

  // R89.31 — dependency indicator, now driven by the sub-issues engine
  // (`dependencyTree`), which folds the same `{ from, to }` blocking edges into
  // a transitive blocked-by / blocks closure and reports cycles. With no edges
  // the graph is empty, every indicator is blank and no column is added, so an
  // ordinary database renders exactly as before.
  const dependencyGraph = useMemo(
    () => buildSubIssueDependencyTree(toSubIssueEdges(allDependencyEdges)),
    [allDependencyEdges],
  );
  const dependencySummary = (rowId: string): string => {
    const node = dependencyGraph.nodes.get(rowId);
    const blocked = node?.blockedBy.length ?? 0;
    const blocking = node?.blocks.length ?? 0;
    const parts: string[] = [];
    if (blocked > 0) parts.push(`${blocked} ${t(locale, "relationBlockedBy")}`);
    if (blocking > 0) parts.push(`${blocking} ${t(locale, "relationBlocks")}`);
    return parts.join(" · ");
  };
  const blockedRowCount = useMemo(
    () =>
      viewRows.filter(
        (row) => (dependencyGraph.nodes.get(row.id)?.blockedBy.length ?? 0) > 0,
      ).length,
    [viewRows, dependencyGraph],
  );
  const lockState: LockState = {
    locked: schemaLockedState,
    ...(lockedPropertyIds && lockedPropertyIds.length > 0
      ? { lockedPropertyIds }
      : {}),
  };
  // R89.24 — the toolbar control the viewer may see: `canEditSchema` gates the
  // interactive toggle (via `schemaLockToggle`), so a non-editor keeps the
  // read-only chip. `clientLockRole` explains how the role is derived today.
  const lockControl = schemaLockToggle(lockState, clientLockRole(editable));

  // The virtual dependency column, plus the table schema/config that show it.
  // Both are the plain values when there are no edges, so the table is
  // untouched until a caller supplies dependencies.
  const hasDependencyEdges = allDependencyEdges.length > 0;
  const dependencyColumn: DBProperty = {
    id: DEPENDENCY_COLUMN_ID,
    name: `${t(locale, "relationBlocks")} / ${t(locale, "relationBlockedBy")}`,
    type: "FORMULA",
    config: null,
  };
  const isDependencyColumn = (id: string | null) =>
    id === DEPENDENCY_COLUMN_ID;
  const tableViewProperties = hasDependencyEdges
    ? [...properties, dependencyColumn]
    : properties;
  const tableViewConfig: ViewConfig = hasDependencyEdges
    ? {
        ...viewConfig,
        visiblePropertyIds: [
          ...(viewConfig.visiblePropertyIds ?? properties.map((p) => p.id)),
          DEPENDENCY_COLUMN_ID,
        ],
      }
    : viewConfig;

  // The virtual column is not a stored property, so its header/toolbar
  // controls would otherwise rename, duplicate or reorder a row that does not
  // exist. These wrappers make every one of them a no-op for that one id.
  const setEditableProperty = (id: string | null) => {
    setEditingProperty(isDependencyColumn(id) ? null : id);
  };
  const renameProperty = (id: string, name: string) => {
    if (isDependencyColumn(id)) return;
    startTransition(async () => {
      await updatePropertyAction(id, { name });
      setEditingProperty(null);
      router.refresh();
    });
  };
  const duplicateProperty = (property: DBProperty) => {
    if (isDependencyColumn(property.id)) return;
    startTransition(async () => {
      await createPropertyAction(
        databasePageId,
        `${property.name} copy`,
        property.type,
      );
      router.refresh();
    });
  };

  // R31.13 — resolve the database's default template through the pure planner
  // so "New row" and the row-creation helpers below share one source of truth.
  // A template flagged `isDefault` wins, with an optional per-view
  // `defaultTemplateId` pin layered on top; today's props expose neither, so
  // this is `null` and New row stays exactly the blank row it has always been.
  const engineTemplates = useMemo(
    () => templates.map(toEngineTemplate),
    [templates],
  );
  const viewDefaultTemplateId = (
    activeView?.config as { defaultTemplateId?: string | null } | null | undefined
  )?.defaultTemplateId;
  // Resolve through the planner, then map back to the raw prop so the creation
  // helper below still sees the original `content` shape.
  const defaultEngineTemplate = resolveDefaultTemplate(engineTemplates, {
    defaultTemplateId: viewDefaultTemplateId ?? null,
  });
  const defaultTemplate = defaultEngineTemplate
    ? templates.find((template) => template.id === defaultEngineTemplate.id) ?? null
    : null;

  // A FORM view keeps its question config under `config.form`; read it off the
  // raw view because the parsed `viewConfig` drops keys the general view schema
  // does not know. An absent/malformed value falls back to the full list of
  // non-computed questions inside `FormView`.
  const formConfig = (
    activeView?.config as { form?: unknown } | null | undefined
  )?.form;

  // BOARD options: an optional swimlane axis (`laneBy`, a second property id)
  // and per-column WIP limits (`wipLimits`, keyed by column/option id). Like
  // `defaultTemplateId`/`form` above, neither key is part of the parsed
  // `viewConfig`, so both are read off the raw view config; `BoardView` and the
  // pure kanban engine ignore malformed values, so an absent/unset pair leaves
  // the plain single-axis, unlimited board exactly as it rendered before.
  const boardLaneBy = (
    activeView?.config as { laneBy?: string | null } | null | undefined
  )?.laneBy;
  const boardWipLimits = (
    activeView?.config as { wipLimits?: Record<string, number> } | null | undefined
  )?.wipLimits;

  // GROUP VISIBILITY (BOARD) + CARD SIZE (GALLERY): the general `viewConfig`
  // schema carries neither key, so — like `laneBy`/`wipLimits` above — both are
  // read off the raw view config and normalised. An absent or malformed value
  // resolves to `undefined`, so `BoardView` shows every column and `GalleryView`
  // keeps sizing cards from the container, exactly as before.
  const boardVisibleGroups = normalizeVisibleGroups(
    (activeView?.config as { visibleGroups?: unknown } | null | undefined)
      ?.visibleGroups,
  );
  const galleryCardSize = normalizeCardSize(
    (activeView?.config as { cardSize?: unknown } | null | undefined)?.cardSize,
  );

  // GALLERY preview + TABLE options: the persisted per-view choices the settings
  // popovers write. `previewPropertyId` is part of the parsed `viewConfig`, so it
  // is read from there; `footer` and the design-system `rowHeight` are not in the
  // general schema, so — like `laneBy`/`cardSize` above — they are read off the
  // raw view config through `tableViewWiring` and normalised. An absent or
  // unusable value keeps `GalleryView`'s automatic cover, `TableView`'s
  // `aggregationPropertyId` footer fallback and the default medium row height —
  // exactly how both rendered before.
  const galleryPreviewPropertyId = viewConfig.previewPropertyId;
  const { rowHeight, footer: tableFooter } = tableViewWiring(activeView?.config);

  // CHART + BOARD options: the parsed `viewConfig` carries `chartType` /
  // `chartAggregate`, but the id-shaped `aggregationPropertyId` (the BOARD column
  // summary) is not part of the general schema. Like `laneBy`/`cardSize` above,
  // it is read off the raw view config and normalised: an absent or malformed
  // value resolves to `undefined`, so `ChartView` keeps its own bar/count
  // defaults and `BoardView` keeps summarising the first NUMBER column — exactly
  // how the view rendered before these options existed.
  const chartType = normalizeChartType(
    (activeView?.config as { chartType?: unknown } | null | undefined)?.chartType,
  );
  const chartAggregate = normalizeChartAggregate(
    (activeView?.config as { chartAggregate?: unknown } | null | undefined)
      ?.chartAggregate,
  );
  const boardAggregationPropertyId = (
    activeView?.config as { aggregationPropertyId?: string | null } | null | undefined
  )?.aggregationPropertyId;

  // DATABASE DESCRIPTION (R89.21): the intro text shown between the toolbar and
  // the active view. Like `defaultTemplateId`/`form` above, the key is not part
  // of the parsed `viewConfig`, so it is read off the raw view config; an absent
  // or non-string value means "no description" and renders nothing.
  const rawDescription = (
    activeView?.config as { description?: unknown } | null | undefined
  )?.description;
  const viewDescription = typeof rawDescription === "string" ? rawDescription : "";

  const setViewConfig = (patch: Partial<EditableViewConfig>) => {
    if (!activeView) return;
    // Two config writes in quick succession used to race: the second one was
    // built from props the server had not re-delivered yet and silently
    // reverted the first (e.g. change a sort direction, add a second sort →
    // the direction came back). Build each patch on the latest *intended*
    // config instead of the last rendered one.
    const base = pendingConfig.current ?? viewConfig;
    // Carry the description across every write so a filter/sort save never
    // drops it; a patch can still override it explicitly.
    const next: EditableViewConfig = {
      ...base,
      ...(viewDescription ? { description: viewDescription } : {}),
      ...patch,
    };
    pendingConfig.current = next;
    startTransition(async () => {
      const result = await updateViewAction(activeView.id, { config: next });
      if ("error" in result) toast.error(result.error);
      router.refresh();
    });
  };

  /** Persist the database intro text (trimmed, 500-char cap); blank clears it. */
  const saveDescription = (value: string) => {
    const trimmed = value.trim().slice(0, 500);
    if (trimmed === viewDescription) return;
    setViewConfig({ description: trimmed || undefined });
  };

  const colorOf = (row: DBRow): string | null =>
    rowColor(
      row as unknown as QueryRow,
      properties as unknown as QueryProperty[],
      viewConfig.colorRules,
    );

  // The view's flat colour rules, adapted to the conditional-formatting engine
  // (which wraps the condition in a `filter`), so the TableView can tint row
  // background/text via `evaluateRowColors`. The same list is handed to each
  // `Cell` so any `"cell"`-target rules also render. A rule with no `target`
  // (or an unknown one) is treated as `"row"` for back-compat.
  const rowColorRules: RowColorRule[] = (viewConfig.colorRules ?? []).map((rule, index) => ({
    id: `view-color-${index}`,
    propertyId: rule.propertyId,
    filter: { propertyId: rule.propertyId, operator: rule.operator, value: rule.value },
    color: rule.color,
    target: rule.target === "cell" ? "cell" : "row",
  }));

  // Column layout. The initial value is seeded from the legacy
  // `visiblePropertyIds` list (views saved before layouts existed) so an
  // untouched view still shows exactly the same columns; `mergeLayout` then
  // extends it with any columns the schema has gained since it was saved.
  const hiddenPropertyIds = viewConfig.visiblePropertyIds;
  const configLayout: ColumnLayout = {
    order: [],
    widths: {},
    hidden:
      hiddenPropertyIds === undefined
        ? {}
        : Object.fromEntries(
            properties
              .filter(
                (property) =>
                  !property.config?.primary &&
                  !hiddenPropertyIds.includes(property.id),
              )
              .map((property) => [property.id, true] as const),
          ),
  };
  const columnIds = properties.map((property) => property.id);
  const layout = mergeLayout(
    (activeView && layoutByView[activeView.id]) || configLayout,
    columnIds,
  );

  /**
   * Persist a column layout: remember it for this view so the popover reflects
   * the toggle immediately, and mirror the resulting visibility into the stored
   * `visiblePropertyIds` — the table renders from the view config, so this is
   * what hides/shows the column and what survives a reload.
   */
  const onLayoutChange = (next: ColumnLayout) => {
    if (!activeView) return;
    const merged = mergeLayout(next, columnIds);
    setLayoutByView((previous) => ({ ...previous, [activeView.id]: merged }));
    setViewConfig({
      visiblePropertyIds: merged.order.filter(
        (id) => id !== primary?.id && merged.hidden[id] !== true,
      ),
    });
  };

  // Local, optimistic manual row order, scoped per view so switching tabs never
  // re-applies one view's order to another. Persisting it is a server concern
  // that does not exist yet, so the order lives for the session only.
  const [rowOrderByView, setRowOrderByView] = useState<Record<string, Record<string, number>>>({});
  const rowOrder = activeView ? rowOrderByView[activeView.id] : undefined;
  const onReorderRows = (orderedIds: string[]) => {
    if (!activeView) return;
    setRowOrderByView((previous) => ({
      ...previous,
      [activeView.id]: Object.fromEntries(
        orderedIds.map((id, index) => [id, (index + 1) * 1000]),
      ),
    }));
  };

  const onLinkDatabase = (property: DBProperty, targetDatabaseId: string) => {
    const previous = normalizeRelationConfig(property.config);
    runAction(
      async () => {
        if (previous.inversePropertyId && previous.targetDatabaseId !== targetDatabaseId) {
          // Changing the target invalidates the old reciprocal column. Clear
          // the pair first so the old target property keeps no stale backlink.
          const cleared = await setRelationTwoWayAction(property.id, false);
          if ("error" in cleared) return cleared;
        }
        return updatePropertyAction(property.id, {
          config: {
            ...(property.config ?? {}),
            targetDatabaseId,
            inversePropertyId:
              previous.targetDatabaseId === targetDatabaseId
                ? previous.inversePropertyId
                : null,
          },
        });
      },
      {
        success: t(locale, "relationLinked"),
        onSuccess: () => router.refresh(),
      },
    );
  };

  const onSetRelationMulti = (property: DBProperty, multi: boolean) => {
    const config = normalizeRelationConfig(property.config);
    runAction(
      () => updatePropertyAction(property.id, { config: { ...config, multi } }),
      { onSuccess: () => router.refresh() },
    );
  };

  const onToggleTwoWay = (property: DBProperty, enabled: boolean) => {
    runAction(() => setRelationTwoWayAction(property.id, enabled), {
      success: t(locale, enabled ? "twoWayEnabled" : "twoWayDisabled"),
      onSuccess: () => router.refresh(),
    });
  };

  const onConfigureRollup = (
    property: DBProperty,
    config: Record<string, unknown>,
  ) =>
    startTransition(async () => {
      await updatePropertyAction(property.id, {
        config: { ...(property.config ?? {}), ...config },
      });
      toast.success(t(locale, "rollupConfigured"));
      router.refresh();
    });

  const onRunButton = (row: DBRow, property: DBProperty) => {
    const config = (property.config ?? {}) as {
      targetPropertyId?: string;
      value?: unknown;
    };
    if (!config.targetPropertyId) {
      toast.error(t(locale, "configureButtonFirst"));
      return;
    }
    startTransition(async () => {
      const result = await setPropertyValueAction(
        row.id,
        config.targetPropertyId as string,
        config.value ?? { checked: true },
      );

      if ("ok" in result) {
        toast.success(t(locale, "done"));
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const onRunAi = (row: DBRow, property: DBProperty) => {
    const config = (property.config ?? {}) as { prompt?: string };
    const context = JSON.stringify(
      Object.fromEntries(
        properties.map((candidate) => [
          candidate.name,
          formatCell(valueFor(row, candidate.id), candidate as unknown as QueryProperty),
        ]),
      ),
    );
    startTransition(async () => {
      try {
        const response = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "autofill",
            workspaceId,
            prompt:
              config.prompt ??
              `Write a concise value for the "${property.name}" property based on the row context.`,
            context: `${context}\nRow title: ${row.title}`,
          }),
        });
        const data = (await response.json()) as { text?: string; error?: string };
        if (!response.ok) {
          toast.error(data.error ?? t(locale, "aiRequestFailed"));
          return;
        }
        await setPropertyValueAction(row.id, property.id, { text: (data.text ?? "").trim() });
        toast.success(t(locale, "autofilled"));
        router.refresh();
      } catch {
        toast.error(t(locale, "aiRequestFailed"));
      }
    });
  };

  const onConfigureButton = (property: DBProperty, targetName: string, value: string) => {
    const target = properties.find(
      (candidate) => candidate.name.toLowerCase() === targetName.trim().toLowerCase(),
    );
    if (!target) {
      toast.error(`${t(locale, "noPropertyNamed")} "${targetName}"`);
      return;
    }
    let json: Record<string, unknown> = { text: value };
    if (target.type === "STATUS" || target.type === "SELECT") {
      const option = target.config?.options?.find(
        (candidate) => candidate.name.toLowerCase() === value.trim().toLowerCase(),
      );
      if (!option) {
        toast.error(`${t(locale, "noOptionNamed")} "${value}"`);
        return;
      }
      json = { optionId: option.id };
    } else if (target.type === "CHECKBOX") {
      json = { checked: ["true", "yes", "1", "x"].includes(value.trim().toLowerCase()) };
    } else if (target.type === "NUMBER") {
      json = { number: Number(value) };
    } else if (target.type === "DATE") {
      json = { start: value };
    }
    startTransition(async () => {
      await updatePropertyAction(property.id, {
        config: { ...(property.config ?? {}), targetPropertyId: target.id, value: json },
      });
      toast.success(t(locale, "buttonConfigured"));
      router.refresh();
    });
  };

  const headerConfig = {
    databases,
    relations: properties
      .filter((p) => p.type === "RELATION")
      .map((p) => ({ id: p.id, name: p.name })),
    relationData,
    onLinkDatabase,
    onConfigureRollup,
    onSetRelationMulti,
    onToggleTwoWay,
  };

  const valueFor = (row: DBRow, propertyId: string): unknown =>
    row.propertyValues.find((v) => v.propertyId === propertyId)?.value;

  const computeFormula = (row: DBRow, property: DBProperty): string => {
    const config = (property.config ?? {}) as { expression?: string };
    const expression = config.expression ?? "";
    if (!expression.trim()) return "—";
    const scope: Record<string, number | string | boolean> = {};
    for (const candidate of properties) {
      const value = valueFor(row, candidate.id) as Record<string, unknown> | null | undefined;
      if (candidate.type === "NUMBER") scope[candidate.name] = Number(value?.number ?? 0);
      else if (candidate.type === "CHECKBOX") scope[candidate.name] = Boolean(value?.checked);
      else scope[candidate.name] = formatCell(value, candidate as unknown as QueryProperty);
    }
    const result = evaluateFormula(expression, scope);
    return result.ok
      ? String(result.value)
      : result.error.startsWith("#")
        ? result.error
        : `#${result.error}`;
  };

  /** Related rows for a relation property, for the relation picker. */
  const relationOptionsFor = (propertyId: string) =>
    relationData[propertyId]?.options ?? [];

  // fix04 — the `@/lib/relation-pairs` world for this database, built from the
  // rows and the related rows the query resolved. Feeds the two-way write plan
  // (`linkRows`/`unlinkRows`), the reciprocal display (`symmetricPairs`) and the
  // rollup cell (`computeRollup`).
  const relationState = useMemo(
    () => buildRelationState({ databaseId: databasePageId, properties, rows, relationData }),
    [databasePageId, properties, rows, relationData],
  );

  /** Reciprocal (stored-on-both-sides) relation edges for the open row. */
  const mutualRelationsFor = (rowId: string): number => {
    let total = 0;
    for (const [propertyId, entry] of Object.entries(relationState.pairs)) {
      const property = properties.find((candidate) => candidate.id === propertyId);
      if (property?.type !== "RELATION") continue;
      total += mutualRelationCount(relationState.state, entry.pairId, rowId);
    }
    return total;
  };

  /**
   * Aggregate related rows' values for a rollup property. Routed through
   * `@/lib/relation-pairs` `computeRollup` (its config normalised by
   * `@/lib/rollup-config`) for the functions it computes exactly as the legacy
   * aggregator did; every other function keeps the existing `@/lib/rollup` path.
   */
  const computeRollup = (row: DBRow, property: DBProperty): string => {
    const viaPairs = rollupCellFromPairs(relationState.state, row.id, property.config);
    if (viaPairs !== null) return viaPairs;

    const config = (property.config ?? {}) as {
      relationPropertyId?: string;
      targetPropertyId?: string;
      function?: RollupFunction;
      separator?: string;
    };
    const relationPropertyId = config.relationPropertyId ?? "";
    const targetPropertyId = config.targetPropertyId ?? "";
    const fn = config.function ?? "count";
    const data = relationData[relationPropertyId];
    if (!data || !targetPropertyId) return "—";

    const relationValue = valueFor(row, relationPropertyId) as
      | { pageIds?: string[] }
      | undefined;
    const ids = relationValue?.pageIds ?? [];
    const targetType =
      data.properties.find((p) => p.id === targetPropertyId)?.type ?? "TEXT";
    const targetProperty = {
      id: targetPropertyId,
      name: "",
      type: targetType,
      config: null,
    } as unknown as QueryProperty;

    const values = ids.map((id) => {
      const raw = data.valuesByRow[id]?.[targetPropertyId];
      const value = (raw ?? {}) as Record<string, unknown>;
      if (targetType === "NUMBER") {
        return typeof value.number === "number" ? value.number : null;
      }
      if (targetType === "CHECKBOX") return Boolean(value.checked);
      if (targetType === "DATE") {
        return typeof value.start === "string" ? value.start : null;
      }
      return formatCell(raw, targetProperty) || null;
    });
    return aggregate(values, fn, {
      separator: typeof config.separator === "string" ? config.separator : ", ",
    });
  };

  /** Computed value for FORMULA, ROLLUP and system properties. */
  const computedFor = (row: DBRow, property: DBProperty): string | undefined => {
    // The virtual dependency column is derived, never stored: its cell reads
    // the blocking graph instead of a property value.
    if (isDependencyColumn(property.id)) return dependencySummary(row.id);
    switch (property.type) {
      case "FORMULA":
        return computeFormula(row, property);
      case "ROLLUP":
        return computeRollup(row, property);
      case "CREATED_TIME":
        return row.createdAt ? stableTime(row.createdAt) : "-";
      case "LAST_EDITED_TIME":
        return row.updatedAt ? stableTime(row.updatedAt) : "-";
      case "CREATED_BY":
        return row.createdByName ?? "—";
      case "LAST_EDITED_BY":
        // Falls back to the creator until a recorded edit says otherwise.
        return row.lastEditedByName ?? row.createdByName ?? "—";
      case "UNIQUE_ID":
        return row.id.slice(-8).toUpperCase();
      default:
        return undefined;
    }
  };

  const setValue = (rowId: string, propertyId: string, value: unknown) => {
    // The server owns relation propagation now: a RELATION write validates the
    // target ids and updates the configured reciprocal cell in the same
    // transaction. Sending the source write once avoids a double reciprocal
    // write from the old client-side planner.
    const previous = rows
      .find((row) => row.id === rowId)
      ?.propertyValues.find((entry) => entry.propertyId === propertyId)?.value;
    runAction(() => setPropertyValueAction(rowId, propertyId, value), {
      onSuccess: () => {
        if (JSON.stringify(previous) !== JSON.stringify(value)) {
          pushGlobal({
            id: crypto.randomUUID(),
            label: `Edit ${properties.find((property) => property.id === propertyId)?.name ?? "property"}`,
            apply: (state) => state,
            invert: (state) => state,
            coalesceKey: `${rowId}:${propertyId}`,
            at: Date.now(),
            onUndo: async () => {
              await setPropertyValueAction(rowId, propertyId, previous ?? null);
              router.refresh();
            },
            onRedo: async () => {
              await setPropertyValueAction(rowId, propertyId, value);
              router.refresh();
            },
          });
        }
        router.refresh();
      },
    });
  };

  /** Append the next keyset window of rows without discarding loaded rows. */
  const loadMoreRows = () => {
    if (!rowCursor || loadingMoreRows) return;
    setLoadingMoreRows(true);
    startTransition(async () => {
      const page = await loadMoreDatabaseRowsAction(databasePageId, rowCursor);
      setLoadingMoreRows(false);
      if ("error" in page) {
        toast.error(page.error);
        return;
      }
      const nextRows: DBRow[] = page.rows.map((row) => ({
        id: row.id,
        title: row.title,
        icon: row.icon,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        createdByName: row.createdBy?.name ?? null,
        lastEditedByName:
          page.lastEditedBy[row.id] ?? row.createdBy?.name ?? null,
        subOfId: row.subOfId,
        position: row.position,
        propertyValues: row.propertyValues.map((entry) => ({
          propertyId: entry.propertyId,
          value: entry.value,
        })),
      }));
      setExtraRows((previous) => {
        const seen = new Set(previous.map((row) => row.id));
        return [...previous, ...nextRows.filter((row) => !seen.has(row.id))];
      });
      setExtraDependencyEdges((previous) => {
        const seen = new Set(previous.map((edge) => `${edge.from}\u0000${edge.to}`));
        return [
          ...previous,
          ...page.dependencies
            .map((edge) => ({ from: edge.blockerId, to: edge.blockedId }))
            .filter((edge) => !seen.has(`${edge.from}\u0000${edge.to}`)),
        ];
      });
      setRowCursor(page.nextRowCursor);
    });
  };

  /**
   * Materialize a template's prefills into a fresh row. The pure planner
   * (`applyTemplate`) plans the row's starting values from the template's
   * exposed defaults. A template body stays the server action's job: the
   * stored `Template.content` is a ProseMirror doc that only the action writes
   * verbatim, so as long as a body (or no property defaults) is present the
   * action — which always reads the persisted template — owns creation and a
   * template-backed row is never silently blank.
   */
  const prefillFromTemplate = async (template: ViewTemplate) => {
    const applied = applyTemplate(
      toEngineTemplate(template),
      {},
      properties.map((property) => property.id),
    );

    if (applied.values.length === 0 || template.content != null) {
      const result = await createRowFromTemplateAction(databasePageId, template.id);
      if ("ok" in result) {
        toast.success(`${t(locale, "rowCreatedFrom")} “${template.name}”`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return;
    }

    const created = await createRowAction(databasePageId, applied.name);
    if (!("ok" in created)) {
      toast.error(created.error);
      return;
    }
    if (applied.icon !== null) {
      await updatePageAction(created.id, { icon: applied.icon });
    }
    for (const cell of applied.values) {
      await setPropertyValueAction(created.id, cell.propertyId, cell.value);
    }
    toast.success(`${t(locale, "rowCreatedFrom")} “${template.name}”`);
    router.refresh();
  };

  /** Create a row from a chosen template ("New from template"). */
  const addRowFromTemplate = (template: ViewTemplate) =>
    startTransition(() => prefillFromTemplate(template));

  const addRow = () =>
    startTransition(async () => {
      // R31.13 — when a default template is exposed, a plain new row starts
      // from it; otherwise this is the blank row it has always been.
      if (defaultTemplate) {
        await prefillFromTemplate(defaultTemplate);
        return;
      }
      await createRowAction(databasePageId);
      router.refresh();
    });

  /**
   * Submit a FORM view through the atomic server action.
   *
   * `FormView` has already run the same validation for immediate feedback; the
   * action re-reads the stored schema and re-validates against the live
   * database before creating the row and every cell in one transaction. The
   * returned result lets the form keep its success state off until the write
   * really committed.
   */
  const submitForm = async (values: { propertyId: string; value: unknown }[]) => {
    const answers = Object.fromEntries(
      values.map((cell) => [cell.propertyId, cell.value]),
    );
    const result = await submitFormAction(activeView.id, answers);
    if ("error" in result) {
      toast.error(result.error);
      return { error: result.error };
    }
    toast.success(t(locale, "done"));
    router.refresh();
    return { ok: true as const };
  };

  const onSaveTemplate = (row: DBRow) =>
    startTransition(async () => {
      const result = await saveRowAsTemplateAction(
        databasePageId,
        row.id,
        row.title || "Template",
      );

      if ("ok" in result) {
        toast.success(t(locale, "savedAsTemplate"));
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const onEditFormula = (property: DBProperty, expression: string) => {
    startTransition(async () => {
      await updatePropertyAction(property.id, {
        config: { ...(property.config ?? {}), expression },
      });
      toast.success(t(locale, "formulaSaved"));
      router.refresh();
    });
  };

  /** NUMBER/DATE display format (percent, currency, friendly date). */
  const onSetFormat = (property: DBProperty, format: string, currency?: string) => {
    setEditingProperty(null);
    startTransition(async () => {
      await updatePropertyAction(property.id, {
        config: { ...(property.config ?? {}), format, ...(currency ? { currency } : {}) },
      });
      router.refresh();
    });
  };

  /** Drag reorder: rewrite every property's position from the visible order. */
  const onReorderProperty = (fromId: string, toId: string) => {
    const ids = properties.map((property) => property.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    startTransition(async () => {
      const result = await reorderPropertiesAction(databasePageId, next);
      if ("error" in result) toast.error(result.error);
      router.refresh();
    });
  };

  // One dialog hosts the text prompts we used to route through window.prompt
  // (button/rollup config, formula, view rename). The destructive property and
  // row deletions are ConfirmDialogs instead (see the render below).
  const [promptState, setPromptState] = useState<
    | { kind: "button"; property: DBProperty }
    | { kind: "formula"; property: DBProperty }
    | { kind: "renameView"; view: DBView }
    | null
  >(null);

  /**
   * Ask for confirmation before a row is trashed: the actual delete runs only
   * after the `ConfirmDialog` is confirmed, so a stray click can never lose a
   * row. The prop `removeRow` the renderers call keeps its exact signature.
   */
  const removeRow = (rowId: string) => setRowToDelete(rowId);

  /** The confirmed half of `removeRow`: trash the row and refresh. */
  const confirmRemoveRow = (rowId: string) =>
    startTransition(async () => {
      const result = await deleteRowAction(rowId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(t(locale, "dbRowTrashed"));
      router.refresh();
    });

  const setPrimary = (row: DBRow, text: string) => {
    if (!primary) return;
    startTransition(async () => {
      await updatePageAction(row.id, { title: text });
      await setPropertyValueAction(row.id, primary.id, { text });
      router.refresh();
    });
  };

  const addView = (type: ViewTypeName) => {
    const label = VIEW_TYPES.find((v) => v.type === type)?.label ?? "View";
    startTransition(async () => {
      await createViewAction(databasePageId, type, label);
      toast.success(`${label} ${t(locale, "viewAddedSuffix")}`);
      router.refresh();
    });
  };

  /** Copy a view: same type and configuration, its own tab. */
  const duplicateView = (view: DBView) =>
    startTransition(async () => {
      const result = await duplicateViewAction(view.id);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      selectView(result.id);
      toast.success(t(locale, "dbViewDuplicated"));
      router.refresh();
    });

  /**
   * Duplicate the whole database (properties, views and rows) into a new page
   * under the same parent, then open it.
   */
  const duplicateDatabase = () =>
    startTransition(async () => {
      const result = await duplicateDatabaseAction(databasePageId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(t(locale, "copiedWord"));
      router.push(`/w/${workspaceSlug}/${result.id}`);
    });

  /** Convert the view between types without touching its configuration. */
  const changeViewType = (view: DBView, type: ViewTypeName) =>
    startTransition(async () => {
      const result = await updateViewAction(view.id, { type });
      if ("error" in result) toast.error(result.error);
      router.refresh();
    });

  const renameView = (view: DBView, name: string) =>
    startTransition(async () => {
      const result = await updateViewAction(view.id, { name });
      if ("error" in result) toast.error(result.error);
      else toast.success(t(locale, "renamed"));
      router.refresh();
    });

  /**
   * R89.24 — flip the database schema lock through `toggleSchemaLockAction`.
   * Optimistic: the toolbar flips before the round-trip; a refused write (a
   * member unlocking a locked database is owner-only server-side) reverts to the
   * previous value and surfaces the action's error. The server is the authority
   * — this handler only decides what the control *shows*.
   */
  const toggleSchemaLock = () =>
    startTransition(async () => {
      const previous = schemaLockedState;
      const next = !previous;
      setSchemaLockedState(next);
      setLockPending(true);
      try {
        const result = await toggleSchemaLockAction(databasePageId, next);
        if ("error" in result) {
          setSchemaLockedState(previous);
          toast.error(result.error);
          return;
        }
        setSchemaLockedState(result.schemaLocked);
        toast.success(describeLock({ locked: result.schemaLocked }));
        router.refresh();
      } finally {
        setLockPending(false);
      }
    });

  /** Soft-deleted rows of this database, for the restore panel. */
  const loadDeletedRows = () =>
    startTransition(async () => {
      const result = await listDeletedRowsAction(databasePageId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setDeletedRows(result.rows);
    });

  const importCsv = (text: string) =>
    startTransition(async () => {
      const result = await importCsvAction(databasePageId, text);
      if ("ok" in result) {
        toast.success(
          `${t(locale, "importedPrefix")} ${result.created} ${t(locale, "rowsUnit")}`,
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const restoreRow = (rowId: string) =>
    startTransition(async () => {
      const result = await restorePageAction(rowId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(t(locale, "dbRowRestored"));
      const list = await listDeletedRowsAction(databasePageId);
      setDeletedRows("error" in list ? [] : list.rows);
      router.refresh();
    });

  if (!activeView) {
    return (
      <EmptyState
        variant="compact"
        icon={<Inbox className="h-4 w-4" />}
        title={t(locale, "dbNoViews")}
      />
    );
  }

  return (
    <div className="mt-2">
      <DatabaseViewTabs
        views={views}
        activeView={activeView}
        editable={editable}
        locale={locale}
        rowCount={viewRows.length}
        onSelect={selectView}
        onRename={(view) => setPromptState({ kind: "renameView", view })}
        onDuplicate={duplicateView}
        onChangeType={changeViewType}
        onAdd={addView}
      />

      {/* Full-page toolbar: view settings on the left, row/schema actions on
          the right — everything that shapes this view sits above the table. */}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <DatabaseViewToolbar
          locale={locale}
          properties={properties}
          config={viewConfig}
          editable={editable}
          onChange={setViewConfig}
          layout={layout}
          onLayoutChange={onLayoutChange}
        />
        <DatabaseActions
          locale={locale}
          editable={editable}
          nestSubItems={nestSubItems}
          onToggleNest={() => setNestSubItems((value) => !value)}
          blockedRowCount={blockedRowCount}
          canToggleLock={lockControl.canToggle}
          lockLabel={describeLock(lockState)}
          schemaLockedState={schemaLockedState}
          showReadOnlyLock={schemaLockedState || (lockedPropertyIds?.length ?? 0) > 0}
          onToggleLock={toggleSchemaLock}
          onAddRow={addRow}
          defaultTemplateName={defaultTemplate?.name ?? null}
          templates={templates}
          onAddRowFromTemplate={addRowFromTemplate}
          onToggleDeletedRows={() =>
            deletedRows === null ? loadDeletedRows() : setDeletedRows(null)
          }
          onNewProperty={() => setAddingProperty((v) => !v)}
          onDuplicateDatabase={duplicateDatabase}
          databasePageId={databasePageId}
          onImportCsv={importCsv}
        />
      </div>

      {/* Database description (R89.21): intro text above the view. Editors get
          an inline field; everyone else sees the stored text, and an empty
          description renders nothing. */}
      {editable ? (
        <textarea
          key={activeView.id}
          defaultValue={viewDescription}
          aria-label={t(locale, "descriptionLabel")}
          placeholder={t(locale, "addDescription")}
          maxLength={500}
          rows={2}
          onBlur={(event) => saveDescription(event.target.value)}
          className="focus-ring mb-3 w-full resize-y rounded-control border border-transparent bg-transparent px-1 py-1 text-sm text-muted placeholder:text-muted hover:border-border focus:border-border focus:bg-surface"
        />
      ) : (
        viewDescription !== "" && (
          <p className="mb-3 whitespace-pre-wrap px-1 text-sm text-muted">
            {viewDescription}
          </p>
        )
      )}

      {/* Deleted rows: soft-deleted rows of this database, restorable inline. */}
      {deletedRows !== null && (
        <div
          className="mb-3 rounded-lg border border-border bg-surface p-3"
          role="region"
          aria-label={t(locale, "dbDeletedRows")}
        >
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              {t(locale, "dbDeletedRows")}
            </p>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(locale, "close")}
              onClick={() => setDeletedRows(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {deletedRows.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={<Inbox className="h-4 w-4" />}
              title={t(locale, "dbNoDeletedRows")}
            />
          ) : (
            <ul className="divide-y divide-border">
              {deletedRows.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 py-1.5 text-sm"
                >
                  <span className="truncate">
                    {row.icon ?? "📄"} {row.title || t(locale, "untitled")}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted">
                      {stableTime(row.deletedAt)}
                    </span>
                    <Button
                      variant="subtle"
                      size="xs"
                      onClick={() => restoreRow(row.id)}
                      leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                    >
                      {t(locale, "restore")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div onClickCapture={openRowPeekFromClick}>
      {loading && !viewSupportsLoading(activeView.type) ? (
        /* Views whose renderer has no loading state of its own (calendar,
           timeline, chart, or an unknown type) get a container skeleton sized
           from the view so nothing shifts when the rows land. */
        <Skeleton
          variant="table"
          rows={viewSkeletonCount(activeView.type)}
          cols={Math.min(6, Math.max(2, properties.length))}
        />
      ) : activeView.type === "BOARD" ? (
        <BoardView
          locale={locale}
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          properties={properties}
          rows={viewRows}
          colorOf={colorOf}
          groupBy={
            viewConfig.groupByPropertyId ??
            properties.find((p) => p.type === "STATUS" || p.type === "SELECT")
              ?.id ??
            null
          }
          primary={primary}
          valueFor={valueFor}
          setValue={setValue}
          computedFor={computedFor}
          peopleOptions={members ?? []}
          editable={editable}
          laneBy={boardLaneBy}
          wipLimits={boardWipLimits}
          visibleGroups={boardVisibleGroups}
          aggregationPropertyId={boardAggregationPropertyId}
          loading={loading}
          onAddRow={editable ? addRow : undefined}
        />
      ) : activeView.type === "LIST" ? (
        <ListView
            locale={locale}
          workspaceSlug={workspaceSlug}
          properties={properties}
          rows={displayRows}
          valueFor={valueFor}
          editable={editable}
          rowOrder={rowOrder}
          onReorderRows={onReorderRows}
          loading={loading}
          onAddRow={editable ? addRow : undefined}
        />
      ) : activeView.type === "GALLERY" ? (
        <GalleryView
          locale={locale}
          workspaceSlug={workspaceSlug}
          properties={properties}
          rows={viewRows}
          primary={primary}
          valueFor={valueFor}
          computedFor={computedFor}
          cardSize={galleryCardSize}
          previewPropertyId={galleryPreviewPropertyId}
          loading={loading}
          onAddRow={editable ? addRow : undefined}
        />
      ) : activeView.type === "CALENDAR" ? (
        <LazyCalendarView
          locale={locale}
          workspaceSlug={workspaceSlug}
          properties={properties}
          rows={viewRows}
          valueFor={valueFor}
        />
      ) : activeView.type === "TIMELINE" ? (
        <LazyTimelineView
          locale={locale}
          workspaceSlug={workspaceSlug}
          properties={properties}
          rows={viewRows}
          edges={toTimelineEdges(allDependencyEdges)}
          editable={editable}
        />
      ) : activeView.type === "CHART" ? (
        <LazyChartView
          locale={locale}
          properties={properties}
          rows={viewRows}
          groupByPropertyId={viewConfig.groupByPropertyId}
          chartType={chartType}
          aggregateFn={chartAggregate}
        />
      ) : activeView.type === "FORM" ? (
        <div className="space-y-3">
          {editable && (
            <FormBuilder
              locale={locale}
              properties={properties}
              config={formConfig}
              viewId={activeView.id}
              databaseId={databasePageId}
              defaultTitle={activeView.name}
              responseCount={rows.length}
              onSave={(form) => setViewConfig({ form })}
            />
          )}
          <LazyFormView
            locale={locale}
            properties={properties}
            config={formConfig}
            // A read-only database shows the questions without a submit seam,
            // matching how every other view omits its editors when not editable.
            onSubmit={editable ? submitForm : undefined}
            loading={loading}
          />
        </div>
      ) : activeView.type === "TABLE" ? (
        <TableView
          locale={locale}
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          properties={tableViewProperties}
          rows={displayRows}
          primary={primary}
          editable={editable}
          config={tableViewConfig}
          valueFor={valueFor}
          setValue={setValue}
          setPrimary={setPrimary}
          removeRow={removeRow}
          onSaveTemplate={onSaveTemplate}
          computedFor={computedFor}
          relationOptionsFor={relationOptionsFor}
          peopleOptions={members ?? []}
          headerConfig={headerConfig}
          onRunButton={onRunButton}
          onConfigureButton={(property) => setOptionsEditor(property)}
          onOpenPeek={setPeek}
          onRunAi={onRunAi}
          colorOf={colorOf}
          onEditFormula={(property) => {
            if (isDependencyColumn(property.id)) return;
            setPromptState({ kind: "formula", property });
          }}
          onSetFormat={onSetFormat}
          onEditOptions={(property) => setOptionsEditor(property)}
          editingProperty={editingProperty}
          setEditingProperty={setEditableProperty}
          onDeleteProperty={(id) => {
            // The virtual dependency column is not a stored property.
            if (isDependencyColumn(id)) return;
            const target = properties.find((property) => property.id === id);
            if (!target) return;
            // A property delete removes every row's values for it: confirm
            // first so a stray click can never lose data.
            setPropertyToDelete(target);
          }}
          onReorderProperty={onReorderProperty}
          rowOrder={rowOrder}
          onReorderRows={onReorderRows}
          rowColorRules={rowColorRules}
          onRenameProperty={renameProperty}
          onDuplicateProperty={duplicateProperty}
          rowHeight={rowHeight}
          loading={loading}
          onAddRow={editable ? addRow : undefined}
          footer={tableFooter}
        />
      ) : (
        <EmptyState
          variant="compact"
          icon={<Inbox className="h-4 w-4" />}
          title={
            <>
              {t(locale, "dbScaffoldA")} {activeView.name} {t(locale, "dbScaffoldB")}
            </>
          }
        />
      )}
      </div>

      {rowCursor && activeView?.type !== "FORM" ? (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={loadMoreRows}
            disabled={loadingMoreRows}
            className="focus-ring rounded-control border border-border bg-bg px-3 py-1.5 text-sm text-fg hover:bg-surface-2 disabled:opacity-60"
          >
            {loadingMoreRows ? t(locale, "loading") : t(locale, "loadMore")}
          </button>
        </div>
      ) : null}

      {addingProperty && (
        <AddPropertyForm
          databasePageId={databasePageId}
          locale={locale}
          onClose={() => setAddingProperty(false)}
        />
      )}

      {peekMounted && shownPeek !== null && (
        <DatabasePeek
          row={shownPeek}
          locale={locale}
          workspaceSlug={workspaceSlug}
          rowColor={colorOf(shownPeek)}
          entered={peekEntered}
          onClose={() => setPeek(null)}
          dependencySummary={dependencySummary(shownPeek.id)}
          blockedByTitles={(dependencyGraph.nodes.get(shownPeek.id)?.blockedBy ?? []).map(
            (id) => rowsById.get(id)?.title ?? id,
          )}
          dependencyEditor={
            editable ? (
              <LazyRowDependencies
                locale={locale}
                databasePageId={databasePageId}
                currentRowId={shownPeek.id}
                rows={rows.map((row) => ({ id: row.id, title: row.title }))}
                edges={allDependencyEdges}
              />
            ) : null
          }
          subItemCount={
            nestSubItems ? subItemChildrenOf(effectiveSubItemRows, shownPeek.id).length : 0
          }
          collapsed={collapsedSubItemIds.has(shownPeek.id)}
          onToggleCollapse={() => toggleSubItemCollapse(shownPeek.id)}
          rollupText={nestSubItems ? subIssueRollupText(shownPeek.id) : null}
          isNested={
            nestSubItems &&
            effectiveSubItemRows.find((entry) => entry.id === shownPeek.id)?.parentId != null
          }
          onPromote={() => promoteSubIssue(shownPeek.id)}
          nestTargetTitle={nestTargetFor(shownPeek.id)?.title ?? null}
          onNest={() => {
            const target = nestTargetFor(shownPeek.id);
            if (target) void moveSubIssueRow(shownPeek.id, target.id);
          }}
          mutualRelations={mutualRelationsFor(shownPeek.id)}
          properties={properties}
          primaryId={primary?.id ?? null}
          computedFor={(property) => computedFor(shownPeek, property)}
          valueFor={(propertyId) => valueFor(shownPeek, propertyId)}
          relationOptionsFor={relationOptionsFor}
          peopleOptions={members ?? []}
          workspaceId={workspaceId}
          editable={editable}
          onChange={(propertyId, value) => setValue(shownPeek.id, propertyId, value)}
          onRenamePrimary={(text) => setPrimary(shownPeek, text)}
        />
      )}

      <Dialog
        open={optionsEditor !== null}
        onOpenChange={(next) => {
          if (!next) setOptionsEditor(null);
        }}
      >
        {optionsEditor && (
          <LazyPropertyOptionsEditor
            locale={locale}
            property={optionsEditor}
            onClose={() => setOptionsEditor(null)}
          />
        )}
      </Dialog>

      <PromptDialog
        open={promptState !== null}
        locale={locale}
        title={
          promptState?.kind === "formula"
            ? t(locale, "formulaWord")
            : promptState?.kind === "renameView"
              ? t(locale, "rename")
              : t(locale, "configureButton")
        }
        description={
          promptState?.kind === "formula"
            ? `Available: prop("Name"), + - * / %, if(), concat(), round(), min(), max(), length(), upper(), lower(), contains(), empty()`
            : promptState?.kind === "renameView"
              ? undefined
              : t(locale, "buttonPromptDesc")
        }
        fields={
          promptState?.kind === "formula"
            ? [
                {
                  name: "expression",
                  label: `${t(locale, "formulaFor")} “${promptState.property.name}”`,
                  defaultValue:
                    (promptState.property.config as { expression?: string } | null)?.expression ??
                    "",
                  multiline: true,
                  placeholder: 'concat(prop("Name"), " — done")',
                },
              ]
            : promptState?.kind === "renameView"
              ? [
                  {
                    name: "name",
                    label: t(locale, "nameLabel"),
                    defaultValue: promptState.view.name,
                  },
                ]
              : [
                  {
                    name: "target",
                    label: t(locale, "targetPropertyLabel"),
                    placeholder: "Status",
                    hint: t(locale, "targetHint"),
                  },
                  {
                    name: "value",
                    label: t(locale, "valueToSetLabel"),
                    placeholder: "Done",
                    hint: t(locale, "valueHint"),
                  },
                ]
        }
        confirmLabel={
          promptState?.kind === "formula"
            ? t(locale, "saveFormula")
            : promptState?.kind === "renameView"
              ? t(locale, "save")
              : t(locale, "saveButton")
        }
        onSubmit={(values) => {
          if (!promptState) return;
          if (promptState.kind === "formula") onEditFormula(promptState.property, values.expression);
          else if (promptState.kind === "renameView") renameView(promptState.view, values.name);
          else onConfigureButton(promptState.property, values.target, values.value);
        }}
        onClose={() => setPromptState(null)}
      />

      {/* Destructive actions are gated behind the design-system ConfirmDialog:
          a property delete drops every row's values for it, and a row delete
          trashes the row — neither should ever fire from a stray click. */}
      <ConfirmDialog
        open={propertyToDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPropertyToDelete(null);
        }}
        tone="danger"
        title={`${t(locale, "deleteProperty")}: ${propertyToDelete?.name ?? ""}`}
        description={t(locale, "deletePropWarn")}
        confirmLabel={t(locale, "deleteProperty")}
        cancelLabel={t(locale, "cancel")}
        onConfirm={() => {
          const target = propertyToDelete;
          if (!target) return;
          setPropertyToDelete(null);
          startTransition(async () => {
            const result = await deletePropertyAction(target.id);
            if ("error" in result) toast.error(result.error);
            else toast.success(`${t(locale, "deletedPrefix")} “${target.name}”`);
            router.refresh();
          });
        }}
      />

      <ConfirmDialog
        open={rowToDelete !== null}
        onOpenChange={(next) => {
          if (!next) setRowToDelete(null);
        }}
        tone="danger"
        title={t(locale, "deleteRow")}
        description={
          rowToDelete
            ? rowsById.get(rowToDelete)?.title || t(locale, "untitled")
            : undefined
        }
        confirmLabel={t(locale, "deleteRow")}
        cancelLabel={t(locale, "cancel")}
        onConfirm={() => {
          const target = rowToDelete;
          if (!target) return;
          setRowToDelete(null);
          confirmRemoveRow(target);
        }}
      />
    </div>
  );
}


export {
  ROW_HOVER_TINT,
  ROW_ACCENT_RAIL,
  peekScrimClass,
  peekScrimStyle,
  peekPanelClass,
  peekPanelStyle,
  peekRail,
  peekRowClass,
  PeekHeader,
  PeekRow,
} from "@/components/database/database-peek";

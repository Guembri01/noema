"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { PromptDialog } from "@/components/prompt-dialog";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Ban,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  History,
  LayoutTemplate,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X } from "lucide-react";
import {
  createPropertyAction,
  createRowAction,
  createViewAction,
  deletePropertyAction,
  deleteRowAction,
  duplicateDatabaseAction,
  duplicateViewAction,
  importCsvAction,
  createRowFromTemplateAction,
  deleteTemplateAction,
  listDeletedRowsAction,
  reorderPropertiesAction,
  saveRowAsTemplateAction,
  setPropertyValueAction,
  setTemplateRecurrenceAction,
  updatePropertyAction,
  updateViewAction } from "@/server/actions/database";
import { restorePageAction, updatePageAction } from "@/server/actions/pages";
import { cn } from "@/lib/utils";
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
import {
  blockersOf,
  buildDependencyGraph,
  dependentsOf,
  type DependencyEdge,
} from "@/lib/dependencies";
import { describeLock, type LockState } from "@/lib/database-lock";
import {
  childrenOf as subItemChildrenOf,
  visibleRows as visibleSubItemRows,
} from "@/lib/sub-items";
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
import {
  type DBProperty,
  type DBRow,
  type DBView } from "@/components/database/database-types";
import { ChartView, TimelineView } from "@/components/database/timeline-chart-views";
import { ViewSettings } from "@/components/database/view-settings";
import { PropertyOptionsEditor } from "@/components/database/property-options-editor";
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
import { AddPropertyForm, Cell, icon as propertyIcon } from "./view-parts";
import {
  TableView,
  ListView,
  BoardView,
  GalleryView,
  CalendarView,
  FormView,
  type TableFooterCalculation,
} from "./view-renderers";

export {
  COLOR_CHOICES,
  CONTROL_CLASS,
  OPTION_COLORS,
} from "@/components/database/database-types";

type ViewTypeName =
  | "TABLE"
  | "BOARD"
  | "LIST"
  | "GALLERY"
  | "CALENDAR"
  | "TIMELINE"
  | "CHART";

const VIEW_TYPES: { type: ViewTypeName; label: string }[] = [
  { type: "TABLE", label: "Table" },
  { type: "BOARD", label: "Board" },
  { type: "LIST", label: "List" },
  { type: "GALLERY", label: "Gallery" },
  { type: "CALENDAR", label: "Calendar" },
  { type: "TIMELINE", label: "Timeline" },
  { type: "CHART", label: "Chart" },
];

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

/**
 * A view's parsed config plus the additive keys this component owns that the
 * general `ViewConfig` schema does not model — today the database `description`
 * (R89.21). Declared locally so a save can carry the extra key without widening
 * the engine's type.
 */
type EditableViewConfig = ViewConfig & { description?: string };

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
 * row. `DBRow` does not carry them yet, so they are read defensively: an
 * absent `parentId` keeps a row at the top level and the tree renders exactly
 * like today's flat list.
 */
type SubItemFields = { parentId?: string | null; order?: number };
type SubItemDisplayRow = QueryRow & SubItemFields;

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
  rows,
  members,
  editable,
  dependencyEdges = [],
  schemaLocked = false,
  lockedPropertyIds,
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
  /** Workspace members offered by PEOPLE cells (multi-user assignment). */
  members?: { id: string; name: string }[];
  editable: boolean;
  /** Blocking edges (`from` blocks `to`) driving the dependency indicator. */
  dependencyEdges?: DependencyEdge[];
  /** `Page.schemaLocked`: whether the database's structure is frozen (R89.24). */
  schemaLocked?: boolean;
  /** Property ids frozen by the per-property lock (R89.24 refinement). */
  lockedPropertyIds?: string[];
  /** UI language (matches the tracker and cycles). */
  locale: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [activeViewId, setActiveViewId] = useState(views[0]?.id ?? "");
  const [addingProperty, setAddingProperty] = useState(false);
  const [editingProperty, setEditingProperty] = useState<string | null>(null);
  const [optionsEditor, setOptionsEditor] = useState<DBProperty | null>(null);
  const [peek, setPeek] = useState<DBRow | null>(null);
  const [deletedRows, setDeletedRows] = useState<
    { id: string; title: string; icon: string | null; deletedAt: string }[] | null
  >(null);
  const csvInputRef = useRef<HTMLInputElement | null>(null);
  /** Latest intended view config while a save is still in flight (see below). */
  const pendingConfig = useRef<EditableViewConfig | undefined>(undefined);
  /**
   * In-session column layout (order/widths/hidden) per view. Like the manual
   * row order below it is remembered for the session and seeded from the legacy
   * `visiblePropertyIds`, so the settings popover and the table agree.
   */
  const [layoutByView, setLayoutByView] = useState<Record<string, ColumnLayout>>({});

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

  // R89.30 — sub-items tree. Rows carry an optional `parentId`/`order` (read
  // defensively: today's flat rows have neither). When the "Sub-tickets"
  // toggle is on the table and list render the forest in depth-first order and
  // fold the descendants of any collapsed parent; when it is off these rows
  // are passed through untouched, so an unmigrated database is byte-for-byte
  // unchanged. Indentation/chevrons inside the renderers are a follow-up.
  const [nestSubItems, setNestSubItems] = useState(false);
  const [collapsedSubItems, setCollapsedSubItems] = useState<
    Record<string, string[]>
  >({});
  const subItemRows = useMemo<SubItemDisplayRow[]>(
    () =>
      viewRows.map((row) => {
        const fields = row as QueryRow & SubItemFields;
        return { ...row, parentId: fields.parentId ?? null, order: fields.order };
      }),
    [viewRows],
  );
  const collapsedSubItemIds = new Set(
    activeView ? collapsedSubItems[activeView.id] ?? [] : [],
  );
  const displayRows: QueryRow[] = nestSubItems
    ? visibleSubItemRows(subItemRows, collapsedSubItemIds)
    : viewRows;
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

  // R89.31 — dependency indicator. The blocking graph is built from the
  // optional edges the caller supplies (`from` blocks `to`); with no edges the
  // graph is empty, every indicator is blank and no column is added, so an
  // ordinary database renders exactly as before.
  const dependencyGraph = useMemo(
    () => buildDependencyGraph(dependencyEdges),
    [dependencyEdges],
  );
  const dependencySummary = (rowId: string): string => {
    const blocked = blockersOf(dependencyGraph, rowId).length;
    const blocking = dependentsOf(dependencyGraph, rowId).length;
    const parts: string[] = [];
    if (blocked > 0) parts.push(`${blocked} ${t(locale, "relationBlockedBy")}`);
    if (blocking > 0) parts.push(`${blocking} ${t(locale, "relationBlocks")}`);
    return parts.join(" · ");
  };
  const blockedRowCount = useMemo(
    () =>
      viewRows.filter((row) => blockersOf(dependencyGraph, row.id).length > 0)
        .length,
    [viewRows, dependencyGraph],
  );
  const lockState: LockState = {
    locked: schemaLocked,
    ...(lockedPropertyIds && lockedPropertyIds.length > 0
      ? { lockedPropertyIds }
      : {}),
  };

  // The virtual dependency column, plus the table schema/config that show it.
  // Both are the plain values when there are no edges, so the table is
  // untouched until a caller supplies dependencies.
  const hasDependencyEdges = dependencyEdges.length > 0;
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

  // GALLERY preview + TABLE footer: the persisted per-view choices the settings
  // popovers write. `previewPropertyId` is part of the parsed `viewConfig`, so it
  // is read from there; `footer` is not in the general schema, so — like
  // `laneBy`/`cardSize` above — it is read off the raw view config and
  // normalised. An absent or unusable value resolves to `undefined`, so
  // `GalleryView` keeps its automatic cover and `TableView` keeps its
  // `aggregationPropertyId` fallback — exactly how both rendered before.
  const galleryPreviewPropertyId = viewConfig.previewPropertyId;
  const tableFooter = normalizeFooterCalculations(
    (activeView?.config as { footer?: unknown } | null | undefined)?.footer,
  );

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

  const onLinkDatabase = (property: DBProperty, targetDatabaseId: string) =>
    startTransition(async () => {
      await updatePropertyAction(property.id, {
        config: { ...(property.config ?? {}), targetDatabaseId },
      });
      toast.success(t(locale, "relationLinked"));
      router.refresh();
    });

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

  /** Aggregate related rows' values for a rollup property. */
  const computeRollup = (row: DBRow, property: DBProperty): string => {
    const config = (property.config ?? {}) as {
      relationPropertyId?: string;
      targetPropertyId?: string;
      function?: RollupFunction;
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
    return aggregate(values, fn);
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
    startTransition(async () => {
      await setPropertyValueAction(rowId, propertyId, value);
      router.refresh();
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
   * Submit a FORM view. The row is created through the same `createRowAction`
   * path the table's "New row" uses — the submitted title (the primary column,
   * when it is a question) seeds the row so its cell is not written twice —
   * then every other accepted answer is written with `setPropertyValueAction`,
   * exactly as a cell edit would. `FormView` owns validation, so only accepted
   * answers reach here.
   */
  const submitForm = (values: { propertyId: string; value: unknown }[]) => {
    startTransition(async () => {
      const primaryAnswer = primary
        ? values.find((cell) => cell.propertyId === primary.id)
        : undefined;
      const submittedTitle = (primaryAnswer?.value as { text?: unknown } | undefined)?.text;
      const created = await createRowAction(
        databasePageId,
        typeof submittedTitle === "string" ? submittedTitle : "",
      );
      if (!("ok" in created)) {
        toast.error(created.error);
        return;
      }
      for (const cell of values) {
        // `createRowAction` already seeded the primary cell from the title.
        if (cell.propertyId === primary?.id) continue;
        await setPropertyValueAction(created.id, cell.propertyId, cell.value);
      }
      toast.success(t(locale, "done"));
      router.refresh();
    });
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

  // One dialog hosts the prompts we used to route through window.prompt, plus
  // the destructive-property confirmation.
  const [promptState, setPromptState] = useState<
    | { kind: "button"; property: DBProperty }
    | { kind: "formula"; property: DBProperty }
    | { kind: "renameView"; view: DBView }
    | { kind: "deleteProperty"; property: DBProperty }
    | null
  >(null);

  const removeRow = (rowId: string) =>
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
    return <p className="text-sm text-muted">{t(locale, "dbNoViews")}</p>;
  }

  return (
    <div className="mt-2">
      {/* View tabs — the active tab is persisted per database. */}
      <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-border">
        {views.map((view) => (
          <div key={view.id} className="flex items-center">
            <button
              type="button"
              aria-current={view.id === activeView.id ? "true" : undefined}
              onClick={() => selectView(view.id)}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
                view.id === activeView.id
                  ? "-mb-px border-fg font-medium text-fg"
                  : "border-transparent text-muted hover:text-fg",
              )}
            >
              <ViewIcon type={view.type} />
              {view.name}
            </button>
            {editable && view.id === activeView.id && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t(locale, "dbViewMenu")}
                    title={t(locale, "dbViewMenu")}
                    className="-mb-px flex items-center justify-center rounded px-1.5 py-1.5 text-muted hover:bg-surface-2"
                  >
                    <Ellipsis className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    onSelect={() => setPromptState({ kind: "renameView", view })}
                  >
                    {t(locale, "rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => duplicateView(view)}>
                    <Copy className="h-4 w-4 text-muted" /> {t(locale, "duplicate")}
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{t(locale, "typeLabel")}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {VIEW_TYPES.map((candidate) => (
                        <DropdownMenuItem
                          key={candidate.type}
                          onSelect={() => changeViewType(view, candidate.type)}
                        >
                          <ViewIcon type={candidate.type} />
                          {candidate.label}
                          {view.type === candidate.type ? " ✓" : ""}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t(locale, "addViewAria")}
                className="-mb-px ml-1 flex items-center justify-center rounded px-2 py-1.5 text-muted hover:bg-surface-2"
              >
                <Plus className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {VIEW_TYPES.map((v) => (
                <DropdownMenuItem key={v.type} onSelect={() => addView(v.type)}>
                  <ViewIcon type={v.type} />
                  {v.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="ml-auto pr-1 text-xs text-muted">
          {viewRows.length} {t(locale, "rowsUnit")}
        </span>
      </div>

      {/* Full-page toolbar: view settings on the left, row/schema actions on
          the right — everything that shapes this view sits above the table. */}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <ViewSettings
          locale={locale}
          properties={properties}
          config={viewConfig}
          editable={editable}
          onChange={setViewConfig}
          layout={layout}
          onLayoutChange={onLayoutChange}
        />
        <div className="flex flex-wrap items-center gap-1">
          {/* R89.30 — sub-items nesting toggle. A pure view preference, so it
              is offered to every viewer, not just editors. */}
          <button
            type="button"
            aria-pressed={nestSubItems}
            aria-label={t(locale, "subticketsHeading")}
            title={t(locale, "breadcrumbHint")}
            onClick={() => setNestSubItems((value) => !value)}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-sm text-muted hover:bg-surface-2",
              nestSubItems && "bg-surface-2 text-fg",
            )}
          >
            <ChevronRight
              className={cn(
                "h-4 w-4 transition-transform",
                nestSubItems && "rotate-90",
              )}
            />
            {t(locale, "subticketsHeading")}
          </button>
          {/* R89.31 — how many rows this view has blocked. Only shown once the
              caller supplies dependency edges. */}
          {blockedRowCount > 0 && (
            <span
              className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted"
              title={t(locale, "relationBlockedBy")}
            >
              <Ban className="h-4 w-4" />
              {blockedRowCount} {t(locale, "relationBlockedBy")}
            </span>
          )}
          {/* R89.24 — database lock. Read-only for now: the engine's canonical
              summary, shown while the structure is frozen or while individual
              properties are pinned by the per-property lock (`describeLock`
              covers both). The interactive toggle needs a schema-lock server
              action (follow-up). */}
          {(schemaLocked || (lockedPropertyIds?.length ?? 0) > 0) && (
            <span
              className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted"
              title={describeLock(lockState)}
              aria-label={describeLock(lockState)}
            >
              <Lock className="h-4 w-4" />
              {describeLock(lockState)}
            </span>
          )}
          {editable && (
            <button
              type="button"
              onClick={addRow}
              title={
                defaultTemplate
                  ? `${t(locale, "newRow")} — ${defaultTemplate.name}`
                  : undefined
              }
              className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-sm text-accent-fg hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              {t(locale, "newRow")}
            </button>
          )}
          {editable && (
            <button
              type="button"
              aria-expanded={deletedRows !== null}
              onClick={() =>
                deletedRows === null ? loadDeletedRows() : setDeletedRows(null)
              }
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-sm text-muted hover:bg-surface-2",
                deletedRows !== null && "bg-surface-2 text-fg",
              )}
            >
              <History className="h-4 w-4" />
              {t(locale, "dbDeletedRows")}
            </button>
          )}
          {editable && templates.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t(locale, "chooseTemplate")}
                  className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted hover:bg-surface-2"
                >
                  <LayoutTemplate className="h-4 w-4" />
                  {t(locale, "templates")}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {templates.map((template) => (
                  <DropdownMenuSub key={template.id}>
                    <DropdownMenuSubTrigger>
                      <span>{template.icon ?? "📄"}</span>
                      <span className="flex-1 truncate">{template.name}</span>
                      {template.isDefault && (
                        <span aria-hidden title={t(locale, "templates")}>
                          ★
                        </span>
                      )}
                      {template.recurrence && (
                        <span className="text-[10px] text-muted">{template.recurrence}</span>
                      )}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onSelect={() => addRowFromTemplate(template)}>
                        {t(locale, "newRow")}
                      </DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>{t(locale, "repeatLabel")}</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {(["daily", "weekly", "monthly"] as const).map((recurrence) => (
                            <DropdownMenuItem
                              key={recurrence}
                              onSelect={() =>
                                startTransition(async () => {
                                  await setTemplateRecurrenceAction(template.id, recurrence);
                                  toast.success(`${t(locale, "repeatsPrefix")} ${recurrence}`);
                                  router.refresh();
                                })
                              }
                            >
                              {recurrence}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuItem
                            onSelect={() =>
                              startTransition(async () => {
                                await setTemplateRecurrenceAction(template.id, null);
                                toast.success(t(locale, "repeatDisabled"));
                                router.refresh();
                              })
                            }
                          >
                            {t(locale, "offWord")}
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-red-600 dark:text-red-400"
                        onSelect={() =>
                          startTransition(async () => {
                            const result = await deleteTemplateAction(template.id);

                            if ("error" in result) toast.error(result.error);
                            else toast.success(`${t(locale, "deletedPrefix")} “${template.name}”`);
                            router.refresh();
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4 text-muted" /> {t(locale, "deleteTemplate")}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {editable && (
            <button
              type="button"
              onClick={() => setAddingProperty((v) => !v)}
              className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted hover:bg-surface-2"
            >
              <Plus className="h-4 w-4" />
              {t(locale, "newProperty")}
            </button>
          )}
          {editable && (
            <button
              type="button"
              onClick={duplicateDatabase}
              className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted hover:bg-surface-2"
            >
              <Copy className="h-4 w-4" />
              {t(locale, "duplicate")}
            </button>
          )}
          <a
            href={`/api/export/database/${databasePageId}`}
            download
            className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted hover:bg-surface-2"
          >
            <Download className="h-4 w-4" />
            {t(locale, "exportCsv")}
          </a>
          {editable && (
            <>
              <button
                type="button"
                onClick={() => csvInputRef.current?.click()}
                className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted hover:bg-surface-2"
              >
                <Upload className="h-4 w-4" />
                {t(locale, "importCsv")}
              </button>
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  file.text().then((text) =>
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
                    }),
                  );
                }}
              />
            </>
          )}
        </div>
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
          className="mb-3 w-full resize-y rounded-lg border border-transparent bg-transparent px-1 py-1 text-sm text-muted outline-none placeholder:text-muted hover:border-border focus:border-border focus:bg-surface"
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
            <button
              type="button"
              aria-label={t(locale, "close")}
              onClick={() => setDeletedRows(null)}
              className="text-muted hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {deletedRows.length === 0 ? (
            <p className="text-sm text-muted">{t(locale, "dbNoDeletedRows")}</p>
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
                    <button
                      type="button"
                      onClick={() => restoreRow(row.id)}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-accent hover:bg-surface-2"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> {t(locale, "restore")}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div onClickCapture={openRowPeekFromClick}>
      {activeView.type === "BOARD" ? (
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
        />
      ) : activeView.type === "CALENDAR" ? (
        <CalendarView
          locale={locale}
          workspaceSlug={workspaceSlug}
          properties={properties}
          rows={viewRows}
          valueFor={valueFor}
        />
      ) : activeView.type === "TIMELINE" ? (
        <TimelineView
          locale={locale}
          workspaceSlug={workspaceSlug}
          properties={properties}
          rows={viewRows}
        />
      ) : activeView.type === "CHART" ? (
        <ChartView
          locale={locale}
          properties={properties}
          rows={viewRows}
          groupByPropertyId={viewConfig.groupByPropertyId}
          chartType={chartType}
          aggregateFn={chartAggregate}
        />
      ) : activeView.type === "FORM" ? (
        <FormView
          locale={locale}
          properties={properties}
          config={formConfig}
          // A read-only database shows the questions without a submit seam,
          // matching how every other view omits its editors when not editable.
          onSubmit={editable ? submitForm : undefined}
        />
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
            setPromptState({ kind: "deleteProperty", property: target });
          }}
          onReorderProperty={onReorderProperty}
          rowOrder={rowOrder}
          onReorderRows={onReorderRows}
          rowColorRules={rowColorRules}
          onRenameProperty={renameProperty}
          onDuplicateProperty={duplicateProperty}
          footer={tableFooter}
        />
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
          {t(locale, "dbScaffoldA")} {activeView.name} {t(locale, "dbScaffoldB")}
        </p>
      )}
      </div>

      {addingProperty && (
        <AddPropertyForm
          databasePageId={databasePageId}
          locale={locale}
          onClose={() => setAddingProperty(false)}
        />
      )}

      {peek && (
        <aside
          className="fixed inset-y-0 right-0 z-40 w-[26rem] overflow-y-auto border-l border-border bg-bg p-5 shadow-2xl"
          aria-label={t(locale, "rowLabel")}
        >
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              {t(locale, "rowLabel")}
            </p>
            <div className="flex items-center gap-3">
              <Link
                href={`/w/${workspaceSlug}/${peek.id}`}
                title={t(locale, "openAsPage")}
                // Navigating away should not leave the drawer hanging over the
                // row's page.
                onClick={() => setPeek(null)}
                className="text-xs text-accent hover:underline"
              >
                {t(locale, "openAsPage")}
              </Link>
              <button
                type="button"
                aria-label={t(locale, "closeSidePeek")}
                onClick={() => setPeek(null)}
                className="text-muted hover:text-fg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <h2 className="mb-4 text-xl font-semibold">
            {peek.icon ? `${peek.icon} ` : ""}
            {peek.title || t(locale, "untitled")}
          </h2>
          {/* R89.31 — the open row's dependency indicator: what blocks it and
              what it blocks, resolved to titles where the view has them. Blank
              (and rendered nothing) until the caller supplies edges. */}
          {dependencySummary(peek.id) !== "" && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-muted">
              <Ban className="h-3.5 w-3.5" aria-hidden />
              <span>{dependencySummary(peek.id)}</span>
            </p>
          )}
          {blockersOf(dependencyGraph, peek.id).length > 0 && (
            <p className="mb-2 text-xs text-muted">
              {t(locale, "relationBlockedBy")}:{" "}
              {blockersOf(dependencyGraph, peek.id)
                .map((id) => rowsById.get(id)?.title ?? id)
                .join(", ")}
            </p>
          )}
          {/* R89.30 — fold this row's sub-items. No-op until rows carry a
              `parentId`, at which point the toggle (and the table/list tree)
              light up together. Only offered while the nesting toggle is on. */}
          {nestSubItems && subItemChildrenOf(subItemRows, peek.id).length > 0 && (
            <button
              type="button"
              onClick={() => toggleSubItemCollapse(peek.id)}
              className="mb-2 flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  !collapsedSubItemIds.has(peek.id) && "rotate-90",
                )}
              />
              {collapsedSubItemIds.has(peek.id)
                ? t(locale, "toggleExpand")
                : t(locale, "toggleCollapse")}{" "}
              ({subItemChildrenOf(subItemRows, peek.id).length}{" "}
              {t(locale, "subTicketMany")})
            </button>
          )}
          {/* Properties panel: one labelled row per property, editable in
              place — computed values (formula, rollup, system) stay read-only. */}
          <dl className="divide-y divide-border border-t border-border text-sm">
            {properties.map((property) => {
              const computed = computedFor(peek, property);
              const isPrimary = property.id === primary?.id;
              return (
                <div
                  key={property.id}
                  className="grid grid-cols-[7.5rem_1fr] items-start gap-3 py-2"
                >
                  <dt
                    className="flex items-center gap-1.5 truncate text-muted"
                    title={property.name}
                  >
                    <span aria-hidden>{propertyIcon(property.type)}</span>
                    <span className="truncate">{property.name}</span>
                  </dt>
                  <dd className="min-w-0">
                    {isPrimary ? (
                      <input
                        defaultValue={peek.title}
                        aria-label={t(locale, "nameLabel")}
                        readOnly={!editable}
                        placeholder={t(locale, "untitled")}
                        onBlur={(event) =>
                          event.target.value !== peek.title &&
                          setPrimary(peek, event.target.value)
                        }
                        className="w-full bg-transparent outline-none placeholder:text-muted"
                      />
                    ) : computed !== undefined ? (
                      <span className="text-muted">{computed}</span>
                    ) : (
                      <Cell
                        locale={locale}
                        property={property}
                        value={valueFor(peek, property.id)}
                        relationOptions={relationOptionsFor(property.id)}
                        peopleOptions={members ?? []}
                        workspaceId={workspaceId}
                        editable={editable}
                        onChange={(value) => setValue(peek.id, property.id, value)}
                      />
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </aside>
      )}

      <Dialog
        open={optionsEditor !== null}
        onOpenChange={(next) => {
          if (!next) setOptionsEditor(null);
        }}
      >
        {optionsEditor && (
          <PropertyOptionsEditor
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
              : promptState?.kind === "deleteProperty"
                ? `${t(locale, "deleteProperty")}: ${promptState.property.name}`
                : t(locale, "configureButton")
        }
        description={
          promptState?.kind === "formula"
            ? `Available: prop("Name"), + - * / %, if(), concat(), round(), min(), max(), length(), upper(), lower(), contains(), empty()`
            : promptState?.kind === "renameView"
              ? undefined
              : promptState?.kind === "deleteProperty"
                ? t(locale, "deletePropWarn")
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
              : promptState?.kind === "deleteProperty"
                ? []
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
              : promptState?.kind === "deleteProperty"
                ? t(locale, "deleteProperty")
                : t(locale, "saveButton")
        }
        onSubmit={(values) => {
          if (!promptState) return;
          if (promptState.kind === "formula") onEditFormula(promptState.property, values.expression);
          else if (promptState.kind === "renameView") renameView(promptState.view, values.name);
          else if (promptState.kind === "deleteProperty") {
            const target = promptState.property;
            startTransition(async () => {
              const result = await deletePropertyAction(target.id);
              if ("error" in result) toast.error(result.error);
              else toast.success(`${t(locale, "deletedPrefix")} “${target.name}”`);
              router.refresh();
            });
          } else onConfigureButton(promptState.property, values.target, values.value);
        }}
        onClose={() => setPromptState(null)}
      />
    </div>
  );
}

function ViewIcon({ type }: { type: string }) {
  const map: Record<string, string> = {
    TABLE: "⊞",
    BOARD: "▤",
    LIST: "☰",
    GALLERY: "▦",
    CALENDAR: "🗓",
    TIMELINE: "⟷",
    CHART: "📈",
    FORM: "📝",
  };
  return <span className="text-xs text-muted">{map[type] ?? "⊞"}</span>;
}

"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { PromptDialog } from "@/components/prompt-dialog";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Copy,
  Download,
  Ellipsis,
  History,
  LayoutTemplate,
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
import type { RowColorRule } from "@/lib/row-color-rules";
import { mergeLayout, type ColumnLayout } from "@/lib/column-layout";
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
  const pendingConfig = useRef<ViewConfig | undefined>(undefined);
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

  const setViewConfig = (patch: Partial<ViewConfig>) => {
    if (!activeView) return;
    // Two config writes in quick succession used to race: the second one was
    // built from props the server had not re-delivered yet and silently
    // reverted the first (e.g. change a sort direction, add a second sort →
    // the direction came back). Build each patch on the latest *intended*
    // config instead of the last rendered one.
    const base = pendingConfig.current ?? viewConfig;
    const next = { ...base, ...patch };
    pendingConfig.current = next;
    startTransition(async () => {
      const result = await updateViewAction(activeView.id, { config: next });
      if ("error" in result) toast.error(result.error);
      router.refresh();
    });
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
        />
      ) : activeView.type === "LIST" ? (
        <ListView
            locale={locale}
          workspaceSlug={workspaceSlug}
          properties={properties}
          rows={viewRows}
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
          properties={properties}
          rows={viewRows}
          primary={primary}
          editable={editable}
          config={viewConfig}
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
          onConfigureButton={(property) => setPromptState({ kind: "button", property })}
          onOpenPeek={setPeek}
          onRunAi={onRunAi}
          colorOf={colorOf}
          onEditFormula={(property) => setPromptState({ kind: "formula", property })}
          onSetFormat={onSetFormat}
          onEditOptions={(property) => setOptionsEditor(property)}
          editingProperty={editingProperty}
          setEditingProperty={setEditingProperty}
          onDeleteProperty={(id) => {
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
          onRenameProperty={(id, name) =>
            startTransition(async () => {
              await updatePropertyAction(id, { name });
              setEditingProperty(null);
              router.refresh();
            })
          }
          onDuplicateProperty={(p) =>
            startTransition(async () => {
              await createPropertyAction(
                databasePageId,
                `${p.name} copy`,
                p.type,
              );
              router.refresh();
            })
          }
        />
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
          {t(locale, "dbScaffoldA")} {activeView.name} {t(locale, "dbScaffoldB")}
        </p>
      )}

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

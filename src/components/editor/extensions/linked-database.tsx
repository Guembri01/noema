"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { ExternalLink, ListFilter, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import {
  addSort as appendSort,
  applyView,
  formatCell,
  normalizeViewConfig,
  operatorsFor,
  removeSort,
  type FilterOperator,
  type QueryProperty,
  type QueryRow,
  type Sort,
  type ViewConfig,
} from "@/lib/database-query";
import { t } from "@/lib/i18n";
import {
  canWriteLinkedRows,
  convertMode,
  createLinkedView,
  describeLinkedView,
  resolveViewConfig as resolveLinkedViewConfig,
  validateLinkedView,
  type LinkedView,
  type LinkedViewMode,
  type LinkedViewOverrides,
} from "@/lib/linked-view";
import {
  addFilterLeaf,
  clearFilterAndSortOverrides,
  filterBuilderFromConfig,
  filterLeaves,
  removeFilterLeaf,
  setFilterMatch,
  updateFilterLeaf,
} from "@/lib/linked-overrides";
import type { FilterGroup, FilterLeaf } from "@/lib/filter-tree-ui";
import { guarded } from "@/lib/actions-client";
import { createRowAction } from "@/server/actions/database";
import {
  DEFAULT_ROW_HEIGHT,
  parseInlineDatabaseBlock,
  resolveShell,
  rowWindow,
  type InlineDatabaseBlock,
  type InlineDisplay,
  type RowWindow,
  type ShellLayout,
} from "@/lib/inline-database";
import {
  CARD_SIZES,
  cardFieldOrder,
  cardSizeFor,
  listRowModel,
  resolveCardPreview,
  type ViewPropertyLike,
  type ViewRowLike,
} from "@/lib/view-presets";
import {
  getLinkedDatabaseAction,
  listDatabasesAction,
  type LinkedDatabaseData,
} from "@/server/actions/linked-database";

// Transport failures become `{ error }` values, matching the action's own
// refusal shape. The audit gate treats a `guarded(...)` wrapper as adopted.
const createLinkedRow = guarded(createRowAction);

// The row editor reuses the full database `Cell` (every property type). It is
// split out so the editor route does not pay for that surface until a reader
// actually opens a row.
const LinkedRowEditor = dynamic(
  () =>
    import("./linked-row-editor").then((module) => ({
      default: module.LinkedRowEditor,
    })),
  {
    ssr: false,
    loading: () => (
      <span className="noema-linked-loading">
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
    ),
  },
);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    linkedDatabase: {
      setLinkedDatabase: (attrs?: {
        databasePageId?: string;
        title?: string;
      }) => ReturnType;
    };
  }
}

export type LinkedDatabaseOptions = {
  workspaceId: string;
  workspaceSlug: string;
  locale: string;
};

/**
 * Embed a read-only view of another database inside a page ("linked database").
 * Data is fetched on demand so the embedded view stays in sync with the source.
 */
export const LinkedDatabase = Node.create<LinkedDatabaseOptions>({
  name: "linkedDatabase",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { workspaceId: "", workspaceSlug: "", locale: "en" };
  },

  addAttributes() {
    return {
      databasePageId: { default: null },
      title: { default: null },
      /** `@/lib/linked-view` mode for this instance: "synced" | "detached". */
      mode: { default: "synced", rendered: false },
      /** The bound source view (`@/lib/linked-view` `sourceViewId`). */
      sourceViewId: { default: null, rendered: false },
      /** Per-instance display overrides (`@/lib/linked-view` `overrides`). */
      overrides: { default: null, rendered: false },
      /** Rows the inline shell grows to before scrolling (`@/lib/inline-database`). */
      maxRows: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-linked-database]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-linked-database": "" })];
  },

  addCommands() {
    return {
      setLinkedDatabase:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(LinkedDatabaseView);
  },
});

/**
 * fix04 — additive bridges onto `@/lib/linked-view` (per-instance identity,
 * synced/detached mode, view-config merge) and `@/lib/inline-database` (the
 * height/scroll shell + row window). Exported pure so the mappings are
 * node-testable; `LinkedDatabaseView` is the only caller.
 */

/** The inline display a source view type maps to (unknown → `table`). */
export function inlineDisplayFor(viewType: string | null | undefined): InlineDisplay {
  switch ((viewType ?? "").toUpperCase()) {
    case "LIST":
      return "list";
    case "BOARD":
      return "board";
    case "GALLERY":
      return "gallery";
    case "CALENDAR":
      return "calendar";
    case "TIMELINE":
      return "timeline";
    case "CHART":
      return "chart";
    default:
      return "table";
  }
}

/** Keep only defined override values; anything non-object yields `{}`. */
function sanitizeOverrides(value: unknown): LinkedViewOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: LinkedViewOverrides = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    (out as Record<string, unknown>)[key] = entry;
  }
  return out;
}

export type LinkedEmbedInput = {
  instanceId: string;
  databaseId: string;
  sourceViewId?: string | null;
  mode?: string | null;
  overrides?: unknown;
  sourceConfig?: ViewConfig | null;
  sourceViewType?: string | null;
  display?: InlineDisplay | null;
  maxRows?: number | null;
  contentHeight: number;
  viewportHeight: number;
  scrollTop?: number;
  rowHeight?: number;
  overscan?: number;
};

export type LinkedEmbedModel = {
  linked: LinkedView;
  /** The effective `ViewConfig` after merging overrides over the source. */
  effective: ViewConfig;
  valid: boolean;
  block: InlineDatabaseBlock;
  display: InlineDisplay;
  shell: ShellLayout;
  window: RowWindow;
};

/**
 * Resolve an embed's identity, effective view config and inline shell from the
 * node's attributes and the source view. Identity + mode + overrides go through
 * `createLinkedView`/`resolveViewConfig`/`validateLinkedView`; the shell height,
 * scroll/virtual flags and visible row window go through
 * `parseInlineDatabaseBlock`/`resolveShell`/`rowWindow`.
 */
export function linkedEmbedModel(input: LinkedEmbedInput): LinkedEmbedModel {
  const linked = createLinkedView({
    instanceId: input.instanceId,
    databaseId: input.databaseId,
    ...(input.sourceViewId ? { sourceViewId: input.sourceViewId } : {}),
    ...(input.mode === "detached" ? { mode: "detached" as LinkedViewMode } : {}),
  });
  const instance: LinkedView = {
    ...linked,
    overrides: sanitizeOverrides(input.overrides),
  };
  const effective = resolveLinkedViewConfig(input.sourceConfig ?? null, instance);
  const validation = validateLinkedView(instance, { exists: () => true });

  const display = input.display ?? inlineDisplayFor(input.sourceViewType ?? null);
  const parsed = parseInlineDatabaseBlock({
    id: input.instanceId,
    databaseId: input.databaseId,
    ...(input.sourceViewId ? { viewId: input.sourceViewId } : {}),
    display,
    heightMode: "auto",
    ...(typeof input.maxRows === "number" ? { maxRows: input.maxRows } : {}),
  });
  const block: InlineDatabaseBlock = parsed ?? {
    id: input.instanceId,
    databaseId: input.databaseId,
    display,
    heightMode: "auto",
  };
  const shell = resolveShell(block, {
    contentHeight: input.contentHeight,
    viewportHeight: input.viewportHeight,
  });
  const window = rowWindow(block, {
    scrollTop: input.scrollTop ?? 0,
    rowHeight: input.rowHeight ?? DEFAULT_ROW_HEIGHT,
    ...(input.overscan === undefined ? {} : { overscan: input.overscan }),
  });

  return { linked: instance, effective, valid: validation.valid, block, display, shell, window };
}

/** Flip an instance between synced and detached through `convertMode`. */
export function toggleLinkedMode(
  linked: LinkedView,
  sourceConfig: ViewConfig | null | undefined,
): LinkedView {
  return convertMode(linked, linked.mode === "synced" ? "detached" : "synced", sourceConfig);
}

/**
 * Apply a source view's saved filters/sorts to the linked rows, preserving the
 * original row objects (and their `values` maps) in the returned order. A
 * linked view is a real view: a filter that hides a row in the database must
 * hide it in the embed too.
 */
export function linkedRowsForView(
  rows: LinkedDatabaseData["rows"],
  properties: LinkedDatabaseData["properties"],
  config: ViewConfig | null,
): LinkedDatabaseData["rows"] {
  if (!config) return rows;
  const queryProperties: QueryProperty[] = properties.map((property) => ({
    id: property.id,
    name: property.name,
    type: property.type,
    config: (property.config ?? null) as QueryProperty["config"],
  }));
  const queryRows: QueryRow[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    icon: row.icon,
    propertyValues: Object.entries(row.values).map(([propertyId, value]) => ({
      propertyId,
      value,
    })),
  }));
  const ordered = applyView(queryRows, queryProperties, config).rows;
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  return ordered
    .map((row) => byId.get(row.id))
    .filter((row): row is LinkedDatabaseData["rows"][number] => row !== undefined);
}

function LinkedDatabaseView({ node, updateAttributes, deleteNode, extension }: NodeViewProps) {
  const options = extension.options as LinkedDatabaseOptions;
  const locale = options.locale ?? "en";
  const databasePageId = node.attrs.databasePageId as string | null;
  const [query, setQuery] = useState("");
  const [options_, setOptions] = useState<{ id: string; title: string; icon: string | null }[]>([]);
  // The candidate list starts out "loading" because the picker is the first
  // thing an unbound node renders; it is cleared once the action settles so the
  // picker never flashes the "no databases" empty state before the fetch.
  const [optionsLoading, setOptionsLoading] = useState(true);
  // Repointing keeps the current `databasePageId` while the picker is open, so a
  // cancelled change preserves the rendered view instead of dropping the link.
  const [picking, setPicking] = useState(false);
  const [data, setData] = useState<LinkedDatabaseData | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Gallery card preview: the size follows the measured body width, mirroring
  // `GalleryView` (the initial width of 0 keeps server and client identical).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    // Candidates are only needed while the picker is visible: for a brand-new
    // node (no id yet) and while the user is repointing an existing one.
    if (databasePageId && !picking) return;
    let cancelled = false;
    setOptionsLoading(true);
    listDatabasesAction(options.workspaceId)
      .then((found) => {
        if (!cancelled) setOptions(found);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [databasePageId, picking, options.workspaceId]);

  useEffect(() => {
    if (!databasePageId) return;
    let cancelled = false;
    setLoading(true);
    getLinkedDatabaseAction(databasePageId)
      .then((result) => {
        if (cancelled) return;
        if ("error" in result) {
          setData(null);
        } else {
          setData(result);
          updateAttributes({ title: result.title });
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databasePageId, reloadKey]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [data]);

  if (!databasePageId || picking) {
    const filtered = options_.filter((option) =>
      option.title.toLowerCase().includes(query.toLowerCase()),
    );
    return (
      <NodeViewWrapper className="noema-linked-db" data-linked-database="">
        <div className="noema-linked-picker" contentEditable={false}>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Escape abandons a repoint, leaving the node bound to its current
              // database (a fresh, unbound node has nothing to cancel back to).
              if (event.key === "Escape" && picking) {
                event.preventDefault();
                setQuery("");
                setPicking(false);
              }
            }}
            placeholder={t(locale, "linkedLinkPlaceholder")}
            className="noema-linked-field"
          />
          <div className="noema-linked-results" aria-busy={optionsLoading}>
            {filtered.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-current={option.id === databasePageId ? "true" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  // Binds a fresh node or repoints an existing one; the read
                  // path resolves the canonical title through
                  // `getLinkedDatabaseAction` once the id lands.
                  setQuery("");
                  setPicking(false);
                  updateAttributes({
                    databasePageId: option.id,
                    title: option.title,
                    sourceViewId: null,
                    mode: "synced",
                    overrides: null,
                  });
                }}
                className="noema-linked-result"
              >
                <span>{option.icon ?? "🗂️"}</span>
                <span className="truncate">{option.title || t(locale, "untitled")}</span>
              </button>
            ))}
            {optionsLoading ? (
              <p className="noema-linked-empty">
                <Loader2 className="h-4 w-4 animate-spin" /> {t(locale, "loading")}
              </p>
            ) : (
              filtered.length === 0 && (
                <p className="noema-linked-empty">{t(locale, "linkedNoDatabases")}</p>
              )
            )}
          </div>
        </div>
      </NodeViewWrapper>
    );
  }

  const primary = data?.properties[0];
  // Bind to the node's source view, falling back to the source's first view
  // when that id is stale or absent. The chosen view's filters/sorts run
  // through the same `applyView` engine as a full database page.
  const sourceView =
    data?.views.find((view) => view.id === node.attrs.sourceViewId) ?? data?.views[0] ?? null;
  const sourceConfig = sourceView ? normalizeViewConfig(sourceView.config) : null;
  // The first pass resolves the instance's effective config (source + local
  // overrides). The second pass sizes the scroll shell from the rows that
  // config actually selects: a detached filter that hides half the source must
  // also shrink the embed instead of leaving dead scroll space.
  const sizingEmbed = linkedEmbedModel({
    instanceId: databasePageId,
    databaseId: databasePageId,
    sourceViewId: sourceView?.id ?? null,
    mode: node.attrs.mode as string | null,
    overrides: node.attrs.overrides,
    sourceConfig,
    sourceViewType: sourceView?.type ?? null,
    maxRows: typeof node.attrs.maxRows === "number" ? (node.attrs.maxRows as number) : 20,
    contentHeight: 0,
    viewportHeight: 0,
    overscan: 0,
  });
  const sourceRows = linkedRowsForView(
    data?.rows ?? [],
    data?.properties ?? [],
    sizingEmbed.effective,
  );
  const embed = linkedEmbedModel({
    instanceId: databasePageId,
    databaseId: databasePageId,
    sourceViewId: sourceView?.id ?? null,
    mode: node.attrs.mode as string | null,
    overrides: node.attrs.overrides,
    sourceConfig,
    sourceViewType: sourceView?.type ?? null,
    maxRows: typeof node.attrs.maxRows === "number" ? (node.attrs.maxRows as number) : 20,
    contentHeight: sourceRows.length * DEFAULT_ROW_HEIGHT,
    viewportHeight: 0,
    overscan: 0,
  });
  const visibleRows = sourceRows.slice(embed.window.start, embed.window.end);
  const canWrite = canWriteLinkedRows(embed.linked.mode, data?.canEdit === true);
  const editingRow = data?.rows.find((row) => row.id === editingRowId) ?? null;
  const filterTree = filterBuilderFromConfig(embed.effective);
  const overrideSorts = embed.effective.sorts ?? [];
  // A per-instance override of `visiblePropertyIds` narrows the embed; with no
  // source config (and so no override) every property renders, as before.
  const effectiveIds = embed.effective.visiblePropertyIds;
  const visibleProperties =
    effectiveIds === undefined
      ? data?.properties ?? []
      : (data?.properties ?? []).filter(
          (property) => property.id === primary?.id || effectiveIds.includes(property.id),
        );
  // The source database's first view decides how the embed renders. `table` and
  // `list` get their own read-only renderers below; `gallery` (and any other or
  // absent view type — board, calendar, …) uses the card grid this node has
  // always rendered.
  const firstViewType = sourceView?.type?.toUpperCase();
  const viewMode: "table" | "list" | "gallery" =
    firstViewType === "TABLE" ? "table" : firstViewType === "LIST" ? "list" : "gallery";
  // The shared view-presets engine reads lower-case property types (e.g.
  // "files"), matching `COVER_PROPERTY_TYPES`; the linked-database payload
  // stores them upper-case.
  const presetProperties: ViewPropertyLike[] = visibleProperties.map(
    (property) => ({
      id: property.id,
      name: property.name,
      type: property.type.toLowerCase(),
    }),
  );
  // The cover is the first files property, exactly as the database `GalleryView`
  // picks it; `resolveCardPreview` decides whether it renders or falls back to
  // the row icon.
  const coverPropertyId =
    data?.properties.find((property) => property.type === "FILES")?.id ?? null;
  // Size follows the measured container: `cardSizeFor` chooses a preset and
  // `CARD_SIZES` supplies the column count, cover aspect and whether the cover
  // is shown at all.
  const size = cardSizeFor(containerWidth);
  const spec = CARD_SIZES[size];
  // Fields are the schema order minus the card's title (the first property) and
  // the cover, capped by the preset exactly like `GalleryView`.
  const cardFields = cardFieldOrder(
    presetProperties.filter((property) => property.id !== primary?.id),
    { previewPropertyId: coverPropertyId, maxFields: spec.showPreview ? 3 : 4 },
  )
    .map((id) => data?.properties.find((property) => property.id === id))
    .filter(
      (property): property is LinkedDatabaseData["properties"][number] =>
        property !== undefined,
    );
  const overrides = sanitizeOverrides(node.attrs.overrides);

  const updateOverrides = (next: LinkedViewOverrides) => {
    setWriteError(null);
    updateAttributes({ overrides: next });
  };

  const applyViewSettings = (nextTree: FilterGroup, nextSorts: Sort[]) => {
    updateOverrides({
      ...overrides,
      filterBuilder: nextTree,
      sorts: nextSorts,
    });
  };

  const createRow = async () => {
    setCreating(true);
    setWriteError(null);
    const result = await createLinkedRow(databasePageId);
    if ("error" in result) {
      setWriteError(result.error);
      setCreating(false);
      return;
    }
    // Read once so the new empty row is present before the editor opens. The
    // block remains usable if that read fails; the next explicit reload will
    // pick the row up.
    const refreshed = await getLinkedDatabaseAction(databasePageId);
    if ("error" in refreshed) {
      setWriteError(refreshed.error);
      setReloadKey((key) => key + 1);
    } else {
      setData(refreshed);
      setEditingRowId(result.id);
    }
    setCreating(false);
  };

  return (
    <NodeViewWrapper className="noema-linked-db" data-linked-database="">
      <div className="noema-linked-shell">
        <div className="noema-linked-header" contentEditable={false}>
          <span className="noema-linked-title" title={describeLinkedView(embed.linked)}>
            {data?.icon ?? "🗂️"}{" "}
            {String(node.attrs.title ?? data?.title ?? t(locale, "linkedDatabaseFallback"))}
          </span>
          {data && data.views.length > 0 && (
            <select
              aria-label={t(locale, "linkedViewLabel")}
              className="noema-linked-open noema-linked-view"
              value={sourceView?.id ?? ""}
              onChange={(event) => {
                // Rebinding starts from the source again: a detached instance
                // must not carry the previous view's filters into the new one.
                updateAttributes({
                  sourceViewId: event.target.value,
                  mode: "synced",
                  overrides: null,
                });
              }}
            >
              {data.views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name || t(locale, "untitled")}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            aria-pressed={embed.linked.mode === "detached"}
            aria-label={t(locale, "syncedViewHint")}
            title={t(locale, "syncedViewHint")}
            onClick={() => {
              const next = toggleLinkedMode(embed.linked, embed.effective);
              updateAttributes({ mode: next.mode, overrides: next.overrides });
            }}
            className="noema-linked-open"
          >
            {embed.linked.mode}
          </button>
          {embed.linked.mode === "detached" && data && (
            <button
              type="button"
              aria-pressed={settingsOpen}
              aria-label={`${t(locale, "dbFilter")} / ${t(locale, "dbSort")}`}
              title={`${t(locale, "dbFilter")} / ${t(locale, "dbSort")}`}
              onClick={() => setSettingsOpen((open) => !open)}
              className="noema-linked-open inline-flex items-center gap-1"
            >
              <ListFilter className="h-3.5 w-3.5" />
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              aria-label={t(locale, "newRow")}
              title={t(locale, "newRow")}
              disabled={creating}
              onClick={() => void createRow()}
              className="noema-linked-open inline-flex items-center gap-1"
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <a
            href={`/w/${options.workspaceSlug}/${databasePageId}`}
            className="noema-linked-open"
            aria-label={t(locale, "linkedOpenAria")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            aria-label={t(locale, "linkedChangeAria")}
            onClick={() => {
              // Repoint in place: keep the current id so the view survives a
              // cancelled change; the picker replaces it only on selection.
              setQuery("");
              setPicking(true);
            }}
            className="noema-linked-open"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t(locale, "linkedRemoveAria")}
            onClick={() => deleteNode()}
            className="noema-linked-open"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        {writeError && (
          <p role="alert" className="noema-linked-empty border-t border-border px-3 py-2">
            {writeError}
          </p>
        )}
        {settingsOpen && embed.linked.mode === "detached" && data && (
          <LinkedViewSettingsPanel
            locale={locale}
            properties={data.properties}
            builder={filterTree}
            sorts={overrideSorts}
            onChange={applyViewSettings}
            onReset={() => updateOverrides(clearFilterAndSortOverrides(overrides))}
          />
        )}
        <div
          className="noema-linked-body"
          contentEditable={false}
          data-view-mode={viewMode}
          style={{
            height: embed.shell.heightCss,
            overflowY: embed.shell.scroll ? "auto" : undefined,
          }}
        >
          {loading ? (
            <span className="noema-linked-loading">
              <Loader2 className="h-4 w-4 animate-spin" /> {t(locale, "loading")}
            </span>
          ) : !data ? (
            <p className="noema-linked-empty">{t(locale, "linkedLoadFailed")}</p>
          ) : data.rows.length === 0 ? (
            <p className="noema-linked-empty">{t(locale, "dbNoRows")}</p>
          ) : viewMode === "table" ? (
            <LinkedTableView
              locale={locale}
              columns={visibleProperties}
              rows={visibleRows}
              primaryId={primary?.id ?? null}
              canWrite={canWrite}
              onEdit={(rowId) => setEditingRowId(rowId)}
            />
          ) : viewMode === "list" ? (
            <LinkedListView
              locale={locale}
              properties={presetProperties}
              rows={visibleRows}
              canWrite={canWrite}
              onEdit={(rowId) => setEditingRowId(rowId)}
            />
          ) : (
            <div
              ref={containerRef}
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}
              data-card-size={size}
            >
              {visibleRows.map((row) => {
                const viewRow: ViewRowLike = {
                  id: row.id,
                  title: row.title,
                  icon: row.icon,
                  propertyValues: Object.entries(row.values).map(
                    ([propertyId, value]) => ({ propertyId, value }),
                  ),
                };
                const preview = resolveCardPreview(viewRow, presetProperties, {
                  coverPropertyId,
                });
                return (
                  <div
                    key={row.id}
                    className="relative overflow-hidden rounded-lg border border-border bg-bg"
                  >
                    {canWrite && (
                      <button
                        type="button"
                        aria-label={t(locale, "edit")}
                        title={t(locale, "edit")}
                        onClick={() => setEditingRowId(row.id)}
                        className="noema-linked-open absolute right-1 top-1 bg-bg/80 backdrop-blur"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {spec.showPreview && (
                      <div
                        className="grid place-items-center overflow-hidden bg-surface text-3xl"
                        style={{ aspectRatio: spec.aspect }}
                      >
                        {preview.kind === "cover" ? (
                          /* eslint-disable-next-line @next/next/no-img-element -- raw attachment URLs are not statically analysable for next/image */
                          <img
                            src={preview.value}
                            alt={row.title}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          preview.value ?? row.icon ?? "🗂️"
                        )}
                      </div>
                    )}
                    <div className="space-y-1 p-3">
                      <p className="truncate text-sm font-medium">
                        {!spec.showPreview && <span className="mr-1">{row.icon ?? "🗂️"}</span>}
                        {row.title || t(locale, "untitled")}
                      </p>
                      <dl className="space-y-0.5">
                        {cardFields.map((property) => (
                          <div
                            key={property.id}
                            className="flex items-center justify-between gap-2 text-xs text-muted"
                          >
                            <dt className="truncate">{property.name}</dt>
                            <dd className="truncate">
                              {formatCell(
                                row.values[property.id],
                                {
                                  id: property.id,
                                  name: property.name,
                                  type: property.type,
                                  config: (property.config ?? null) as QueryProperty["config"],
                                } as QueryProperty,
                              ) || "—"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {editingRow && data && (
        <LinkedRowEditor
          row={editingRow}
          data={data}
          workspaceId={options.workspaceId}
          locale={locale}
          onClose={() => setEditingRowId(null)}
          onSaved={() => setReloadKey((key) => key + 1)}
          onDeleted={() => {
            const deletedId = editingRow.id;
            setEditingRowId(null);
            setData((current) =>
              current
                ? {
                    ...current,
                    rows: current.rows.filter((candidate) => candidate.id !== deletedId),
                  }
                : current,
            );
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

/** One fetched linked-database row, as exposed by the server action. */
type LinkedDatabaseRow = LinkedDatabaseData["rows"][number];

/** Reduce a fetched row to the shared `ViewRowLike` shape the presets read. */
function toViewRow(row: LinkedDatabaseRow): ViewRowLike {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    propertyValues: Object.entries(row.values).map(([propertyId, value]) => ({
      propertyId,
      value,
    })),
  };
}

/**
 * Read-only table mode, used when the source database's first view is a table.
 * The primary property (the first in schema order, matching the card grid's
 * title) renders the row's page title; every other cell formats through the
 * shared `formatCell` engine, so the embed shows the same text a full table
 * view would.
 */
function LinkedTableView({
  locale,
  columns,
  rows,
  primaryId,
  canWrite,
  onEdit,
}: {
  locale: string;
  columns: { id: string; name: string; type: string }[];
  rows: readonly LinkedDatabaseRow[];
  primaryId: string | null;
  canWrite: boolean;
  onEdit: (rowId: string) => void;
}) {
  return (
    <table className="noema-linked-table">
      <thead>
        <tr>
          {columns.map((property) => (
            <th key={property.id}>{property.name}</th>
          ))}
          {canWrite && <th aria-label={t(locale, "edit")} />}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            {columns.map((property) => (
              <td key={property.id}>
                {property.id === primaryId
                  ? `${row.icon ? `${row.icon} ` : ""}${row.title || t(locale, "untitled")}`
                  : formatCell(
                      row.values[property.id],
                      {
                        id: property.id,
                        name: property.name,
                        type: property.type,
                        config: null,
                      } as QueryProperty,
                    ) || "—"}
              </td>
            ))}
            {canWrite && (
              <td className="w-8">
                <button
                  type="button"
                  aria-label={t(locale, "edit")}
                  title={t(locale, "edit")}
                  onClick={() => onEdit(row.id)}
                  className="noema-linked-open"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The in-block filter/sort editor for a detached linked instance. It edits the
 * instance's `overrides` only; the source view is never written. Filters use
 * the persisted AND/OR builder shape, which wins over the source's other filter
 * shapes in the shared query engine.
 */
function LinkedViewSettingsPanel({
  locale,
  properties,
  builder,
  sorts,
  onChange,
  onReset,
}: {
  locale: string;
  properties: LinkedDatabaseData["properties"];
  builder: FilterGroup;
  sorts: readonly Sort[];
  onChange: (builder: FilterGroup, sorts: Sort[]) => void;
  onReset: () => void;
}) {
  const leaves = filterLeaves(builder);
  const firstProperty = properties[0] ?? null;
  const noValue = new Set<FilterOperator>([
    "is_empty",
    "is_not_empty",
    "checked",
    "unchecked",
  ]);
  const propertyFor = (propertyId: string) =>
    properties.find((property) => property.id === propertyId) ?? null;
  const defaultOperator = (type: string): FilterOperator =>
    (operatorsFor(type)[0]?.value as FilterOperator | undefined) ?? "is";

  const addFilter = () => {
    if (!firstProperty) return;
    const op = defaultOperator(firstProperty.type);
    onChange(
      addFilterLeaf(builder, {
        propertyId: firstProperty.id,
        op,
        ...(noValue.has(op) ? {} : { value: "" }),
      }),
      [...sorts],
    );
  };

  const changeFilter = (leaf: FilterLeaf, patch: Partial<FilterLeaf>) => {
    onChange(updateFilterLeaf(builder, leaf.id, patch), [...sorts]);
  };

  const changeFilterProperty = (leaf: FilterLeaf, propertyId: string) => {
    const property = propertyFor(propertyId);
    if (!property) return;
    const op = defaultOperator(property.type);
    changeFilter(leaf, {
      propertyId,
      op,
      ...(noValue.has(op) ? {} : { value: "" }),
    });
  };

  const changeFilterOperator = (leaf: FilterLeaf, op: FilterOperator) => {
    changeFilter(leaf, {
      op,
      ...(noValue.has(op) ? {} : { value: leaf.value ?? "" }),
    });
  };

  const addSort = () => {
    const used = new Set(sorts.map((sort) => sort.propertyId));
    const candidate = properties.find((property) => !used.has(property.id));
    if (candidate) onChange(builder, appendSort([...sorts], candidate.id, "asc"));
  };

  return (
    <div
      className="space-y-2 border-t border-border px-3 py-2 text-xs"
      data-testid="linked-view-overrides"
      contentEditable={false}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted">{t(locale, "dbFilter")}</span>
        {leaves.length > 1 && (
          <select
            aria-label={t(locale, "filterMatchModeAria")}
            value={builder.op}
            onChange={(event) =>
              onChange(setFilterMatch(builder, event.target.value === "or" ? "or" : "and"), [
                ...sorts,
              ])
            }
            className="h-7 rounded-control border border-border bg-bg px-1"
          >
            <option value="and">AND</option>
            <option value="or">OR</option>
          </select>
        )}
        <button
          type="button"
          onClick={addFilter}
          disabled={!firstProperty}
          className="noema-linked-open ml-auto inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          {t(locale, "add")}
        </button>
      </div>
      {leaves.map((leaf) => {
        const property = propertyFor(leaf.propertyId);
        const operators = property ? operatorsFor(property.type) : [];
        return (
          <div key={leaf.id} className="flex flex-wrap items-center gap-1">
            <select
              aria-label={t(locale, "properties")}
              value={leaf.propertyId}
              onChange={(event) => changeFilterProperty(leaf, event.target.value)}
              className="h-7 max-w-36 rounded-control border border-border bg-bg px-1"
            >
              {!property && <option value={leaf.propertyId}>{leaf.propertyId}</option>}
              {properties.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <select
              aria-label={t(locale, "filterOperatorAria")}
              value={leaf.op}
              onChange={(event) =>
                changeFilterOperator(leaf, event.target.value as FilterOperator)
              }
              className="h-7 max-w-36 rounded-control border border-border bg-bg px-1"
            >
              {operators.map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {operator.label}
                </option>
              ))}
            </select>
            {!noValue.has(leaf.op) && (
              <input
                aria-label={t(locale, "filterGroupValueAria")}
                value={leaf.value ?? ""}
                onChange={(event) => changeFilter(leaf, { value: event.target.value })}
                className="h-7 min-w-20 flex-1 rounded-control border border-border bg-bg px-1"
              />
            )}
            <button
              type="button"
              aria-label={t(locale, "remove")}
              title={t(locale, "remove")}
              onClick={() => onChange(removeFilterLeaf(builder, leaf.id), [...sorts])}
              className="noema-linked-open"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      <div className="flex items-center gap-2 border-t border-border pt-2">
        <span className="font-medium text-muted">{t(locale, "dbSort")}</span>
        <button
          type="button"
          onClick={addSort}
          disabled={properties.length === 0}
          className="noema-linked-open ml-auto inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          {t(locale, "add")}
        </button>
      </div>
      {sorts.map((sort) => (
        <div key={sort.propertyId} className="flex items-center gap-1">
          <select
            aria-label={t(locale, "properties")}
            value={sort.propertyId}
            onChange={(event) =>
              onChange(
                builder,
                sorts.map((candidate) =>
                  candidate.propertyId === sort.propertyId
                    ? { ...candidate, propertyId: event.target.value }
                    : candidate,
                ),
              )
            }
            className="h-7 min-w-0 flex-1 rounded-control border border-border bg-bg px-1"
          >
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={t(locale, "sortDirection")}
            title={t(locale, "sortDirection")}
            onClick={() =>
              onChange(
                builder,
                sorts.map((candidate) =>
                  candidate.propertyId === sort.propertyId
                    ? {
                        ...candidate,
                        direction: candidate.direction === "asc" ? "desc" : "asc",
                      }
                    : candidate,
                ),
              )
            }
            className="noema-linked-open"
          >
            {sort.direction === "asc" ? "↑" : "↓"}
          </button>
          <button
            type="button"
            aria-label={t(locale, "remove")}
            title={t(locale, "remove")}
            onClick={() => onChange(builder, removeSort([...sorts], sort.propertyId))}
            className="noema-linked-open"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {(leaves.length > 0 || sorts.length > 0) && (
        <button
          type="button"
          onClick={onReset}
          className="noema-linked-open text-xs"
        >
          {t(locale, "clear")}
        </button>
      )}
    </div>
  );
}

/**
 * Read-only list mode, used when the source database's first view is a list.
 * Each row's primary/secondary text comes from the shared `listRowModel`; the
 * embed has no density toolbar, so it picks `comfortable` to surface the first
 * non-empty property value alongside the title.
 */
function LinkedListView({
  locale,
  properties,
  rows,
  canWrite,
  onEdit,
}: {
  locale: string;
  properties: readonly ViewPropertyLike[];
  rows: readonly LinkedDatabaseRow[];
  canWrite: boolean;
  onEdit: (rowId: string) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => {
        const model = listRowModel(toViewRow(row), properties, {
          density: "comfortable",
        });
        return (
          <li key={row.id} className="flex items-center gap-2 py-1.5">
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
            {canWrite && (
              <button
                type="button"
                aria-label={t(locale, "edit")}
                title={t(locale, "edit")}
                onClick={() => onEdit(row.id)}
                className="noema-linked-open shrink-0"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

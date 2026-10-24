"use client";

import { useEffect, useRef, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { ExternalLink, Loader2, Pencil, Trash2 } from "lucide-react";
import {
  applyView,
  formatCell,
  normalizeViewConfig,
  type QueryProperty,
  type QueryRow,
  type ViewConfig,
} from "@/lib/database-query";
import { t } from "@/lib/i18n";
import {
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
  }, [databasePageId]);

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
  const sourceRows = linkedRowsForView(data?.rows ?? [], data?.properties ?? [], sourceConfig);
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
            />
          ) : viewMode === "list" ? (
            <LinkedListView
              locale={locale}
              properties={presetProperties}
              rows={visibleRows}
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
                    className="overflow-hidden rounded-lg border border-border bg-bg"
                  >
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
}: {
  locale: string;
  columns: { id: string; name: string; type: string }[];
  rows: readonly LinkedDatabaseRow[];
  primaryId: string | null;
}) {
  return (
    <table className="noema-linked-table">
      <thead>
        <tr>
          {columns.map((property) => (
            <th key={property.id}>{property.name}</th>
          ))}
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
          </tr>
        ))}
      </tbody>
    </table>
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
}: {
  locale: string;
  properties: readonly ViewPropertyLike[];
  rows: readonly LinkedDatabaseRow[];
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
            <span className="min-w-0">
              <span className="block truncate text-sm">
                {model.primary || t(locale, "untitled")}
              </span>
              {model.expanded && model.secondary && (
                <span className="block truncate text-xs text-muted">
                  {model.secondary}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

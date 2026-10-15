"use client";

import { useEffect, useRef, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { ExternalLink, Loader2, Pencil, Trash2 } from "lucide-react";
import { formatCell, type QueryProperty } from "@/lib/database-query";
import { t } from "@/lib/i18n";
import {
  CARD_SIZES,
  cardFieldOrder,
  cardSizeFor,
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
      setLinkedDatabase: (attrs?: { databasePageId?: string }) => ReturnType;
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

function LinkedDatabaseView({ node, updateAttributes, deleteNode, extension }: NodeViewProps) {
  const options = extension.options as LinkedDatabaseOptions;
  const locale = options.locale ?? "en";
  const databasePageId = node.attrs.databasePageId as string | null;
  const [query, setQuery] = useState("");
  const [options_, setOptions] = useState<{ id: string; title: string; icon: string | null }[]>([]);
  const [data, setData] = useState<LinkedDatabaseData | null>(null);
  const [loading, setLoading] = useState(false);

  // Gallery card preview: the size follows the measured body width, mirroring
  // `GalleryView` (the initial width of 0 keeps server and client identical).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (databasePageId) return;
    let cancelled = false;
    listDatabasesAction(options.workspaceId).then((found) => {
      if (!cancelled) setOptions(found);
    });
    return () => {
      cancelled = true;
    };
  }, [databasePageId, options.workspaceId]);

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

  if (!databasePageId) {
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
            placeholder={t(locale, "linkedLinkPlaceholder")}
            className="noema-linked-field"
          />
          <div className="noema-linked-results">
            {filtered.map((option) => (
              <button
                key={option.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => updateAttributes({ databasePageId: option.id, title: option.title })}
                className="noema-linked-result"
              >
                <span>{option.icon ?? "🗂️"}</span>
                <span className="truncate">{option.title || t(locale, "untitled")}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="noema-linked-empty">{t(locale, "linkedNoDatabases")}</p>
            )}
          </div>
        </div>
      </NodeViewWrapper>
    );
  }

  const primary = data?.properties[0];
  // The shared view-presets engine reads lower-case property types (e.g.
  // "files"), matching `COVER_PROPERTY_TYPES`; the linked-database payload
  // stores them upper-case.
  const presetProperties: ViewPropertyLike[] = (data?.properties ?? []).map(
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
      (property): property is { id: string; name: string; type: string } =>
        property !== undefined,
    );

  return (
    <NodeViewWrapper className="noema-linked-db" data-linked-database="">
      <div className="noema-linked-shell">
        <div className="noema-linked-header" contentEditable={false}>
          <span className="noema-linked-title">
            {data?.icon ?? "🗂️"}{" "}
            {String(node.attrs.title ?? data?.title ?? t(locale, "linkedDatabaseFallback"))}
          </span>
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
            onClick={() => updateAttributes({ databasePageId: null })}
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
        <div className="noema-linked-body" contentEditable={false}>
          {loading ? (
            <span className="noema-linked-loading">
              <Loader2 className="h-4 w-4 animate-spin" /> {t(locale, "loading")}
            </span>
          ) : !data ? (
            <p className="noema-linked-empty">{t(locale, "linkedLoadFailed")}</p>
          ) : data.rows.length === 0 ? (
            <p className="noema-linked-empty">{t(locale, "dbNoRows")}</p>
          ) : (
            <div
              ref={containerRef}
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}
              data-card-size={size}
            >
              {data.rows.slice(0, 20).map((row) => {
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
                                  config: null,
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

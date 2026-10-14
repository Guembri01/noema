"use client";

import { useEffect, useState } from "react";
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
  const columns = (data?.properties ?? []).slice(0, 4);

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
            <table className="noema-linked-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.id}>{column.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 20).map((row) => (
                  <tr key={row.id}>
                    {columns.map((column) => (
                      <td key={column.id}>
                        {column.id === primary?.id
                          ? row.title || t(locale, "untitled")
                          : formatCell(
                              row.values[column.id],
                              { id: column.id, name: column.name, type: column.type, config: null } as QueryProperty,
                            ) || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { ChevronRight, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { DocRenderer } from "@/components/doc-renderer";
import { getPageContentAction } from "@/server/actions/pages";
import { mentionSearchAction } from "@/server/actions/mentions";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageEmbed: {
      setPageEmbed: (attrs?: { pageId?: string }) => ReturnType;
    };
  }
}

export type PageEmbedOptions = { workspaceId: string; workspaceSlug: string };

/**
 * A read-only "synced view" of another page. Content is fetched on demand and
 * rendered with the shared DocRenderer, so the mirror always reflects the
 * source page.
 */
export const PageEmbed = Node.create<PageEmbedOptions>({
  name: "pageEmbed",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { workspaceId: "", workspaceSlug: "" };
  },

  addAttributes() {
    return {
      pageId: { default: null },
      title: { default: null },
      icon: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-page-embed]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-page-embed": "" })];
  },

  addCommands() {
    return {
      setPageEmbed:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(PageEmbedView);
  },
});

function PageEmbedView({ node, updateAttributes, deleteNode, extension }: NodeViewProps) {
  const options = extension.options as PageEmbedOptions;
  const pageId = node.attrs.pageId as string | null;
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; label: string; icon?: string | null }[]>([]);
  const [content, setContent] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query && !pageId) return;
    const timer = setTimeout(async () => {
      const found = await mentionSearchAction(options.workspaceId, query);
      setResults(found.filter((r) => r.type === "page"));
    }, 150);
    return () => clearTimeout(timer);
  }, [query, pageId, options.workspaceId]);

  useEffect(() => {
    if (!pageId) return;
    let cancelled = false;
    setLoading(true);
    getPageContentAction(pageId)
      .then((result) => {
        if (cancelled) return;
        if ("error" in result) {
          setContent(null);
        } else {
          setContent(result.content);
          updateAttributes({ title: result.title, icon: result.icon });
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  if (!pageId) {
    return (
      <NodeViewWrapper className="noema-page-embed" data-page-embed="">
        <div className="noema-page-embed-picker" contentEditable={false}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a page to sync…"
            className="noema-page-embed-field"
          />
          <div className="noema-page-embed-results">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => updateAttributes({ pageId: r.id, title: r.label })}
                className="noema-page-embed-result"
              >
                <span>{r.icon ?? "📄"}</span>
                <span className="truncate">{r.label}</span>
              </button>
            ))}
          </div>
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="noema-page-embed" data-page-embed="">
      <div className="noema-page-embed-shell" contentEditable={false}>
        <div className="noema-page-embed-header">
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            onClick={() => setOpen((v) => !v)}
            className="noema-page-embed-chevron"
          >
            <ChevronRight className="h-3.5 w-3.5" style={{ transform: open ? "rotate(90deg)" : "none" }} />
          </button>
          <span className="noema-page-embed-title">
            {node.attrs.icon ? `${String(node.attrs.icon)} ` : ""}
            {String(node.attrs.title ?? "Synced page")}
          </span>
          <a
            href={`/w/${options.workspaceSlug}/${pageId}`}
            className="noema-page-embed-open"
            aria-label="Open source page"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            aria-label="Remove synced view"
            onClick={() => deleteNode()}
            className="noema-page-embed-remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        {open && (
          <div className="noema-page-embed-body">
            {loading ? (
              <span className="noema-page-embed-loading">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </span>
            ) : (
              <DocRenderer doc={content} />
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

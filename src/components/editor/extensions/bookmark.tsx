"use client";

import { useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { ExternalLink, Pencil, Trash2 } from "lucide-react";
import { embedMeta, hostOf, isHttpUrl, normalizeUrl, resolveEmbed } from "@/lib/embeds";
import { classifyLink, normalizeLink } from "@/lib/link-check";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    bookmark: {
      setBookmark: (attrs?: { url?: string }) => ReturnType;
      setEmbed: (attrs?: { url?: string }) => ReturnType;
    };
  }
}

/* ---------------------------------------------------------------- bookmark */

export const Bookmark = Node.create({
  name: "bookmark",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: null },
      title: { default: null },
      description: { default: null },
      image: { default: null },
      icon: { default: null },
      host: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-bookmark]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-bookmark": "" })];
  },

  addCommands() {
    return {
      setBookmark:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(BookmarkView);
  },
});

/** Why a typed bookmark target was refused, or the URLs worth using. */
type BookmarkTarget =
  | { ok: true; url: string; requestUrl: string }
  | { ok: false; message: string };

const UNSAFE_LINK_MESSAGE = "That link uses a scheme that isn't allowed.";
const INVALID_LINK_MESSAGE = "Enter a valid web address.";

/**
 * Classify and canonicalise a bookmarked URL through the shared `link-check`
 * kernel. Unsafe targets (`javascript:`, `data:`, protocol-relative, `%3A`
 * smuggling) and unparseable values are refused with an inline message;
 * external links are canonicalised through the URL parser and same-origin
 * links collapse to their in-app path (`/w/<slug>/<pageId>`). Only `http(s)`
 * targets the preview API can fetch survive, so `mailto:`/`tel:`/anchors are
 * refused too.
 */
function resolveBookmarkTarget(raw: string, origin: string): BookmarkTarget {
  const candidate = normalizeUrl(raw);
  const context = origin ? { origin } : {};
  const kind = classifyLink(candidate, context);
  if (kind === "unsafe") return { ok: false, message: UNSAFE_LINK_MESSAGE };
  if (kind === "invalid") return { ok: false, message: INVALID_LINK_MESSAGE };

  const url = normalizeLink(candidate, context);
  if (url === null || (!url.startsWith("/") && !isHttpUrl(url))) {
    return { ok: false, message: INVALID_LINK_MESSAGE };
  }

  // Same-origin pages normalise to a root-relative path; the preview request
  // still needs an absolute URL to fetch.
  let requestUrl = url;
  if (!isHttpUrl(requestUrl)) {
    try {
      requestUrl = new URL(url, origin).toString();
    } catch {
      return { ok: false, message: INVALID_LINK_MESSAGE };
    }
  }
  return { ok: true, url, requestUrl };
}

function BookmarkView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const url = node.attrs.url as string | null;
  const [editing, setEditing] = useState(!url);
  const [value, setValue] = useState(url ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = (node.attrs.host as string) || (url ? hostOf(url) : "");

  const submit = async () => {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const target = resolveBookmarkTarget(value, origin);
    if (!target.ok) {
      setError(target.message);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(
        `/api/link-preview?url=${encodeURIComponent(target.requestUrl)}`,
      );
      const meta = (await response.json()) as Record<string, unknown>;
      updateAttributes({
        url: target.url,
        title: (meta.title as string) ?? null,
        description: (meta.description as string) ?? null,
        image: (meta.image as string) ?? null,
        icon: (meta.icon as string) ?? null,
        host: (meta.host as string) ?? hostOf(target.requestUrl),
      });
      setEditing(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <NodeViewWrapper className="noema-bookmark" data-bookmark="">
      {editing || !url ? (
        <>
          <div className="noema-bookmark-input" contentEditable={false}>
            <input
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder="Paste a link…"
              aria-invalid={error ? true : undefined}
              className="noema-bookmark-field"
            />
            <button type="button" className="noema-bookmark-btn" disabled={loading} onClick={() => void submit()}>
              {loading ? "Loading…" : "Add"}
            </button>
            {url && (
              <button type="button" className="noema-bookmark-btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
          {error && (
            <p
              role="alert"
              contentEditable={false}
              className="noema-bookmark-error mt-1 text-sm text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          )}
        </>
      ) : (
        <div className="noema-bookmark-card" contentEditable={false}>
          <a href={url} target="_blank" rel="noreferrer noopener" className="noema-bookmark-link">
            <span className="noema-bookmark-text">
              {node.attrs.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={String(node.attrs.icon)} alt="" className="noema-bookmark-favicon" />
              ) : null}
              <span className="noema-bookmark-title">
                {String(node.attrs.title ?? host ?? url)}
              </span>
              {node.attrs.description ? (
                <span className="noema-bookmark-desc">{String(node.attrs.description)}</span>
              ) : null}
              <span className="noema-bookmark-host">
                <ExternalLink className="h-3 w-3" /> {host}
              </span>
            </span>
            {node.attrs.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={String(node.attrs.image)} alt="" className="noema-bookmark-image" />
            ) : null}
          </a>
          <div className="noema-bookmark-actions">
            <button type="button" aria-label="Edit link" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label="Remove" onClick={() => deleteNode()}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/* ------------------------------------------------------------------- embed */

export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: null },
      provider: { default: "none" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-embed]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-embed": "" })];
  },

  addCommands() {
    return {
      setEmbed:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(EmbedView);
  },
});

function EmbedView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const url = node.attrs.url as string | null;
  const [value, setValue] = useState(url ?? "");
  // Resolve through the provider registry on every render - the node's
  // persisted `provider` attribute is a hint only and is never trusted for
  // the iframe. Unsupported/raw URLs stay in the editing input (never a
  // generic arbitrary-host iframe).
  const resolved = url ? resolveEmbed(url) : null;
  const meta = resolved ? embedMeta(resolved.provider) : null;
  const [editing, setEditing] = useState(!resolved);

  return (
    <NodeViewWrapper className="noema-embed" data-embed="">
      {editing || !resolved ? (
        <div className="noema-embed-input" contentEditable={false}>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const normalized = normalizeUrl(value);
                const next = resolveEmbed(normalized);
                updateAttributes({ url: normalized, provider: next?.provider ?? "none" });
                setEditing(false);
              }
            }}
            placeholder="Paste a YouTube, Vimeo, Loom, Figma… URL"
            className="noema-embed-field"
          />
          <p className="noema-embed-hint">
            Press Enter to embed. Unsupported links become bookmark cards.
          </p>
        </div>
      ) : (
        <div
          className="noema-embed-frame"
          data-provider={resolved.provider}
          contentEditable={false}
          style={meta ? { aspectRatio: meta.aspectRatio } : undefined}
        >
          <iframe
            src={resolved.embedUrl}
            title={meta?.title ?? "Embedded content"}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox={resolved.sandbox}
            allow={resolved.allow}
            allowFullScreen
          />
          {meta && <span className="noema-embed-provider">{meta.label}</span>}
          <div className="noema-embed-actions">
            <button type="button" aria-label="Change embed" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label="Remove" onClick={() => deleteNode()}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

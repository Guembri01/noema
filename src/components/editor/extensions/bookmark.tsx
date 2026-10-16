"use client";

import { useState, type ReactNode } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { ExternalLink, MapPin, Pencil, Trash2 } from "lucide-react";
import { embedMeta, hostOf, isHttpUrl, normalizeUrl, resolveEmbed } from "@/lib/embeds";
import {
  DEFAULT_ZOOM,
  isValidZoom,
  mapEmbedUrl,
  mapLinkUrl,
  type MapProvider,
} from "@/lib/map-embed";
import type { GeoValue } from "@/lib/geo";
import { classifyLink, normalizeLink } from "@/lib/link-check";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    bookmark: {
      setBookmark: (attrs?: { url?: string }) => ReturnType;
      setEmbed: (attrs?: { url?: string }) => ReturnType;
    };
    pdfPreview: {
      setPdfPreview: (attrs?: { url?: string; title?: string }) => ReturnType;
    };
    mapBlock: {
      setMapBlock: (attrs?: {
        lat?: number;
        lng?: number;
        label?: string;
        provider?: MapProvider;
        zoom?: number;
      }) => ReturnType;
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

/* ------------------------------------------------------------- sandboxed frame */

/**
 * Sandbox tokens for a passive preview iframe (the browser's PDF viewer and the
 * OpenStreetMap widget both need scripts, and each needs its own origin to
 * run). The untrusted document still keeps its own origin, so it can never
 * reach this app's DOM; top-frame navigation and popups are never granted.
 */
const SANDBOX_PREVIEW = "allow-scripts allow-same-origin";

type SandboxedFrameProps = {
  className: string;
  src: string;
  title: string;
  sandbox: string;
  /** Registry-provided feature policy (`allow`); omitted when not applicable. */
  allow?: string;
  /** Provider id mirrored onto `data-provider` (absent for non-registry frames). */
  provider?: string;
  /** CSS `aspect-ratio` (e.g. `"16 / 9"`); omitted for free-height frames. */
  aspectRatio?: string;
  children?: ReactNode;
};

/**
 * The single iframe renderer for every rich block in this file. Callers must
 * hand it an `src` that already came from an allowlisted/pure builder
 * (`resolveEmbed`, `mapEmbedUrl`, or a scheme-gated PDF URL) plus the matching
 * `sandbox`, so no block can ever drop an unsandboxed or arbitrary-host frame.
 */
function SandboxedFrame({
  className,
  src,
  title,
  sandbox,
  allow,
  provider,
  aspectRatio,
  children,
}: SandboxedFrameProps) {
  return (
    <div
      className={className}
      data-provider={provider}
      contentEditable={false}
      style={aspectRatio ? { aspectRatio } : undefined}
    >
      <iframe
        src={src}
        title={title}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox={sandbox}
        allow={allow}
        allowFullScreen
      />
      {children}
    </div>
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
        <SandboxedFrame
          className="noema-embed-frame"
          src={resolved.embedUrl}
          title={meta?.title ?? "Embedded content"}
          sandbox={resolved.sandbox}
          allow={resolved.allow}
          provider={resolved.provider}
          aspectRatio={meta?.aspectRatio}
        >
          {meta && <span className="noema-embed-provider">{meta.label}</span>}
          <div className="noema-embed-actions">
            <button type="button" aria-label="Change embed" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label="Remove" onClick={() => deleteNode()}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </SandboxedFrame>
      )}
    </NodeViewWrapper>
  );
}

/* ------------------------------------------------------------ PDF preview */

/**
 * Inline PDF preview. The stored `url` is untrusted (imports, API writes), so
 * only an `http(s)` address reaches the frame and the frame itself is fully
 * scheme-gated by {@link SandboxedFrame}; anything else stays in the input.
 */
export const PdfPreview = Node.create({
  name: "pdfPreview",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-pdf-preview]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-pdf-preview": "" })];
  },

  addCommands() {
    return {
      setPdfPreview:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(PdfPreviewView);
  },
});

function PdfPreviewView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const url = node.attrs.url as string | null;
  const safeUrl = url && isHttpUrl(url) ? url : null;
  const host = safeUrl ? hostOf(safeUrl) : "";
  const [editing, setEditing] = useState(!safeUrl);
  const [value, setValue] = useState(url ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const normalized = normalizeUrl(value);
    if (!normalized || !isHttpUrl(normalized)) {
      setError("Enter a valid PDF address.");
      return;
    }
    setError(null);
    updateAttributes({ url: normalized, title: hostOf(normalized) || null });
    setEditing(false);
  };

  return (
    <NodeViewWrapper className="noema-pdf" data-pdf-preview="">
      {editing || !safeUrl ? (
        <div className="noema-embed-input" contentEditable={false}>
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
                submit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="Paste a PDF URL…"
            aria-invalid={error ? true : undefined}
            className="noema-embed-field"
          />
          <button type="button" className="noema-bookmark-btn" onClick={submit}>
            Add
          </button>
          {safeUrl && (
            <button type="button" className="noema-bookmark-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
          {error && (
            <p role="alert" className="noema-embed-hint text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="noema-pdf-shell" contentEditable={false}>
          <div className="noema-pdf-bar">
            <span className="noema-pdf-title">
              {String(node.attrs.title ?? host ?? safeUrl)}
            </span>
            <a href={safeUrl} target="_blank" rel="noreferrer noopener" aria-label="Open PDF">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button type="button" aria-label="Change PDF" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label="Remove" onClick={() => deleteNode()}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <SandboxedFrame
            className="noema-pdf-frame"
            src={safeUrl}
            title={String(node.attrs.title ?? "PDF preview")}
            sandbox={SANDBOX_PREVIEW}
          />
        </div>
      )}
    </NodeViewWrapper>
  );
}

/* --------------------------------------------------------------------- map */

/**
 * Embedded map for a coordinate. The `lat`/`lng`/`zoom`/`provider` attributes
 * are re-validated through the pure `map-embed` engine on every render, so a
 * malformed or imported value can never reach the frame; the iframe `src` only
 * ever comes from `mapEmbedUrl` (never `mapLinkUrl`, which is link-only) and is
 * sandboxed by {@link SandboxedFrame}. An external link uses `mapLinkUrl`.
 */
export const MapBlock = Node.create({
  name: "mapBlock",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      lat: { default: null },
      lng: { default: null },
      label: { default: null },
      provider: { default: "osm" },
      zoom: { default: DEFAULT_ZOOM },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-map-block]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-map-block": "" })];
  },

  addCommands() {
    return {
      setMapBlock:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: attrs ?? {} }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MapBlockView);
  },
});

function MapBlockView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const provider: MapProvider = node.attrs.provider === "google" ? "google" : "osm";
  const storedZoom = typeof node.attrs.zoom === "number" ? node.attrs.zoom : DEFAULT_ZOOM;
  const label =
    typeof node.attrs.label === "string" && node.attrs.label ? node.attrs.label : undefined;
  const value: GeoValue | null =
    typeof node.attrs.lat === "number" && typeof node.attrs.lng === "number"
      ? label
        ? { lat: node.attrs.lat, lng: node.attrs.lng, label }
        : { lat: node.attrs.lat, lng: node.attrs.lng }
      : null;
  const embedUrl = value ? mapEmbedUrl(value, { provider, zoom: storedZoom }) : null;
  const linkUrl = value ? mapLinkUrl(value) : null;

  const [editing, setEditing] = useState(!embedUrl);
  const [lat, setLat] = useState(value ? String(value.lat) : "");
  const [lng, setLng] = useState(value ? String(value.lng) : "");
  const [zoom, setZoom] = useState(String(storedZoom));
  const [providerInput, setProviderInput] = useState<MapProvider>(provider);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (lat.trim() === "" || lng.trim() === "") {
      setError("Enter a latitude and longitude.");
      return;
    }
    const nextLat = Number(lat);
    const nextLng = Number(lng);
    const nextZoom = Number(zoom);
    const candidate: GeoValue = { lat: nextLat, lng: nextLng };
    if (
      !isValidZoom(nextZoom) ||
      mapEmbedUrl(candidate, { provider: providerInput, zoom: nextZoom }) === null
    ) {
      setError("Coordinates must be lat −90…90 / lng −180…180 and zoom a whole number 0…20.");
      return;
    }
    setError(null);
    updateAttributes({
      lat: nextLat,
      lng: nextLng,
      provider: providerInput,
      zoom: nextZoom,
    });
    setEditing(false);
  };

  return (
    <NodeViewWrapper className="noema-map" data-map-block="">
      {editing || !embedUrl ? (
        <div className="noema-embed-input" contentEditable={false}>
          <input
            autoFocus
            value={lat}
            onChange={(e) => {
              setLat(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Latitude"
            inputMode="decimal"
            className="noema-embed-field"
          />
          <input
            value={lng}
            onChange={(e) => {
              setLng(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Longitude"
            inputMode="decimal"
            className="noema-embed-field"
          />
          <input
            value={zoom}
            onChange={(e) => {
              setZoom(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Zoom"
            inputMode="numeric"
            className="noema-embed-field"
          />
          <select
            value={providerInput}
            onChange={(e) =>
              setProviderInput(e.target.value === "google" ? "google" : "osm")
            }
            className="noema-embed-field"
          >
            <option value="osm">OpenStreetMap</option>
            <option value="google">Google Maps</option>
          </select>
          <button type="button" className="noema-bookmark-btn" onClick={submit}>
            Save
          </button>
          {embedUrl && (
            <button type="button" className="noema-bookmark-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
          {error && (
            <p role="alert" className="noema-embed-hint text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="noema-map-shell" contentEditable={false}>
          <div className="noema-map-bar">
            <MapPin className="h-3.5 w-3.5" />
            {label ? <span className="noema-map-title">{label}</span> : null}
            {linkUrl && (
              <a href={linkUrl} target="_blank" rel="noreferrer noopener" aria-label="Open map">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <button type="button" aria-label="Change location" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label="Remove" onClick={() => deleteNode()}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <SandboxedFrame
            className="noema-map-frame"
            src={embedUrl}
            title={label ? `Map: ${label}` : "Embedded map"}
            sandbox={SANDBOX_PREVIEW}
          />
        </div>
      )}
    </NodeViewWrapper>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { ExternalLink, MapPin, Pencil, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { embedMeta, hostOf, isHttpUrl, isSafePdfUrl, normalizeUrl, resolveEmbed } from "@/lib/embeds";
import {
  DEFAULT_ZOOM,
  isValidZoom,
  mapEmbedUrl,
  mapLinkUrl,
  type MapProvider,
} from "@/lib/map-embed";
import type { GeoValue } from "@/lib/geo";
import { classifyLink, normalizeLink } from "@/lib/link-check";
import {
  OEMBED_ALLOWED_HOSTS,
  discoverEndpoint,
  parseOEmbed,
  parseOpenGraph,
  resolveMetadata,
  sanitizeEmbedHtml,
  type OEmbedData,
  type OpenGraphData,
  type ResolvedMetadata,
} from "@/lib/oembed";
import {
  linkify,
  parseGithubRefs,
  parseSlackRefs,
  unfurlPayload,
  type GithubRef,
  type SlackRef,
} from "@/lib/integration-links";
import { t } from "@/lib/i18n";
import { sanitizeHref } from "@/lib/validation";

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

export const Bookmark = Node.create<{ locale: string }>({
  name: "bookmark",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en" };
  },

  addAttributes() {
    return {
      url: { default: null },
      title: { default: null },
      description: { default: null },
      image: { default: null },
      icon: { default: null },
      host: { default: null },
      embed: { default: null },
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
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <BookmarkView {...props} locale={locale} />
    ));
  },
});

/** A pasted GitHub/Slack reference that resolves to a canonical URL. */
type DetectedRef = GithubRef | SlackRef;

/** Resolve a pasted GitHub/Slack token (`owner/repo#1`, `#channel`, …) to a URL. */
function detectRef(raw: string): { ref: DetectedRef; url: string } | null {
  const text = raw.trim();
  if (text === "") return null;
  const github = parseGithubRefs(text).find((ref) => ref.raw === text);
  if (github && isHttpUrl(github.url)) return { ref: github, url: github.url };
  const slack = parseSlackRefs(text).find((ref) => ref.raw === text);
  if (slack && isHttpUrl(slack.url)) return { ref: slack, url: slack.url };
  return null;
}

/** Why a typed bookmark target was refused, or the URLs worth using. */
type BookmarkTarget =
  | { ok: true; url: string; requestUrl: string; ref?: DetectedRef }
  | { ok: false; message: string };

const UNSAFE_LINK_MESSAGE = "That link uses a scheme that isn't allowed.";
const INVALID_LINK_MESSAGE = "Enter a valid web address.";

/** Narrow an unknown value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hostname of a URL without a leading `www.`, falling back to `hostOf`. */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return hostOf(url);
  }
}

/** Decode the handful of entities `sanitizeEmbedHtml` can emit in an attribute. */
function decodeAttr(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/** The sanitised iframe `src`, or `null` when the embed is not a frame. */
function embedSrc(html: string | null): string | null {
  if (html === null) return null;
  // The stored value is untrusted: it can arrive from an older write path or
  // from the MCP `append_blocks` tool, not only from the creation-time
  // resolver. Re-run the same allowlist at render time, so an arbitrary host
  // can never be framed in the app origin.
  const safe = sanitizeEmbedHtml(html, { allowedHosts: OEMBED_ALLOWED_HOSTS });
  if (safe === null) return null;
  const match = /<iframe\b[^>]*\bsrc="([^"]+)"/i.exec(safe);
  return match ? decodeAttr(match[1]) : null;
}

/** The preview fields a resolved bookmark persists onto its node attributes. */
type BookmarkCard = {
  title: string | null;
  description: string | null;
  image: string | null;
  icon: string | null;
  host: string;
  embed: string | null;
};

/**
 * Resolve preview metadata through the oEmbed engine: discovered provider
 * endpoints first, same-origin OpenGraph markup next, and the server
 * `/api/link-preview` card as the always-available fallback. The layers merge
 * through `resolveMetadata` and any embed markup passes through
 * `sanitizeEmbedHtml` before it can be rendered.
 */
async function fetchBookmarkCard(target: {
  requestUrl: string;
  url: string;
  ref?: DetectedRef;
}): Promise<BookmarkCard> {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  let oembed: OEmbedData | null = null;
  let og: OpenGraphData | null = null;
  let rawMeta: unknown = null;

  for (const endpoint of discoverEndpoint(target.requestUrl)) {
    try {
      const response = await fetch(endpoint.endpoint, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) continue;
      const parsed = parseOEmbed(await response.json());
      if (parsed) {
        oembed = parsed;
        break;
      }
    } catch {
      // CORS/network failures fall through to the server preview.
    }
  }

  if (origin !== "" && target.requestUrl.startsWith(origin)) {
    try {
      const response = await fetch(target.requestUrl, { headers: { accept: "text/html" } });
      if (response.ok) {
        og = parseOpenGraph(await response.text(), { baseUrl: target.requestUrl });
      }
    } catch {
      // Ignore; the server preview still resolves metadata.
    }
  }

  try {
    const response = await fetch(
      `/api/link-preview?url=${encodeURIComponent(target.requestUrl)}`,
    );
    if (response.ok) {
      rawMeta = (await response.json()) as unknown;
      if (og === null && isRecord(rawMeta)) {
        const fallback: OpenGraphData = {};
        if (typeof rawMeta.title === "string") fallback.title = rawMeta.title;
        if (typeof rawMeta.description === "string") fallback.description = rawMeta.description;
        if (typeof rawMeta.image === "string") fallback.image = rawMeta.image;
        if (typeof rawMeta.icon === "string") fallback.favicon = rawMeta.icon;
        og = fallback;
      }
    }
  } catch {
    // Keep whatever the earlier layers produced.
  }

  const resolved: ResolvedMetadata = resolveMetadata({ oembed, og, url: target.url });
  const title =
    resolved.title ?? (target.ref ? unfurlPayload(target.ref, rawMeta).title : null);
  const embed = resolved.html
    ? sanitizeEmbedHtml(resolved.html, { allowedHosts: OEMBED_ALLOWED_HOSTS })
    : null;

  return {
    title,
    description: resolved.description ?? null,
    image: resolved.image ?? null,
    icon: resolved.favicon ?? null,
    host: hostLabel(target.requestUrl),
    embed: embed !== null && /^<iframe/i.test(embed) ? embed : null,
  };
}

/** Split linkified text into literal strings and safe anchors (no raw HTML). */
function renderLinkified(text: string, keyPrefix: string): ReactNode[] {
  const linked = linkify(text, { providers: { github: {}, slack: {} } });
  const nodes: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(linked)) !== null) {
    if (match.index > last) nodes.push(linked.slice(last, match.index));
    nodes.push(
      <a key={`${keyPrefix}-${index}`} href={match[2]} target="_blank" rel="noreferrer noopener">
        {match[1]}
      </a>,
    );
    last = match.index + match[0].length;
    index += 1;
  }
  if (last < linked.length) nodes.push(linked.slice(last));
  return nodes;
}

/**
 * Classify and canonicalise a bookmarked URL through the shared `link-check`
 * kernel, or expand a bare GitHub/Slack reference (`owner/repo#123`, `#channel`,
 * `@user`, a commit SHA) through the linkifier's detectors. Unsafe targets
 * (`javascript:`, `data:`, protocol-relative, `%3A` smuggling) and unparseable
 * values are refused with an inline message; external links are canonicalised
 * through the URL parser and same-origin links collapse to their in-app path
 * (`/w/<slug>/<pageId>`). Only `http(s)` targets the preview API can fetch
 * survive, so `mailto:`/`tel:`/anchors are refused too.
 */
function resolveBookmarkTarget(raw: string, origin: string): BookmarkTarget {
  const ref = detectRef(raw);
  if (ref) return { ok: true, url: ref.url, requestUrl: ref.url, ref: ref.ref };

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

/* ---------------------------------------------------- bookmark card surface */

/** The three render states the bookmark card can be in (docs/DESIGN_SYSTEM.md §8). */
export type BookmarkCardState = "loading" | "ready" | "error";

export type BookmarkCardSurfaceProps = {
  /** Which state to render. Defaults to the loaded card. */
  state?: BookmarkCardState;
  /** The canonicalised link target. */
  url?: string | null;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  icon?: string | null;
  host?: string | null;
  /** A sanitised provider `<iframe>` src, when the link resolved to one. */
  embedUrl?: string | null;
  /** Message for the `error` state, rendered as inline danger ink. */
  error?: string | null;
  /** Locale for the card's accessible labels (icon-only action buttons). */
  locale?: string;
  onEdit?: () => void;
  onRemove?: () => void;
};

/**
 * The bookmark link card, split out of the Tiptap node view so every state
 * (loading skeleton, error, loaded card) can be rendered with
 * `renderToStaticMarkup`. Chrome is token-only — `border-border` /
 * `bg-surface` / `rounded-md`; the hover settles through `.u-surface` +
 * `.u-interactive` (colour and shadow only, so there is no layout shift), and
 * the error copy is inline `text-danger` ink.
 */
export function BookmarkCardSurface({
  state = "ready",
  url = null,
  title = null,
  description = null,
  image = null,
  icon = null,
  host = null,
  embedUrl = null,
  error = null,
  locale = "en",
  onEdit,
  onRemove,
}: BookmarkCardSurfaceProps) {
  if (state === "loading") {
    return (
      <div className="noema-bookmark-loading" data-bookmark-state="loading" aria-busy="true">
        <Skeleton variant="card" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <p
        role="alert"
        contentEditable={false}
        data-bookmark-state="error"
        className="noema-bookmark-error mt-1 text-sm text-danger"
      >
        {error ?? "Couldn't load this link."}
      </p>
    );
  }

  return (
    <div
      className="noema-bookmark-card u-surface u-interactive rounded-card border border-border bg-surface hover:bg-surface-2"
      data-bookmark-state="ready"
      contentEditable={false}
    >
      {/* The stored `url` is untrusted (a document stored before the
          write-time href gate existed, or written through the MCP
          `append_blocks` tool, which does not run the document sanitiser),
          so it passes the shared href allowlist before it may become a
          link. A rejected URL renders the card without a live target. */}
      <a
        href={sanitizeHref(url) ?? "#"}
        target="_blank"
        rel="noreferrer noopener"
        className="noema-bookmark-link"
      >
        <span className="noema-bookmark-text">
          {icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={icon} alt="" className="noema-bookmark-favicon" />
          ) : null}
          <span className="noema-bookmark-title">
            {title ?? host ?? url}
          </span>
          {description ? (
            <span className="noema-bookmark-desc">
              {renderLinkified(description, "bm-desc")}
            </span>
          ) : null}
          <span className="noema-bookmark-host">
            <ExternalLink className="h-3 w-3" /> {host}
          </span>
        </span>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="noema-bookmark-image" />
        ) : null}
      </a>
      {embedUrl ? (
        <SandboxedFrame
          className="noema-bookmark-embed bg-overlay"
          src={embedUrl}
          title={`${host || t(locale, "link")} ${t(locale, "previewWord")}`}
          sandbox={SANDBOX_PREVIEW}
        />
      ) : null}
      <div className="noema-bookmark-actions">
        <button type="button" aria-label={t(locale, "editLink")} onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t(locale, "remove")} onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * The node view of the bookmark block. Exported so the rendered markup (the
 * card link in particular) can be asserted without a DOM.
 */
export function BookmarkView({ node, updateAttributes, deleteNode, locale }: NodeViewProps & { locale: string }) {
  const url = node.attrs.url as string | null;
  const [editing, setEditing] = useState(!url);
  const [value, setValue] = useState(url ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = (node.attrs.host as string) || (url ? hostOf(url) : "");
  const embedUrl = embedSrc((node.attrs.embed as string | null) ?? null);

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
      const card = await fetchBookmarkCard(target);
      updateAttributes({
        url: target.url,
        title: card.title,
        description: card.description,
        image: card.image,
        icon: card.icon,
        host: card.host,
        embed: card.embed,
      });
      setEditing(false);
    } catch {
      setError("Couldn't load this link. Check the address and try again.");
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
              placeholder={t(locale, "linkPastePlaceholder")}
              aria-invalid={error ? true : undefined}
              className="noema-bookmark-field"
            />
            <button type="button" className="noema-bookmark-btn focus-ring u-interactive" disabled={loading} onClick={() => void submit()}>
              {loading ? "Loading…" : "Add"}
            </button>
            {url && (
              <button type="button" className="noema-bookmark-btn focus-ring u-interactive" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
          {error ? <BookmarkCardSurface state="error" error={error} /> : null}
          {loading ? <BookmarkCardSurface state="loading" /> : null}
        </>
      ) : (
        <BookmarkCardSurface
          state="ready"
          url={url}
          title={node.attrs.title as string | null}
          description={node.attrs.description as string | null}
          image={node.attrs.image as string | null}
          icon={node.attrs.icon as string | null}
          host={host}
          embedUrl={embedUrl}
          locale={locale}
          onEdit={() => setEditing(true)}
          onRemove={() => deleteNode()}
        />
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

export const Embed = Node.create<{ locale: string }>({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en" };
  },

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
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <EmbedView {...props} locale={locale} />
    ));
  },
});

function EmbedView({ node, updateAttributes, deleteNode, locale }: NodeViewProps & { locale: string }) {
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
            placeholder={t(locale, "embedPlaceholder")}
            className="noema-embed-field"
          />
          <p className="noema-embed-hint">
            Press Enter to embed. Unsupported links become bookmark cards.
          </p>
        </div>
      ) : (
        <SandboxedFrame
          className="noema-embed-frame bg-overlay"
          src={resolved.embedUrl}
          title={meta?.title ?? t(locale, "embeddedContent")}
          sandbox={resolved.sandbox}
          allow={resolved.allow}
          provider={resolved.provider}
          aspectRatio={meta?.aspectRatio}
        >
          {meta && (
            <span className="noema-embed-provider bg-surface-2 text-muted">{meta.label}</span>
          )}
          <div className="noema-embed-actions">
            <button type="button" aria-label={t(locale, "changeEmbed")} onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label={t(locale, "remove")} onClick={() => deleteNode()}>
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
export const PdfPreview = Node.create<{ locale: string }>({
  name: "pdfPreview",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en" };
  },

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
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <PdfPreviewView {...props} locale={locale} />
    ));
  },
});

function PdfPreviewView({ node, updateAttributes, deleteNode, locale }: NodeViewProps & { locale: string }) {
  const url = node.attrs.url as string | null;
  const safeUrl = url && isSafePdfUrl(url) ? url : null;
  const host = safeUrl ? hostOf(safeUrl) : "";
  const [editing, setEditing] = useState(!safeUrl);
  const [value, setValue] = useState(url ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const normalized = normalizeUrl(value);
    if (!normalized || !isSafePdfUrl(normalized)) {
      setError("Enter a valid PDF address or upload path.");
      return;
    }
    setError(null);
    const name = normalized.startsWith("/api/files/")
      ? decodeURIComponent(normalized.split("/").pop() ?? "")
      : "";
    updateAttributes({ url: normalized, title: hostOf(normalized) || name || null });
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
            placeholder={t(locale, "pdfUrlPlaceholder")}
            aria-invalid={error ? true : undefined}
            className="noema-embed-field"
          />
          <button type="button" className="noema-bookmark-btn focus-ring u-interactive" onClick={submit}>
            Add
          </button>
          {safeUrl && (
            <button type="button" className="noema-bookmark-btn focus-ring u-interactive" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
          {error && (
            <p role="alert" className="noema-embed-hint text-danger">
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
            <a href={safeUrl} target="_blank" rel="noreferrer noopener" aria-label={t(locale, "openPdf")}>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button type="button" aria-label={t(locale, "changePdf")} onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label={t(locale, "remove")} onClick={() => deleteNode()}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <SandboxedFrame
            className="noema-pdf-frame"
            src={safeUrl}
            title={String(node.attrs.title ?? t(locale, "pdfPreview"))}
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
export const MapBlock = Node.create<{ locale: string }>({
  name: "mapBlock",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en" };
  },

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
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <MapBlockView {...props} locale={locale} />
    ));
  },
});

function MapBlockView({ node, updateAttributes, deleteNode, locale }: NodeViewProps & { locale: string }) {
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
            placeholder={t(locale, "latitude")}
            inputMode="decimal"
            className="noema-embed-field"
          />
          <input
            value={lng}
            onChange={(e) => {
              setLng(e.target.value);
              if (error) setError(null);
            }}
            placeholder={t(locale, "longitude")}
            inputMode="decimal"
            className="noema-embed-field"
          />
          <input
            value={zoom}
            onChange={(e) => {
              setZoom(e.target.value);
              if (error) setError(null);
            }}
            placeholder={t(locale, "zoom")}
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
          <button type="button" className="noema-bookmark-btn focus-ring u-interactive" onClick={submit}>
            Save
          </button>
          {embedUrl && (
            <button type="button" className="noema-bookmark-btn focus-ring u-interactive" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
          {error && (
            <p role="alert" className="noema-embed-hint text-danger">
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
              <a href={linkUrl} target="_blank" rel="noreferrer noopener" aria-label={t(locale, "openMap")}>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <button type="button" aria-label={t(locale, "changeLocation")} onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label={t(locale, "remove")} onClick={() => deleteNode()}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <SandboxedFrame
            className="noema-map-frame"
            src={embedUrl}
            title={label ? `${t(locale, "mapWord")}: ${label}` : t(locale, "embeddedMap")}
            sandbox={SANDBOX_PREVIEW}
          />
        </div>
      )}
    </NodeViewWrapper>
  );
}

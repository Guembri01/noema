/**
 * F6 — link preview metadata extraction.
 *
 * Pure HTML-string parsing for the bookmark/link-preview card: no network, no
 * DOM, no third-party parser. `parseLinkMeta()` reads `<title>`, the `og:*` and
 * `twitter:*` meta namespaces, `<meta name=description>`, `<link rel=icon>` and
 * `<link rel=canonical>`, resolves URL-valued fields against a caller-supplied
 * `baseUrl` and decodes HTML entities. It is deliberately total: a hostile or
 * truncated page can hand this module any bytes and it will never throw.
 *
 * This module is bundled into the client, so it hosts no host gate: the SSRF
 * gate for the preview path is the shared, DNS-aware guard in
 * `src/lib/feed-guard.ts` (`safeFetchGuarded`), which the route runs before
 * and after every request. A literal-host check here would only ever be a
 * weaker second copy of it (audit B10).
 */

/** The preview-card shape consumed by the bookmark block / doc renderer. */
export type LinkPreviewMeta = {
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
  url?: string;
};

/** Options for {@link parseLinkMeta}; `baseUrl` resolves relative hrefs. */
export type ParseLinkMetaOptions = {
  /** Absolute page URL the markup was fetched from, e.g. `https://a.com/p/1`. */
  baseUrl?: string;
};

/** Options for {@link truncateMeta}. */
export type TruncateMetaOptions = {
  /** Maximum character length kept for each text field. */
  max: number;
};

/** Never scan more than this much markup; preview data lives in `<head>`. */
const MAX_HTML_SCAN = 200_000;

/** Named entities worth decoding in preview text (the common `&…;` set). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  deg: "\u00B0",
  pound: "\u00A3",
  euro: "\u20AC",
  yen: "\u00A5",
  cent: "\u00A2",
  sect: "\u00A7",
  middot: "\u00B7",
  bull: "\u2022",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
};

/** Coerce a numeric code point without ever throwing (D800–DFFF are invalid). */
function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "\uFFFD";
  if (code >= 0xd800 && code <= 0xdfff) return "\uFFFD";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "\uFFFD";
  }
}

/**
 * Decode HTML entities in a single pass: decimal (`&#39;`), hex (`&#x27;`) and
 * the named set above. Unknown names and malformed escapes (`&`, `&amp` with no
 * semicolon, `&;`) are left verbatim. Single-pass decoding means `&amp;lt;`
 * yields the literal `&lt;` rather than `<`.
 */
export function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10));
      if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
      const known = name ? NAMED_ENTITIES[name.toLowerCase()] : undefined;
      return known !== undefined ? known : whole;
    },
  );
}

/** Decode entities, drop nested tags, collapse whitespace; empty → undefined. */
function cleanText(value: string): string | undefined {
  const text = decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? undefined : text;
}

/**
 * Extract every `name="value"` attribute from a single tag's source text.
 * `=` is required, so the tag name itself is never captured; values may be
 * double-quoted, single-quoted or unquoted and are returned raw (undecoded).
 */
function attrsOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/**
 * Resolve an href from page markup against an absolute base URL.
 *
 * Returns the absolute `http(s)` URL, or `null` when the href is empty, when a
 * relative href has no usable base, or when the result uses any other scheme
 * (`javascript:`, `mailto:`, `data:` …). Total: never throws.
 */
export function resolveUrl(base: string | undefined, href: string): string | null {
  const raw = typeof href === "string" ? href.trim() : "";
  if (raw === "") return null;

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)
    ? raw
    : (() => {
        const baseText = typeof base === "string" ? base.trim() : "";
        if (baseText === "") return null;
        try {
          return new URL(raw, baseText).toString();
        } catch {
          return null;
        }
      })();

  if (candidate === null) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse a page's markup into preview metadata. Priority follows the usual card
 * cascade — `og:*` → `twitter:*` → plain HTML — and every URL-valued field
 * (`image`, `favicon`, `url`) is resolved against `options.baseUrl`.
 *
 * `url` falls back to the canonical `<link>` and finally to `baseUrl` itself.
 * Missing fields are omitted; malformed markup/entities degrade to omission.
 * Total: never throws.
 */
export function parseLinkMeta(html: string, options: ParseLinkMetaOptions = {}): LinkPreviewMeta {
  try {
    const source = typeof html === "string" ? html.slice(0, MAX_HTML_SCAN) : "";
    const baseUrl = typeof options?.baseUrl === "string" ? options.baseUrl : undefined;

    // First occurrence wins for each meta key, so an early og:* tag is not
    // clobbered by a later duplicate.
    const metas = new Map<string, string>();
    for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = attrsOf(match[0]);
      const key = (attrs.property ?? attrs.name ?? "").toLowerCase().trim();
      const content = attrs.content;
      if (key !== "" && content !== undefined && !metas.has(key)) metas.set(key, content);
    }

    const text = (key: string): string | undefined => {
      const raw = metas.get(key);
      return raw === undefined ? undefined : cleanText(raw);
    };
    const url = (key: string): string | undefined => {
      const raw = metas.get(key);
      if (raw === undefined) return undefined;
      return resolveUrl(baseUrl, decodeEntities(raw)) ?? undefined;
    };

    let iconHref: string | undefined;
    let canonical: string | undefined;
    for (const match of source.matchAll(/<link\b[^>]*>/gi)) {
      const attrs = attrsOf(match[0]);
      const rel = (attrs.rel ?? "").toLowerCase();
      const href = attrs.href;
      if (href === undefined) continue;
      if (iconHref === undefined && rel.includes("icon")) iconHref = href;
      if (canonical === undefined && rel.split(/\s+/).includes("canonical")) canonical = href;
    }

    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1];
    const canonicalUrl = canonical === undefined ? undefined : resolveUrl(baseUrl, decodeEntities(canonical));

    const meta: LinkPreviewMeta = {};
    const title = text("og:title") ?? text("twitter:title") ?? (titleTag ? cleanText(titleTag) : undefined);
    const description =
      text("og:description") ?? text("twitter:description") ?? text("description");
    const image =
      url("og:image") ?? url("og:image:url") ?? url("og:image:secure_url") ??
      url("twitter:image") ?? url("twitter:image:src");
    const favicon =
      iconHref === undefined
        ? undefined
        : resolveUrl(baseUrl, decodeEntities(iconHref)) ?? undefined;
    const siteName = text("og:site_name") ?? text("application-name");
    const url_ = url("og:url") ?? canonicalUrl ?? resolveUrl(undefined, baseUrl ?? "") ?? undefined;

    if (title !== undefined) meta.title = title;
    if (description !== undefined) meta.description = description;
    if (image !== undefined) meta.image = image;
    if (favicon !== undefined) meta.favicon = favicon;
    if (siteName !== undefined) meta.siteName = siteName;
    if (url_ !== undefined) meta.url = url_;
    return meta;
  } catch {
    return {};
  }
}

/** Truncate one text field to `max` characters, appending an ellipsis if cut. */
function capText(value: string | undefined, max: number): string | undefined {
  if (value === undefined || max <= 0) return undefined;
  if (value.length <= max) return value;
  if (max === 1) return "\u2026";
  return `${value.slice(0, max - 1).replace(/\s+$/, "")}\u2026`;
}

/**
 * Fit preview metadata to a fixed character budget. The prose fields (`title`,
 * `description`, `siteName`) are capped at `options.max` characters with a
 * trailing `…` when cut; URL-valued fields (`image`, `favicon`, `url`) are
 * preserved intact so links stay valid. A `max` of `0` (or less) drops the
 * prose fields entirely. Pure: returns a new object and never mutates or throws.
 */
export function truncateMeta(meta: LinkPreviewMeta, options: TruncateMetaOptions): LinkPreviewMeta {
  if (meta === null || typeof meta !== "object") return {};
  const raw = options?.max;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { ...meta };
  const max = Math.floor(raw);
  return {
    ...meta,
    title: capText(meta.title, max),
    description: capText(meta.description, max),
    siteName: capText(meta.siteName, max),
  };
}

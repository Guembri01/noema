/**
 * §13 — oEmbed / link-metadata engine.
 *
 * Pure, network-free helpers behind the bookmark and public-embed cards:
 * `discoverEndpoint()` maps a page URL onto the oEmbed API of a known provider
 * (or a `<link type="application/json+oembed">` discovery hint),
 * `parseOEmbed()` validates the provider's JSON and allow-lists the returned
 * embed HTML, `parseOpenGraph()` reads OpenGraph/Twitter/`<title>` metadata out
 * of markup, `sanitizeEmbedHtml()` is the single iframe/blockquote gate, and
 * `resolveMetadata()` merges every layer (oEmbed → OG → `<title>`).
 *
 * Everything is total: hostile or truncated input degrades to omission, never
 * a throw. No DOM and no third-party parser, so the regexes are kept linear
 * (`[^>]*` / a lazy `[\s\S]*?` anchored by a fixed terminator) — there is no
 * nested quantifier for a page to trigger catastrophic backtracking with.
 */

import { decodeEntities, resolveUrl } from "@/lib/link-preview-meta";

/** Every provider the oEmbed registry recognises. */
export const OEMBED_PROVIDER_IDS = [
  "youtube",
  "vimeo",
  "twitter",
  "figma",
  "codepen",
  "soundcloud",
] as const;

export type OEmbedProviderId = (typeof OEMBED_PROVIDER_IDS)[number];

/** The oEmbed resource types defined by the spec. */
export const OEMBED_TYPES = ["video", "photo", "link", "rich"] as const;

export type OEmbedType = (typeof OEMBED_TYPES)[number];

/** One candidate endpoint for a target URL. */
export type OEmbedEndpoint = {
  /** Registry provider, or `"discovery"` for a markup-derived hint. */
  provider: OEmbedProviderId | "discovery";
  /** Absolute `http(s)` oEmbed API URL. */
  endpoint: string;
  source: "provider" | "discovery";
};

export type DiscoverEndpointOptions = {
  /** Page markup; a JSON oEmbed `<link>` becomes an extra discovery hint. */
  html?: string;
};

export type OEmbedData = {
  type: OEmbedType;
  title?: string;
  authorName?: string;
  thumbnailUrl?: string;
  /** Sanitised embed markup (allow-listed iframe or blockquote), if any. */
  html?: string;
  width?: number;
  height?: number;
  providerName?: string;
};

export type ParseOEmbedOptions = {
  /** Hosts permitted inside the returned `html`; defaults to the registry. */
  allowedHosts?: readonly string[];
};

export type OpenGraphData = {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
};

export type ParseOpenGraphOptions = {
  /** Absolute page URL used to resolve relative URLs and default the favicon. */
  baseUrl?: string;
};

export type SanitizeEmbedOptions = {
  /** Hosts permitted as the embed root's provider domain. */
  allowedHosts: readonly string[];
};

export type MetadataSource = "oembed" | "opengraph" | "title" | "none";

/** Unified card metadata after merging every layer. */
export type ResolvedMetadata = {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
  authorName?: string;
  providerName?: string;
  type: OEmbedType;
  html?: string;
  width?: number;
  height?: number;
  /** Which layer supplied the title (or `"none"` when nothing resolved). */
  source: MetadataSource;
};

export type ResolveMetadataInput = {
  oembed?: OEmbedData | null;
  og?: OpenGraphData | null;
  url: string;
  /** The page's `<title>`; the lowest-precedence title source. */
  title?: string;
};

/** Never scan more than this much markup; card data lives in `<head>`. */
const MAX_HTML_SCAN = 200_000;

/** Refuse implausibly large embed snippets outright. */
const MAX_EMBED_HTML = 20_000;

type ProviderSpec = {
  id: OEmbedProviderId;
  /** Source-URL hosts (`www`-insensitive) that select this provider. */
  hosts: readonly string[];
  /** Build the JSON oEmbed API URL for a target page. */
  endpoint: (target: string) => string;
  /** Hosts permitted inside the returned embed HTML. */
  embedHosts: readonly string[];
};

const encode = (value: string): string => encodeURIComponent(value);

const PROVIDERS: Record<OEmbedProviderId, ProviderSpec> = {
  youtube: {
    id: "youtube",
    hosts: ["youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com"],
    endpoint: (url) => `https://www.youtube.com/oembed?url=${encode(url)}&format=json`,
    embedHosts: ["youtube.com", "youtube-nocookie.com"],
  },
  vimeo: {
    id: "vimeo",
    hosts: ["vimeo.com", "player.vimeo.com"],
    endpoint: (url) => `https://vimeo.com/api/oembed.json?url=${encode(url)}`,
    embedHosts: ["vimeo.com"],
  },
  twitter: {
    id: "twitter",
    hosts: ["twitter.com", "mobile.twitter.com", "x.com", "mobile.x.com"],
    endpoint: (url) => `https://publish.twitter.com/oembed?url=${encode(url)}&format=json`,
    embedHosts: ["twitter.com", "x.com", "platform.twitter.com"],
  },
  figma: {
    id: "figma",
    hosts: ["figma.com"],
    endpoint: (url) => `https://www.figma.com/api/oembed?url=${encode(url)}`,
    embedHosts: ["figma.com"],
  },
  codepen: {
    id: "codepen",
    hosts: ["codepen.io"],
    endpoint: (url) => `https://codepen.io/api/oembed?url=${encode(url)}&format=json`,
    embedHosts: ["codepen.io", "cdpn.io"],
  },
  soundcloud: {
    id: "soundcloud",
    hosts: ["soundcloud.com", "on.soundcloud.com"],
    endpoint: (url) => `https://soundcloud.com/oembed?format=json&url=${encode(url)}`,
    embedHosts: ["soundcloud.com"],
  },
};

/** Union of every provider's embed hosts, for `parseOEmbed`'s default gate. */
export const OEMBED_ALLOWED_HOSTS: readonly string[] = Array.from(
  new Set(OEMBED_PROVIDER_IDS.flatMap((id) => PROVIDERS[id].embedHosts)),
);

/** Lowercase a host and drop a leading `www.` so apex/subdomain compare equal. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

/** Exact host match, or a subdomain of an allowed host; never a suffix trick. */
function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const candidate = normalizeHost(host);
  if (candidate === "") return false;
  return allowed.some((entry) => {
    const base = normalizeHost(entry);
    if (base === "") return false;
    return candidate === base || candidate.endsWith(`.${base}`);
  });
}

/**
 * Read exactly one opening tag from the start of `source`. Unlike `[^>]*`,
 * this respects quoted attribute values, so a `>` inside `srcdoc="<b>x</b>"`
 * cannot truncate the tag and hide later attributes. `null` when `source` does
 * not start with `<name` or the tag is unterminated.
 */
function readOpeningTag(source: string, name: string): string | null {
  if (!new RegExp(`^<${name}\\b`, "i").test(source)) return null;
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return source.slice(0, i + 1);
    }
  }
  return null;
}

/** Parse every `name="value"` attribute out of a single tag's source text. */
function attrsOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/** Escape a value for inclusion inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Decode entities, strip nested tags, collapse whitespace; empty → undefined. */
function textField(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+$/, "")}\u2026`;
}

/** Keep only absolute `http(s)` URLs; everything else → undefined. */
function httpUrlField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Coerce a dimension to a positive integer; refuse NaN, floats-down, ≤ 0. */
function dimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const whole = Math.floor(value);
  return whole > 0 ? whole : undefined;
}

/** The first registry provider whose host list contains `host`, if any. */
function matchProvider(host: string): ProviderSpec | null {
  const candidate = normalizeHost(host);
  for (const id of OEMBED_PROVIDER_IDS) {
    const spec = PROVIDERS[id];
    if (spec.hosts.some((entry) => normalizeHost(entry) === candidate)) return spec;
  }
  return null;
}

/** Read every `application/json+oembed` href from a page's markup. */
function oembedLinkHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const source = html.slice(0, MAX_HTML_SCAN);
  for (const match of source.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attrsOf(match[0]);
    const type = (attrs.type ?? "").toLowerCase();
    const href = attrs.href;
    if (href === undefined) continue;
    if (!type.includes("application/json+oembed")) continue;
    hrefs.push(href);
  }
  return hrefs;
}

/**
 * Resolve the oEmbed endpoint(s) for a target URL. Registry providers come
 * first; any `<link type="application/json+oembed">` in `options.html` is then
 * added as a `"discovery"` hint (resolved against the target URL). Duplicate
 * endpoint URLs collapse. Total: never throws.
 */
export function discoverEndpoint(
  url: string,
  options: DiscoverEndpointOptions = {},
): OEmbedEndpoint[] {
  const results: OEmbedEndpoint[] = [];
  const seen = new Set<string>();
  const push = (endpoint: OEmbedEndpoint): void => {
    if (seen.has(endpoint.endpoint)) return;
    seen.add(endpoint.endpoint);
    results.push(endpoint);
  };

  try {
    const raw = typeof url === "string" ? url.trim() : "";
    let parsed: URL | null = null;
    if (raw !== "") {
      try {
        const candidate = new URL(raw);
        if (candidate.protocol === "http:" || candidate.protocol === "https:") parsed = candidate;
      } catch {
        parsed = null;
      }
    }

    if (parsed) {
      const spec = matchProvider(parsed.hostname);
      if (spec) {
        push({ provider: spec.id, endpoint: spec.endpoint(parsed.toString()), source: "provider" });
      }
    }

    const html = typeof options?.html === "string" ? options.html : "";
    if (html !== "") {
      const base = parsed ? parsed.toString() : undefined;
      for (const href of oembedLinkHrefs(html)) {
        const resolved = resolveUrl(base, href);
        if (resolved !== null) {
          push({ provider: "discovery", endpoint: resolved, source: "discovery" });
        }
      }
    }
  } catch {
    // Total function: a malformed input yields whatever was resolved so far.
  }

  return results;
}

function isOEmbedType(value: unknown): value is OEmbedType {
  return typeof value === "string" && (OEMBED_TYPES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Validate an oEmbed response into a typed record. Accepts a JSON string or an
 * already-parsed object; a missing/unknown `type` (or non-object payload)
 * yields `null`. URL fields must be absolute `http(s)`; `html` is passed
 * through {@link sanitizeEmbedHtml} and omitted when it fails the provider /
 * caller allow-list rather than rejecting the whole payload. Total: never throws.
 */
export function parseOEmbed(
  json: unknown,
  options: ParseOEmbedOptions = {},
): OEmbedData | null {
  try {
    let value: unknown = json;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }

    const record = asRecord(value);
    if (record === null) return null;
    if (!isOEmbedType(record.type)) return null;

    const data: OEmbedData = { type: record.type };

    const title = textField(record.title);
    if (title !== undefined) data.title = title;
    const authorName = textField(record.author_name);
    if (authorName !== undefined) data.authorName = authorName;
    const providerName = textField(record.provider_name);
    if (providerName !== undefined) data.providerName = providerName;
    const thumbnailUrl = httpUrlField(record.thumbnail_url);
    if (thumbnailUrl !== undefined) data.thumbnailUrl = thumbnailUrl;
    const width = dimension(record.width);
    if (width !== undefined) data.width = width;
    const height = dimension(record.height);
    if (height !== undefined) data.height = height;

    if (typeof record.html === "string") {
      const allowedHosts = options.allowedHosts ?? OEMBED_ALLOWED_HOSTS;
      const html = sanitizeEmbedHtml(record.html, { allowedHosts });
      if (html !== null) data.html = html;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Extract card metadata from page markup: the `og:*` namespace, falling back to
 * `twitter:*`, `<meta name=description>` and the document `<title>`, plus the
 * icon `<link>` and an `og:site_name`. URL fields are resolved against
 * `options.baseUrl`; when no icon is present but a base URL is, `/favicon.ico`
 * is synthesised. Total: never throws.
 */
export function parseOpenGraph(
  html: string,
  options: ParseOpenGraphOptions = {},
): OpenGraphData {
  try {
    const source = typeof html === "string" ? html.slice(0, MAX_HTML_SCAN) : "";
    const baseUrl = typeof options?.baseUrl === "string" ? options.baseUrl : undefined;

    // First occurrence wins per key, so an early tag is not clobbered.
    const metas = new Map<string, string>();
    for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = attrsOf(match[0]);
      const key = (attrs.property ?? attrs.name ?? "").toLowerCase().trim();
      const content = attrs.content;
      if (key !== "" && content !== undefined && !metas.has(key)) metas.set(key, content);
    }

    const text = (key: string): string | undefined => {
      const raw = metas.get(key);
      return raw === undefined ? undefined : textField(raw);
    };
    const url = (key: string): string | undefined => {
      const raw = metas.get(key);
      if (raw === undefined) return undefined;
      return resolveUrl(baseUrl, decodeEntities(raw)) ?? undefined;
    };

    let iconHref: string | undefined;
    for (const match of source.matchAll(/<link\b[^>]*>/gi)) {
      const attrs = attrsOf(match[0]);
      const rel = (attrs.rel ?? "").toLowerCase();
      const href = attrs.href;
      if (href === undefined || iconHref !== undefined) continue;
      const tokens = rel.split(/\s+/);
      const isIcon = tokens.includes("icon") || tokens.some((t) => t.startsWith("apple-touch-icon"));
      if (isIcon) iconHref = href;
    }

    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1];
    const title = text("og:title") ?? text("twitter:title") ?? (titleTag ? textField(titleTag) : undefined);
    const description =
      text("og:description") ?? text("twitter:description") ?? text("description");
    const image =
      url("og:image") ??
      url("og:image:url") ??
      url("og:image:secure_url") ??
      url("twitter:image") ??
      url("twitter:image:src");
    const siteName = text("og:site_name") ?? text("application-name");

    let favicon =
      iconHref === undefined ? undefined : resolveUrl(baseUrl, decodeEntities(iconHref)) ?? undefined;
    if (favicon === undefined) favicon = resolveUrl(baseUrl, "/favicon.ico") ?? undefined;

    const og: OpenGraphData = {};
    if (title !== undefined) og.title = title;
    if (description !== undefined) og.description = description;
    if (image !== undefined) og.image = image;
    if (siteName !== undefined) og.siteName = siteName;
    if (favicon !== undefined) og.favicon = favicon;
    return og;
  } catch {
    return {};
  }
}

function sanitizeIframe(source: string, allowed: readonly string[]): string | null {
  const tag = readOpeningTag(source, "iframe");
  if (tag === null) return null;

  const attrs = attrsOf(tag);
  for (const name of Object.keys(attrs)) {
    if (name.startsWith("on")) return null; // event handlers are never allowed
  }
  if (attrs.srcdoc !== undefined) return null;

  const src = httpUrlField(attrs.src);
  if (src === undefined) return null;
  let host: string;
  try {
    host = new URL(src).hostname;
  } catch {
    return null;
  }
  if (!hostAllowed(host, allowed)) return null;

  const out: string[] = [`<iframe src="${escapeAttr(src)}"`];
  for (const name of ["width", "height", "frameborder", "title", "loading", "referrerpolicy"]) {
    const value = attrs[name];
    if (value === undefined || value === "") continue;
    if (name === "width" || name === "height" || name === "frameborder") {
      if (!/^\d{1,5}$/.test(value)) continue;
    }
    out.push(`${name}="${escapeAttr(value)}"`);
  }
  if (attrs.allow !== undefined && attrs.allow !== "") out.push(`allow="${escapeAttr(attrs.allow)}"`);
  if (attrs.sandbox !== undefined && attrs.sandbox !== "") {
    out.push(`sandbox="${escapeAttr(attrs.sandbox)}"`);
  }
  if (/\ballowfullscreen\b/i.test(tag)) out.push("allowfullscreen");
  out.push("></iframe>");
  return out.join(" ");
}

function sanitizeBlockquote(source: string, allowed: readonly string[]): string | null {
  const openTag = readOpeningTag(source, "blockquote");
  if (openTag === null) return null;
  const closeAt = source.toLowerCase().indexOf("</blockquote>", openTag.length);
  if (closeAt < 0) return null;
  const block = source.slice(0, closeAt + "</blockquote>".length);

  for (const name of Object.keys(attrsOf(openTag))) {
    if (name.startsWith("on")) return null;
  }

  // Every URL must be absolute http(s); at least one must be allow-listed so the
  // blockquote can be attributed to the provider domain.
  let sawAllowed = false;
  const urlRe = /\b(?:href|src|cite)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(block)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw === "" || raw.startsWith("#")) continue;
    const url = httpUrlField(raw);
    if (url === undefined) return null; // javascript:/data:/relative → reject
    try {
      if (hostAllowed(new URL(url).hostname, allowed)) sawAllowed = true;
    } catch {
      return null;
    }
  }
  if (!sawAllowed) return null;

  const safeOpenTag = openTag
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  let inner = block.slice(openTag.length, block.length - "</blockquote>".length);
  inner = inner.replace(
    /<(script|style|iframe|object|embed|link|meta|form|input|base)\b[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  inner = inner.replace(/<(script|style|iframe|object|embed|link|meta|form|input|base)\b[^>]*\/?>/gi, "");
  inner = inner.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  return `${safeOpenTag}${inner}</blockquote>`;
}

/**
 * The single gate for untrusted embed HTML. The markup must be rooted at
 * exactly one `<iframe>` or `<blockquote>`; both must reference an allow-listed
 * host, carry no `on*` handlers, and use only absolute `http(s)` URLs. Anything
 * outside the root element (e.g. a trailing `<script>`) is dropped. Returns the
 * sanitised snippet, or `null` when the input cannot be trusted. Total: never
 * throws.
 */
export function sanitizeEmbedHtml(html: unknown, options: SanitizeEmbedOptions): string | null {
  try {
    const allowed = Array.isArray(options?.allowedHosts) ? options.allowedHosts : [];
    const source = typeof html === "string" ? html.trim() : "";
    if (source === "" || source.length > MAX_EMBED_HTML) return null;
    const root = /^<(iframe|blockquote)\b/i.exec(source);
    if (root === null) return null;
    return root[1].toLowerCase() === "iframe"
      ? sanitizeIframe(source, allowed)
      : sanitizeBlockquote(source, allowed);
  } catch {
    return null;
  }
}

/**
 * Merge the oEmbed, OpenGraph and raw `<title>` layers into one card record,
 * preferring oEmbed, then OG, then the title tag. `source` records the winning
 * title layer so callers can reason about provenance. Total: never throws.
 */
export function resolveMetadata(input: ResolveMetadataInput): ResolvedMetadata {
  const oembed = input?.oembed ?? null;
  const og = input?.og ?? null;
  const url = typeof input?.url === "string" ? input.url.trim() : "";
  const tagTitle = textField(input?.title);

  let title: string | undefined;
  let source: MetadataSource;
  if (oembed?.title !== undefined) {
    title = oembed.title;
    source = "oembed";
  } else if (og?.title !== undefined) {
    title = og.title;
    source = "opengraph";
  } else if (tagTitle !== undefined) {
    title = tagTitle;
    source = "title";
  } else {
    title = undefined;
    source = "none";
  }

  const meta: ResolvedMetadata = { url, type: oembed?.type ?? "link", source };
  if (title !== undefined) meta.title = title;
  if (og?.description !== undefined) meta.description = og.description;
  const image = oembed?.thumbnailUrl ?? og?.image;
  if (image !== undefined) meta.image = image;
  if (og?.favicon !== undefined) meta.favicon = og.favicon;
  if (og?.siteName !== undefined) meta.siteName = og.siteName;
  if (oembed?.authorName !== undefined) meta.authorName = oembed.authorName;
  const providerName = oembed?.providerName ?? og?.siteName;
  if (providerName !== undefined) meta.providerName = providerName;
  if (oembed?.html !== undefined) meta.html = oembed.html;
  if (oembed?.width !== undefined) meta.width = oembed.width;
  if (oembed?.height !== undefined) meta.height = oembed.height;
  return meta;
}

/** Hostname of a URL without a leading `www.`, or `""` when unparseable. */
function hostOfUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/**
 * A stable one-line label for a link card: title, else site name, else the
 * URL's host, else {@link FALLBACK_TITLE}. Total: never throws.
 */
export function describeLink(meta: ResolvedMetadata | null | undefined): string {
  const title = typeof meta?.title === "string" ? meta.title.trim() : "";
  if (title !== "") return title;
  const siteName = typeof meta?.siteName === "string" ? meta.siteName.trim() : "";
  if (siteName !== "") return siteName;
  const host = hostOfUrl(meta?.url);
  if (host !== "") return host;
  return FALLBACK_TITLE;
}

/** Label used when a URL yields no usable title at all. */
export const FALLBACK_TITLE = "Untitled link";

/** The card rendered when a URL yields no usable metadata at all. */
export const FALLBACK_CARD: ResolvedMetadata = {
  url: "",
  title: FALLBACK_TITLE,
  type: "link",
  source: "none",
};

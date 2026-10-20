/**
 * Pure helpers for bookmark/embed blocks and the link-preview API.
 * Kept dependency-free so they can be unit-tested and reused on the server.
 *
 * Embed provider resolution goes through ONE typed registry
 * (`EMBED_PROVIDERS` below): exact host match patterns + canonical embed URL
 * builder + iframe policy (`sandbox`/`allow`) per provider.
 * `resolveEmbed()` is the single entry point; anything outside the registry
 * is refused rather than embedded - there is deliberately no generic
 * arbitrary-host iframe (repo SSRF posture).
 */

/** Every provider the registry recognises; `EmbedProvider` adds `"none"`. */
export const EMBED_PROVIDER_IDS = [
  "youtube",
  "vimeo",
  "loom",
  "spotify",
  "soundcloud",
  "figma",
  "codepen",
  "twitter",
  "codesandbox",
  "googledrive",
  "whimsical",
] as const;

export type EmbedProvider = (typeof EMBED_PROVIDER_IDS)[number] | "none";

/** `EmbedProvider` minus the `"none"` sentinel (i.e. a registry key). */
export type EmbedProviderId = Exclude<EmbedProvider, "none">;

export type EmbedInfo = { provider: EmbedProvider; embedUrl: string | null };

/** Full iframe configuration `resolveEmbed()` produces for an allowlisted URL. */
export type ResolvedEmbed = {
  provider: EmbedProviderId;
  embedUrl: string;
  sandbox: string;
  allow: string;
};

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function hostOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** Normalise a user-typed URL (add https:// when no scheme is present). */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+/.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/** Private/reserved IPv4 ranges (audit M1: same literal set feed-guard closes for feeds). */
function isPrivateIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return true; // malformed dotted quad - fail closed
  }
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // "this net", private, loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF + TEST-NET-1
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** IPv6 literal rules: local ranges plus IPv4-mapped addresses judged by their embedded IPv4. */
function isPrivateIpv6(value: string): boolean {
  const h = value.toLowerCase().split("%")[0]; // drop a zone id
  // IPv4-mapped `::ffff:1.2.3.4` / `::ffff:xxxx:xxxx` (WHATWG canonicalises the
  // dotted form to hex pairs) - decide from the embedded IPv4, never guess.
  const mapped = /^(?:0:0:0:0:0:|::)ffff:(.+)$/.exec(h);
  if (mapped) {
    const pair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped[1]);
    if (pair) {
      const hi = Number.parseInt(pair[1], 16);
      const lo = Number.parseInt(pair[2], 16);
      return isPrivateIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    return isPrivateIpv4(mapped[1]); // dotted form; anything else fails closed
  }
  if (h === "::" || h === "::1" || h === "0:0:0:0:0:0:0:0" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (/^ff/.test(h)) return true; // ff00::/8 multicast
  if (/^2001:db8:/.test(h)) return true; // documentation range
  return false;
}

/**
 * Reject loopback/link-local/private hosts to prevent SSRF in the preview API.
 * Called with `new URL(value).hostname`, which is WHATWG-canonical: IPv6 stays
 * bracketed (`[::1]`, `[::ffff:7f00:1]`), FQDN root dots survive (`localhost.`)
 * and `*.localhost` names resolve to loopback - all three must be caught here
 * or the route fetches them (audit M1; B87 pins every branch).
 */
export function isPrivateHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (!h) return true;
  if (h.endsWith(".")) h = h.slice(0, -1); // FQDN root dot: "localhost." !== "localhost"
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // WHATWG brackets
  if (!h) return true;
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  if (h.includes(":")) return isPrivateIpv6(h);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIpv4(h);
  return false;
}

/** Inputs handed to a provider's embed builder. */
export type BuildContext = {
  /** Parsed, normalised input URL. */
  parsed: URL;
  /** Normalised input URL as a string (for providers that wrap it whole). */
  url: string;
  /** Hostname, lower-cased with any `www.` prefix stripped. */
  host: string;
};

/** One allowlisted provider: match patterns, embed builder, iframe policy. */
export type EmbedProviderDefinition = {
  /** Exact hosts (lower-case, no `www.` prefix) this provider may match. */
  readonly hosts: readonly string[];
  /** `sandbox` attribute for the provider's iframe. */
  readonly sandbox: string;
  /** Renderer metadata: label, title, aspect ratio and `allow` attribute. */
  readonly meta: EmbedMeta;
  /** Build the canonical embed URL, or `null` when the path is not embeddable. */
  readonly build: (ctx: BuildContext) => string | null;
};

/**
 * Shared `sandbox` token sets. Every embed frame gets scripts + its own
 * origin + popups + forms; media players add the presentation API, code
 * playgrounds add modals. Top-frame navigation is NEVER granted.
 */
const SANDBOX_PLAYER = "allow-scripts allow-same-origin allow-popups allow-forms";
const SANDBOX_MEDIA = `${SANDBOX_PLAYER} allow-presentation`;
const SANDBOX_PLAYGROUND = `${SANDBOX_PLAYER} allow-modals`;

/**
 * THE provider allowlist registry: the ONLY source of truth for which hosts
 * may embed, how each URL shape canonicalises, and what the resulting iframe
 * is allowed to do (`sandbox` + `allow`). `Record<EmbedProviderId, ...>` is
 * exhaustive, so a provider cannot be registered without meta/policy, and no
 * host outside these patterns can ever produce a rich embed.
 */
export const EMBED_PROVIDERS: Record<EmbedProviderId, EmbedProviderDefinition> = {
  youtube: {
    hosts: ["youtube.com", "m.youtube.com", "youtube-nocookie.com", "youtu.be"],
    sandbox: SANDBOX_MEDIA,
    meta: {
      label: "YouTube",
      title: "YouTube video",
      aspectRatio: "16 / 9",
      allow: "accelerometer; clipboard-write; encrypted-media; picture-in-picture; web-share",
    },
    build: buildYoutubeEmbed,
  },
  vimeo: {
    hosts: ["vimeo.com", "player.vimeo.com"],
    sandbox: SANDBOX_MEDIA,
    meta: {
      label: "Vimeo",
      title: "Vimeo video",
      aspectRatio: "16 / 9",
      allow: "autoplay; fullscreen; picture-in-picture",
    },
    build: buildVimeoEmbed,
  },
  loom: {
    hosts: ["loom.com"],
    sandbox: SANDBOX_MEDIA,
    meta: {
      label: "Loom",
      title: "Loom recording",
      aspectRatio: "16 / 9",
      allow: "autoplay; fullscreen; picture-in-picture",
    },
    build: buildLoomEmbed,
  },
  spotify: {
    hosts: ["open.spotify.com"],
    sandbox: SANDBOX_MEDIA,
    meta: {
      label: "Spotify",
      title: "Spotify player",
      aspectRatio: "1 / 1",
      allow: "autoplay; clipboard-write; encrypted-media; picture-in-picture",
    },
    build: buildSpotifyEmbed,
  },
  soundcloud: {
    hosts: ["soundcloud.com"],
    sandbox: SANDBOX_MEDIA,
    meta: {
      label: "SoundCloud",
      title: "SoundCloud player",
      aspectRatio: "16 / 9",
      allow: "autoplay; encrypted-media; picture-in-picture",
    },
    build: buildSoundcloudEmbed,
  },
  figma: {
    hosts: ["figma.com"],
    sandbox: SANDBOX_PLAYER,
    meta: {
      label: "Figma",
      title: "Figma file",
      aspectRatio: "4 / 3",
      allow: "clipboard-write; encrypted-media",
    },
    build: buildFigmaEmbed,
  },
  codepen: {
    hosts: ["codepen.io"],
    sandbox: SANDBOX_PLAYGROUND,
    meta: {
      label: "CodePen",
      title: "CodePen embed",
      aspectRatio: "16 / 9",
      allow: "clipboard-write",
    },
    build: buildCodepenEmbed,
  },
  twitter: {
    hosts: ["twitter.com", "x.com", "mobile.twitter.com", "mobile.x.com", "platform.twitter.com"],
    sandbox: SANDBOX_PLAYER,
    meta: {
      label: "X (Twitter)",
      title: "Post",
      aspectRatio: "16 / 9",
      allow: "clipboard-write; encrypted-media; picture-in-picture",
    },
    build: buildTwitterEmbed,
  },
  codesandbox: {
    hosts: ["codesandbox.io"],
    sandbox: SANDBOX_PLAYGROUND,
    meta: {
      label: "CodeSandbox",
      title: "CodeSandbox embed",
      aspectRatio: "16 / 9",
      allow: "clipboard-write",
    },
    build: buildCodesandboxEmbed,
  },
  googledrive: {
    hosts: ["drive.google.com"],
    sandbox: SANDBOX_PLAYER,
    meta: {
      label: "Google Drive",
      title: "Google Drive preview",
      aspectRatio: "4 / 3",
      allow: "fullscreen",
    },
    build: buildGoogleDriveEmbed,
  },
  whimsical: {
    hosts: ["whimsical.com"],
    sandbox: SANDBOX_PLAYER,
    meta: {
      label: "Whimsical",
      title: "Whimsical board",
      aspectRatio: "4 / 3",
      allow: "fullscreen; clipboard-write",
    },
    build: buildWhimsicalEmbed,
  },
};

/**
 * Hosts whose content is willing to be rendered inside a sandboxed iframe.
 * DERIVED from the registry so the two can never drift: this IS the embed
 * allowlist, and `resolveEmbed()` refuses everything outside it, so both the
 * editor node view and the read-only doc renderer fall back to a bookmark
 * card (or an input) instead of an arbitrary iframe.
 */
export const EMBED_HOST_ALLOWLIST: readonly string[] = EMBED_PROVIDER_IDS.flatMap(
  (id) => EMBED_PROVIDERS[id].hosts,
);

/** May this host be embedded? (www prefix tolerated, no wildcard subdomains.) */
export function isEmbedHostAllowed(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  if (!normalized) return false;
  return EMBED_HOST_ALLOWLIST.includes(normalized);
}

/** How long into the video the embed should start: `90`, `1m30s`, `1h2m3s`. */
export function parseStartTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const raw = value.trim().replace(/^t=/i, "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const seconds =
    Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

/** Renderer-facing description of a provider (label, aspect, iframe `allow`). */
export type EmbedMeta = {
  label: string;
  title: string;
  aspectRatio: string;
  allow: string;
};

/** Metadata for a provider, or `null` when the URL was not embeddable. */
export function embedMeta(provider: EmbedProvider): EmbedMeta | null {
  return provider === "none" ? null : EMBED_PROVIDERS[provider].meta;
}

/** YouTube: watch / share / shorts / live / embed / nocookie → canonical embed. */
function buildYoutubeEmbed({ parsed, host }: BuildContext): string | null {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (host === "youtu.be") {
    id = parts[0] ?? null;
  } else if (parts[0] === "watch") {
    id = parsed.searchParams.get("v");
  } else if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live" || parts[0] === "v") {
    id = parts[1] ?? null;
  }
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const start =
    parseStartTime(parsed.searchParams.get("start")) ?? parseStartTime(parsed.searchParams.get("t"));
  return `https://www.youtube.com/embed/${id}${start ? `?start=${start}` : ""}`;
}

/** Vimeo: /<id>, /video/<id>, /channels/<c>/<id>, /groups/<g>/videos/<id>. */
function buildVimeoEmbed({ parsed }: BuildContext): string | null {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const numeric = (value: string | undefined): string | null =>
    value && /^\d+$/.test(value) ? value : null;

  let id: string | null = null;
  if (parts[0] === "video") id = numeric(parts[1]);
  else if (parts[0] === "channels" || parts[0] === "showcase" || parts[0] === "album")
    id = numeric(parts[2]);
  else if (parts[0] === "groups") id = numeric(parts[3]);
  else id = numeric(parts[0]);
  if (!id) return null;

  const start =
    parseStartTime(parsed.searchParams.get("t")) ??
    parseStartTime(parsed.hash.replace(/^#t=?/i, ""));
  return `https://player.vimeo.com/video/${id}${start ? `#t=${start}` : ""}`;
}

/** Loom: /share/<id>, /embed/<id> or the bare /<id> recording URL. */
function buildLoomEmbed({ parsed }: BuildContext): string | null {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const id = parts[0] === "share" || parts[0] === "embed" ? parts[1] : parts[0];
  return id ? `https://www.loom.com/embed/${id}` : null;
}

/** Spotify: wraps share links in /embed/, passes embed links through. */
function buildSpotifyEmbed({ parsed, url }: BuildContext): string | null {
  if (parsed.pathname.startsWith("/embed/")) {
    // Keep the query string: share links carry context/`si` params the
    // embed player needs (`?context=spotify:playlist:...`).
    return url;
  }
  return `https://open.spotify.com/embed${parsed.pathname}${parsed.search}`;
}

/** SoundCloud: wraps the original URL in the widget player. */
function buildSoundcloudEmbed({ url }: BuildContext): string | null {
  return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`;
}

/** Figma: wraps the original URL in the embed host endpoint. */
function buildFigmaEmbed({ url }: BuildContext): string | null {
  return `https://www.figma.com/embed?embed_host=noema&url=${encodeURIComponent(url)}`;
}

/** CodePen: /<team>/pen/<slug> (or /pen/<slug>) → /embed/<slug>. */
function buildCodepenEmbed({ parsed }: BuildContext): string | null {
  if (!/\/pen\/.+/.test(parsed.pathname)) return null; // profiles/pages are not embeds
  return `https://codepen.io${parsed.pathname.replace(/\/pen\//, "/embed/")}`;
}

/** Twitter/X: status URLs → the platform syndication iframe (digits-only id). */
function buildTwitterEmbed({ parsed }: BuildContext): string | null {
  const parts = parsed.pathname.split("/").filter(Boolean);
  // /<user>/status/<id>, /i/web/status/<id>, /<user>/status/<id>/photo/1
  const statusAt = parts.indexOf("status");
  if (statusAt !== -1) {
    const id = parts[statusAt + 1];
    if (!id || !/^\d+$/.test(id)) return null;
    return `https://platform.twitter.com/embed/Tweet.html?id=${id}`;
  }
  // Canonical iframe form: platform.twitter.com/embed/Tweet.html?id=<id>
  if (/\/embed\//i.test(parsed.pathname)) {
    const id = parsed.searchParams.get("id");
    if (!id || !/^\d+$/.test(id)) return null;
    return `https://platform.twitter.com/embed/Tweet.html?id=${id}`;
  }
  return null;
}

/** CodeSandbox: /s/<id>, /p/sandbox/<id> or /embed/<id> → /embed/<id>. */
function buildCodesandboxEmbed({ parsed }: BuildContext): string | null {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let rest: readonly string[];
  if (parts[0] === "s") rest = parts.slice(1);
  else if (parts[0] === "p" && parts[1] === "sandbox") rest = parts.slice(2);
  else if (parts[0] === "embed") rest = parts.slice(1);
  else return null;
  if (rest.length === 0) return null;
  if (rest.some((segment) => !/^[A-Za-z0-9-]+$/.test(segment))) return null;
  return `https://codesandbox.io/embed/${rest.join("/")}`;
}

/**
 * Google Drive: `/file/d/<id>/view`, `/file/<id>/view` and `/file/d/<id>` all
 * canonicalise to the `/preview` iframe; `/drive/[u/<n>/]folders/<id>` to the
 * embedded folder view. Query params (`usp=...`, `t=...`) are tracking-only and
 * dropped; the id must be the Drive token (alphanumerics, `_`, `-`).
 */
const DRIVE_ID = /^[A-Za-z0-9_-]+$/;

function buildGoogleDriveEmbed({ parsed }: BuildContext): string | null {
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] === "file") {
    const id = parts[1] === "d" ? parts[2] : parts[1];
    return id && DRIVE_ID.test(id) ? `https://drive.google.com/file/d/${id}/preview` : null;
  }
  const foldersAt = parts.indexOf("folders");
  if (foldersAt !== -1) {
    const id = parts[foldersAt + 1];
    return id && DRIVE_ID.test(id)
      ? `https://drive.google.com/embeddedfolderview?id=${id}#list`
      : null;
  }
  return null;
}

/**
 * Whimsical: `/embed/<id>` passes through; `/<board-name>-<id>` and the
 * workspace-prefixed `/<workspace>/<board-name>-<id>` shapes extract the
 * trailing id token. Tracking query params are dropped.
 */
const WHIMSICAL_ID = /^[A-Za-z0-9]{8,}$/;

function buildWhimsicalEmbed({ parsed }: BuildContext): string | null {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const segment = parts[0] === "embed" ? parts[1] : parts[parts.length - 1];
  const id = segment?.split("-").pop();
  return id && WHIMSICAL_ID.test(id) ? `https://whimsical.com/embed/${id}` : null;
}

/** Which registry entry (if any) claims this exact, normalised host? */
function providerForHost(host: string): EmbedProviderId | null {
  for (const id of EMBED_PROVIDER_IDS) {
    if (EMBED_PROVIDERS[id].hosts.includes(host)) return id;
  }
  return null;
}

/**
 * Resolve a URL through the provider registry to a full iframe configuration
 * (`provider` + canonical `embedUrl` + `sandbox` + `allow`), or `null`.
 *
 * `null` means "not embeddable": a non-http(s) URL, a host outside the
 * allowlist (unknown/lookalike/private hosts included), or an allowlisted
 * host whose path has no canonical embed. Callers must fall back to a
 * bookmark card or an input - never to a generic arbitrary-host iframe.
 */
export function resolveEmbed(value: string): ResolvedEmbed | null {
  const url = normalizeUrl(value);
  if (!isHttpUrl(url)) return null;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  // Provider allowlist first: nothing outside it ever becomes an iframe.
  if (!host || !isEmbedHostAllowed(host)) return null;
  const provider = providerForHost(host);
  if (!provider) return null;

  const definition = EMBED_PROVIDERS[provider];
  const embedUrl = definition.build({ parsed, url, host });
  if (!embedUrl) return null;
  return { provider, embedUrl, sandbox: definition.sandbox, allow: definition.meta.allow };
}

/** Map a URL to a safe iframe embed when the provider supports it. */
export function detectEmbed(value: string): EmbedInfo {
  const resolved = resolveEmbed(value);
  return resolved
    ? { provider: resolved.provider, embedUrl: resolved.embedUrl }
    : { provider: "none", embedUrl: null };
}

/**
 * Extract only http(s) image URLs from untrusted preview metadata, and refuse
 * private/internal hosts: the browser fetches these URLs, so a preview card
 * must never point the victim's browser at loopback, RFC1918 or cloud
 * metadata addresses (audit B10).
 */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !isHttpUrl(value)) return null;
  const url = new URL(value); // isHttpUrl already proved that it parses
  if (isPrivateHost(url.hostname)) return null;
  return value;
}

export type LinkMetadata = {
  title: string | null;
  description: string | null;
  image: string | null;
  icon: string | null;
};

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();

/** Read OpenGraph/HTML metadata from a page's markup (regex-based, no DOM). */
export function parseHtmlMetadata(html: string): LinkMetadata {
  const head = html.slice(0, 200_000);

  const metaContent = (key: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i"),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(head);
      if (match?.[1]) return decodeEntities(match[1]);
    }
    return null;
  };

  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  const iconMatch =
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']*)["']/i.exec(head)?.[1];

  return {
    title: metaContent("og:title") ?? (titleTag ? decodeEntities(titleTag) : null),
    description: metaContent("og:description") ?? metaContent("description"),
    image: metaContent("og:image"),
    icon: iconMatch ? decodeEntities(iconMatch) : null,
  };
}


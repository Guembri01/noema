/**
 * Pure helpers for bookmark/embed blocks and the link-preview API.
 * Kept dependency-free so they can be unit-tested and reused on the server.
 */

export type EmbedProvider =
  | "youtube"
  | "vimeo"
  | "loom"
  | "spotify"
  | "soundcloud"
  | "figma"
  | "codepen"
  | "none";

export type EmbedInfo = { provider: EmbedProvider; embedUrl: string | null };

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

/**
 * Hosts whose content is willing to be rendered inside a sandboxed iframe.
 * This IS the embed allowlist: `detectEmbed` refuses everything else, so both
 * the editor node view and the read-only doc renderer fall back to a bookmark
 * card (or an input) instead of an arbitrary iframe.
 */
export const EMBED_HOST_ALLOWLIST = [
  "youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
  "vimeo.com",
  "player.vimeo.com",
  "loom.com",
  "open.spotify.com",
  "soundcloud.com",
  "figma.com",
  "codepen.io",
] as const;

/** May this host be embedded? (www prefix tolerated, no wildcard subdomains.) */
export function isEmbedHostAllowed(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  if (!normalized) return false;
  return (EMBED_HOST_ALLOWLIST as readonly string[]).includes(normalized);
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

const PROVIDER_META: Record<Exclude<EmbedProvider, "none">, EmbedMeta> = {
  youtube: {
    label: "YouTube",
    title: "YouTube video",
    aspectRatio: "16 / 9",
    allow: "accelerometer; clipboard-write; encrypted-media; picture-in-picture; web-share",
  },
  vimeo: {
    label: "Vimeo",
    title: "Vimeo video",
    aspectRatio: "16 / 9",
    allow: "autoplay; fullscreen; picture-in-picture",
  },
  loom: {
    label: "Loom",
    title: "Loom recording",
    aspectRatio: "16 / 9",
    allow: "autoplay; fullscreen; picture-in-picture",
  },
  spotify: {
    label: "Spotify",
    title: "Spotify player",
    aspectRatio: "1 / 1",
    allow: "autoplay; clipboard-write; encrypted-media; picture-in-picture",
  },
  soundcloud: {
    label: "SoundCloud",
    title: "SoundCloud player",
    aspectRatio: "16 / 9",
    allow: "autoplay; encrypted-media; picture-in-picture",
  },
  figma: {
    label: "Figma",
    title: "Figma file",
    aspectRatio: "4 / 3",
    allow: "clipboard-write; encrypted-media",
  },
  codepen: {
    label: "CodePen",
    title: "CodePen embed",
    aspectRatio: "16 / 9",
    allow: "clipboard-write",
  },
};

/** Metadata for a provider, or `null` when the URL was not embeddable. */
export function embedMeta(provider: EmbedProvider): EmbedMeta | null {
  return provider === "none" ? null : PROVIDER_META[provider];
}

/** YouTube: watch / share / shorts / live / embed / nocookie → canonical embed. */
function youtubeEmbed(parsed: URL, host: string): EmbedInfo {
  const parts = parsed.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (host === "youtu.be") {
    id = parts[0] ?? null;
  } else if (parts[0] === "watch") {
    id = parsed.searchParams.get("v");
  } else if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live" || parts[0] === "v") {
    id = parts[1] ?? null;
  }
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return { provider: "none", embedUrl: null };
  const start =
    parseStartTime(parsed.searchParams.get("start")) ?? parseStartTime(parsed.searchParams.get("t"));
  const query = start ? `?start=${start}` : "";
  return { provider: "youtube", embedUrl: `https://www.youtube.com/embed/${id}${query}` };
}

/** Vimeo: /<id>, /video/<id>, /channels/<c>/<id>, /groups/<g>/videos/<id>. */
function vimeoEmbed(parsed: URL): EmbedInfo {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const numeric = (value: string | undefined): string | null =>
    value && /^\d+$/.test(value) ? value : null;

  let id: string | null = null;
  if (parts[0] === "video") id = numeric(parts[1]);
  else if (parts[0] === "channels" || parts[0] === "showcase" || parts[0] === "album")
    id = numeric(parts[2]);
  else if (parts[0] === "groups") id = numeric(parts[3]);
  else id = numeric(parts[0]);
  if (!id) return { provider: "none", embedUrl: null };

  const start =
    parseStartTime(parsed.searchParams.get("t")) ??
    parseStartTime(parsed.hash.replace(/^#t=?/i, ""));
  const hash = start ? `#t=${start}` : "";
  return { provider: "vimeo", embedUrl: `https://player.vimeo.com/video/${id}${hash}` };
}

/** Map a URL to a safe iframe embed when the provider supports it. */
export function detectEmbed(value: string): EmbedInfo {
  const url = normalizeUrl(value);
  if (!isHttpUrl(url)) return { provider: "none", embedUrl: null };
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();

  // Provider allowlist first: nothing outside it ever becomes an iframe.
  if (!isEmbedHostAllowed(host)) return { provider: "none", embedUrl: null };

  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "youtu.be"
  ) {
    return youtubeEmbed(parsed, host);
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    return vimeoEmbed(parsed);
  }
  if (host === "loom.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const id = parts[0] === "share" || parts[0] === "embed" ? parts[1] : parts[0];
    return id
      ? { provider: "loom", embedUrl: `https://www.loom.com/embed/${id}` }
      : { provider: "none", embedUrl: null };
  }
  if (host === "open.spotify.com") {
    if (!parsed.pathname.startsWith("/embed/")) {
      // Keep the query string: share links carry context/`si` params the
      // embed player needs (`?context=spotify:playlist:...`).
      return {
        provider: "spotify",
        embedUrl: `https://open.spotify.com/embed${parsed.pathname}${parsed.search}`,
      };
    }
    return { provider: "spotify", embedUrl: url };
  }
  if (host === "soundcloud.com") {
    return {
      provider: "soundcloud",
      embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`,
    };
  }
  if (host === "figma.com") {
    return {
      provider: "figma",
      embedUrl: `https://www.figma.com/embed?embed_host=noema&url=${encodeURIComponent(url)}`,
    };
  }
  if (host === "codepen.io") {
    const slug = parsed.pathname.replace(/\/pen\//, "/embed/");
    return { provider: "codepen", embedUrl: `https://codepen.io${slug}` };
  }
  return { provider: "none", embedUrl: null };
}

/** Extract only http(s) image URLs from untrusted preview metadata. */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !isHttpUrl(value)) return null;
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


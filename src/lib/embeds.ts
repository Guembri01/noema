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

/** Reject loopback/link-local/private hosts to prevent SSRF in the preview API. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** Map a URL to a safe iframe embed when the provider supports it. */
export function detectEmbed(value: string): EmbedInfo {
  const url = normalizeUrl(value);
  if (!isHttpUrl(url)) return { provider: "none", embedUrl: null };
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./i, "");

  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    const id =
      host === "youtu.be"
        ? parsed.pathname.slice(1).split("/")[0]
        : parsed.searchParams.get("v");
    return id
      ? { provider: "youtube", embedUrl: `https://www.youtube.com/embed/${id}` }
      : { provider: "none", embedUrl: null };
  }
  if (host === "vimeo.com") {
    const id = parsed.pathname.split("/").filter(Boolean)[0];
    return id
      ? { provider: "vimeo", embedUrl: `https://player.vimeo.com/video/${id}` }
      : { provider: "none", embedUrl: null };
  }
  if (host === "loom.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const id = parts[0] === "share" || parts[0] === "embed" ? parts[1] : parts[0];
    return id
      ? { provider: "loom", embedUrl: `https://www.loom.com/embed/${id}` }
      : { provider: "none", embedUrl: null };
  }
  if (host === "open.spotify.com") {
    return { provider: "spotify", embedUrl: `https://open.spotify.com/embed${parsed.pathname}` };
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


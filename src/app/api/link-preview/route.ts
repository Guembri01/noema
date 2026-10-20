import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hostOf, isHttpUrl, normalizeUrl, safeImageUrl } from "@/lib/embeds";
import { isPreviewable, parseLinkMeta, resolveUrl } from "@/lib/link-preview-meta";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 6000;

/** Resolved preview card sent to the client (and hashed into the `ETag`). */
type PreviewCard = {
  url: string;
  host: string;
  title: string | null;
  description: string | null;
  image: string | null;
  icon: string | null;
};

/**
 * Shared-cache policy for a resolved card: a short CDN TTL plus
 * `stale-while-revalidate` so a burst of revalidations is served from cache
 * while one background fetch refreshes it. Degraded/error cards are `no-store`
 * so a transient upstream failure is never cached.
 */
const RESOLVED_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";
const NO_STORE = "no-store";

/** Strong `ETag` over the serialised card: identical metadata yields one tag. */
function etagFor(card: PreviewCard): string {
  const digest = createHash("sha256").update(JSON.stringify(card)).digest("hex");
  return `"${digest.slice(0, 32)}"`;
}

/**
 * RFC 7232 weak comparison of an `If-None-Match` header against our strong tag.
 * Tolerates a comma-separated list, a `W/` prefix and the `*` wildcard.
 */
function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  for (const candidate of header.split(",")) {
    const token = candidate.trim().replace(/^W\//, "");
    if (token === "*" || token === etag) return true;
  }
  return false;
}

/**
 * Response for a resolved card: cacheable with validators, or an empty 304 when
 * the caller's `If-None-Match` matches so it reuses its cached copy.
 */
function cardResponse(card: PreviewCard, request: Request): NextResponse {
  const etag = etagFor(card);
  const headers = { "cache-control": RESOLVED_CACHE_CONTROL, etag };
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(card, { headers });
}

/**
 * Fetch OpenGraph metadata for a URL so bookmark blocks can render a card.
 * Guards against SSRF via `isPreviewable` (http(s) only, no private/loopback
 * hosts), caps the response size and enforces a timeout. The resolved card is
 * cached with an `ETag` and conditional `If-None-Match` handling.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "preview", 60, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = new URL(request.url).searchParams.get("url") ?? "";
  const url = normalizeUrl(raw);
  if (!isHttpUrl(url)) {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (!isPreviewable(url)) {
    return NextResponse.json({ error: "Blocked host" }, { status: 400 });
  }

  const fallback: PreviewCard = {
    url,
    host: hostOf(url),
    title: null,
    description: null,
    image: null,
    icon: null,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "NoemaBot/1.0 (+link-preview)", accept: "text/html" },
    });
    clearTimeout(timer);

    if (!response.ok || !response.body) {
      return NextResponse.json(fallback, { headers: { "cache-control": NO_STORE } });
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        chunks.push(value);
        if (received > MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    // `link-preview-meta` reads og:*/twitter:*/title/description/favicon and
    // resolves every URL field against the fetched page, replacing the ad-hoc
    // regex + `new URL` parsing that used to live here.
    const meta = parseLinkMeta(html, { baseUrl: response.url });

    const card: PreviewCard = {
      url,
      host: hostOf(url),
      title: meta.title ?? null,
      description: meta.description ?? null,
      image: safeImageUrl(resolveUrl(response.url, meta.image ?? "")),
      icon: safeImageUrl(resolveUrl(response.url, meta.favicon ?? "")),
    };

    return cardResponse(card, request);
  } catch {
    return NextResponse.json(fallback, { headers: { "cache-control": NO_STORE } });
  }
}

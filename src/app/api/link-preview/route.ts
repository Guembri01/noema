import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hostOf, isHttpUrl, normalizeUrl, safeImageUrl } from "@/lib/embeds";
import { parseLinkMeta, resolveUrl } from "@/lib/link-preview-meta";
import { rateLimit } from "@/lib/api-guard";
import {
  defaultHostResolver,
  isBlockedOutboundTarget,
  safeFetchGuarded,
  type HostResolver,
} from "@/lib/feed-guard";

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
 * DNS resolution under the request deadline: `dns.lookup` takes no abort
 * signal, so the lookup races the signal and fails closed when the deadline
 * passes. A hung resolver must not hold the request open.
 */
function deadlineResolver(signal: AbortSignal): HostResolver {
  return async (hostname) => {
    if (signal.aborted) throw new Error("preview deadline exceeded");
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        defaultHostResolver(hostname),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("preview deadline exceeded"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * The card's image/icon are fetched by the victim's browser, so they get the
 * same gate as the page itself: no private host, no DNS answer in private
 * space. `checkedHosts` holds the hosts already validated in this request
 * (the page host first), so a same-host asset needs no second lookup.
 */
async function safeAssetUrl(
  value: string | null,
  checkedHosts: Set<string>,
  resolve: HostResolver,
): Promise<string | null> {
  const asset = safeImageUrl(value);
  if (asset === null) return null;
  let host: string;
  try {
    host = new URL(asset).hostname;
  } catch {
    return null;
  }
  if (checkedHosts.has(host)) return asset;
  // The strict flavour of the one gate: the preview route asks for NO
  // exemption - neither the development one nor the operator opt-in - so it
  // stays strict in every environment.
  if (await isBlockedOutboundTarget(asset, { resolve })) return null;
  checkedHosts.add(host);
  return asset;
}

/**
 * Fetch OpenGraph metadata for a URL so bookmark blocks can render a card.
 *
 * The SSRF gate is the shared guard (`safeFetchGuarded` in
 * `src/lib/feed-guard.ts`): the target is resolved through DNS, every answer
 * must be public, redirects are followed manually and every hop is
 * re-validated. A literal-host check alone is not enough - `169.254.169.254`
 * answered by a public name (`…nip.io`) and a 30x hop into a metadata IP
 * both slip through it (audit B10).
 *
 * The response size is capped and the whole operation - DNS included - runs
 * under one deadline. The resolved card is cached with an `ETag` and
 * conditional `If-None-Match` handling.
 */
export async function GET(request: Request) {
  const limited = rateLimit(request, "preview", 60, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = new URL(request.url).searchParams.get("url") ?? "";
  const url = normalizeUrl(raw);
  if (!isHttpUrl(url)) {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  const fallback: PreviewCard = {
    url,
    host: hostOf(url),
    title: null,
    description: null,
    image: null,
    icon: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resolve = deadlineResolver(controller.signal);
    const result = await safeFetchGuarded(
      url,
      {
        signal: controller.signal,
        headers: { "user-agent": "NoemaBot/1.0 (+link-preview)", accept: "text/html" },
      },
      // No development exemption here: the preview route has no hermetic mock
      // to serve, so it stays strict in every environment. The guarded fetch
      // never asks for the operator opt-in either.
      { resolve },
    );
    if (!result.ok) {
      if (result.reason === "blocked") {
        return NextResponse.json({ error: "Blocked host" }, { status: 400 });
      }
      return NextResponse.json(fallback, { headers: { "cache-control": NO_STORE } });
    }

    const response = result.response;
    // Relative metadata resolves against the page that answered, not against
    // the URL the caller asked for.
    const baseUrl = result.finalUrl;

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
    const meta = parseLinkMeta(html, { baseUrl });

    // The page host was validated by the guard; assets on it need no lookup.
    const checkedHosts = new Set<string>([new URL(baseUrl).hostname]);
    const card: PreviewCard = {
      url,
      host: hostOf(url),
      title: meta.title ?? null,
      description: meta.description ?? null,
      image: await safeAssetUrl(resolveUrl(baseUrl, meta.image ?? ""), checkedHosts, resolve),
      icon: await safeAssetUrl(resolveUrl(baseUrl, meta.favicon ?? ""), checkedHosts, resolve),
    };

    return cardResponse(card, request);
  } catch {
    return NextResponse.json(fallback, { headers: { "cache-control": NO_STORE } });
  } finally {
    clearTimeout(timer);
  }
}

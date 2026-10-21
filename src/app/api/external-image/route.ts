import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/api-guard";
import { isSvgSafe } from "@/lib/clipboard-image";
import { isAllowedExternalImageHost } from "@/lib/external-image";
import { fetchPinnedTarget, resolveOutboundTarget } from "@/lib/feed-guard";

export const runtime = "nodejs";

/**
 * B69 - the server-side proxy for external pictures.
 *
 * The document renderer points every picture that lives on another host at
 * this route, so the visitor's browser asks THIS server for the bytes and the
 * host that hosts the picture never sees the visitor's IP address (nor the
 * `Referer` of the share page, which names the instance the visitor came
 * from).
 *
 * The route is not an open relay:
 *
 * - only the hosts on the allowlist are fetched at all - every other host is
 *   refused by name, before any network access;
 * - the fetch runs through the shared SSRF guard (`src/lib/feed-guard.ts`):
 *   loopback, RFC1918, link-local (the cloud metadata address) and every other
 *   private range are refused, the DNS answer is validated, and the request is
 *   made to the validated address (no rebinding window);
 * - a redirect is NEVER followed - a permitted host cannot bounce the request
 *   to an internal one;
 * - only a known image type is served, and an SVG has to pass the same safety
 *   check an uploaded one does (no script, no event handler, no external
 *   reference - an SVG is an active document);
 * - the response is capped in size and carries `nosniff` plus a sandboxing
 *   CSP, so the bytes cannot be turned into a document on this origin.
 *
 * The route is public on purpose: the share pages it serves are public. The
 * allowlist and the rate limit are what bound it.
 */

/** The largest picture the proxy serves (bytes). */
const MAX_BYTES = 5 * 1024 * 1024;

/** The deadline for the whole upstream exchange, DNS included. */
const TIMEOUT_MS = 8_000;

/**
 * The image types the proxy serves. Small and explicit: a host that answers
 * with anything else (an HTML error page, a PDF) is refused.
 */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
]);

/** The statuses that would send the browser somewhere else - never followed. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Read the upstream body, refusing anything over the cap. The stream is read
 * chunk by chunk so an endless response cannot exhaust the server's memory.
 */
async function readCapped(response: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("url") ?? "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  // Only http(s) is ever fetched: a `data:`, `file:` or `javascript:` target
  // is not a picture this route can serve.
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  // The allowlist is the first gate: a host that is not on it is never
  // contacted, so the route cannot be used as a relay for arbitrary targets.
  if (!isAllowedExternalImageHost(target.hostname)) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  }

  // One bucket per host: a page full of pictures cannot starve the pictures
  // of another host.
  const limited = rateLimit(request, `external-image:${target.hostname}`, 120, 60_000);
  if (limited) return limited;

  // The shared SSRF guard: the scheme, the host ranges and every DNS answer
  // are checked, and the request is made to the address that was validated.
  const resolved = await resolveOutboundTarget(target.href, {
    allowLoopbackInDevelopment: false,
  });
  if (resolved.blocked) {
    return NextResponse.json({ error: "Blocked host" }, { status: 403 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchPinnedTarget(
      target.href,
      {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "image/*",
          "user-agent": "NoemaBot/1.0 (+external-image)",
        },
      },
      resolved.address,
    );
    // A redirect is refused, never followed: the target of the `Location` is
    // not requested, so a permitted host cannot bounce the request to an
    // internal address.
    if (REDIRECT_STATUSES.has(response.status)) {
      return NextResponse.json({ error: "Redirect refused" }, { status: 502 });
    }
    if (!response.ok) {
      return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
    }

    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) {
      return NextResponse.json({ error: "Not an image" }, { status: 415 });
    }

    const body = await readCapped(response, MAX_BYTES);
    if (body === null) {
      return NextResponse.json({ error: "Image too large" }, { status: 413 });
    }
    // An SVG is an active document: it has to pass the same check an uploaded
    // one does, or it is refused.
    if (type === "image/svg+xml" && !isSvgSafe(new TextDecoder().decode(body))) {
      return NextResponse.json({ error: "Unsafe image" }, { status: 415 });
    }

    return new NextResponse(body, {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=86400, s-maxage=86400",
        "x-content-type-options": "nosniff",
        // The bytes are a picture, never a document on this origin.
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

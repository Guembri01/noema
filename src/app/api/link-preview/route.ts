import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  hostOf,
  isHttpUrl,
  isPrivateHost,
  normalizeUrl,
  parseHtmlMetadata,
  safeImageUrl,
} from "@/lib/embeds";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 6000;

/**
 * Fetch OpenGraph metadata for a URL so bookmark blocks can render a card.
 * Guards against SSRF (http(s) only, no private/loopback hosts), caps the
 * response size and enforces a timeout.
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
  const host = new URL(url).hostname;
  if (isPrivateHost(host)) {
    return NextResponse.json({ error: "Blocked host" }, { status: 400 });
  }

  const fallback = { url, host: hostOf(url), title: null, description: null, image: null, icon: null };

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
      return NextResponse.json(fallback);
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
    const meta = parseHtmlMetadata(html);

    const resolve = (value: string | null): string | null => {
      if (!value) return null;
      try {
        return new URL(value, response.url).toString();
      } catch {
        return null;
      }
    };

    return NextResponse.json({
      url,
      host: hostOf(url),
      title: meta.title,
      description: meta.description,
      image: safeImageUrl(resolve(meta.image)),
      icon: safeImageUrl(resolve(meta.icon)),
    });
  } catch {
    return NextResponse.json(fallback);
  }
}

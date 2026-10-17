import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { contentTypeFor, isValidAssetKey, storageDriver } from "@/lib/storage";
import { buildTransformQuery, parseTransformQuery } from "@/lib/image-transform";
import { contentDisposition } from "@/lib/page-export";

export const runtime = "nodejs";

/**
 * Whether the delivered content type is an SVG document. The type comes from
 * the storage driver — the stored name for the local driver, the bucket's own
 * header for the S3 one — so the parameters are cut off before the
 * comparison: `image/svg+xml; charset=utf-8` is the same type.
 */
function isSvgContentType(contentType: string): boolean {
  return contentType.split(";", 1)[0].trim().toLowerCase() === "image/svg+xml";
}

/**
 * Serve an uploaded asset from the storage driver (local disk or S3-compatible).
 * The file is streamed only to members of the owning workspace, and the path
 * segments are validated to prevent traversal.
 *
 * The surface is reserved for full members: a `GUEST` is refused with a 403
 * before the storage driver is asked, so a refused request yields no bytes,
 * no asset content-type and no etag, and it is the same answer for a missing
 * asset.
 * An asset cannot be scoped to a page — it is served by its random name and
 * `Asset.pageId` is never populated — so there is no guest scope to apply
 * here; the role gate is the only gate this route can apply. The cost is
 * deliberate: a guest sees the text of a shared page but none of its media
 * (image blocks, cover, icon, attachments) until an asset can be linked to a
 * page.
 *
 * An SVG is an active document: the upload endpoint accepts `image/svg+xml`,
 * and a document that is served inline runs in the app's own origin. It is
 * therefore delivered as a download (`Content-Disposition: attachment`) — the
 * raster images stay inline, they are what the editor renders in an `<img>`.
 *
 * Image transforms: derived-rendition query params (`w`,`h`,`fit`,`format`,`q`)
 * are parsed and clamped by `parseTransformQuery`, so invalid values are dropped
 * and equivalent URLs collapse to one identity. That normalised query is folded
 * into the `ETag` so browser/CDN caches never conflate two renditions, and
 * `Vary: Accept` keeps a `format=auto` encoding negotiable. This build declares
 * no server-side encoder, so the bytes pass through unchanged.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  if (!segments || segments.length !== 2) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [workspaceId, name] = segments;
  if (
    !/^[A-Za-z0-9_-]+$/.test(workspaceId) ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name.includes("..")
  ) {
    return NextResponse.json({ error: "Bad path" }, { status: 400 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // An asset cannot be scoped to a page: the route serves it by its random
  // name, and `Asset.pageId` is never populated, so "the assets of the pages
  // shared with this guest" cannot be answered here. Until that link exists
  // the surface is reserved for full members — an asset is a full-text copy
  // of workspace content. The gate sits above the storage lookup, so the
  // refusal leaks neither the bytes nor the asset's existence.
  if (!canEditContent(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const key = `${workspaceId}/${name}`;
  if (!isValidAssetKey(key)) {
    return NextResponse.json({ error: "Bad path" }, { status: 400 });
  }

  try {
    const stored = await storageDriver().get(key);
    if (!stored) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Normalise the requested rendition (`w`,`h`,`fit`,`format`,`q`) and
    // canonicalise it so a cache key reflects the validated knobs, not the raw
    // query. Empty when the URL asked for no transform.
    const transform = parseTransformQuery(request.url);
    const rendition = buildTransformQuery(transform, { baseUrl: "", path: "" });

    const body = new Uint8Array(stored.body);
    const etag = `"${createHash("sha256").update(body).update(rendition).digest("hex").slice(0, 32)}"`;
    const contentType = stored.contentType || contentTypeFor(name);

    return new NextResponse(body, {
      headers: {
        "content-type": contentType,
        // B112: an SVG is delivered as a download, never as a document of the
        // app's origin (see the route comment).
        ...(isSvgContentType(contentType)
          ? { "content-disposition": contentDisposition(name) }
          : {}),
        "cache-control": "private, max-age=3600",
        vary: "Accept",
        etag,
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

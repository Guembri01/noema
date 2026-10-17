import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { contentTypeFor, isValidAssetKey, storageDriver } from "@/lib/storage";
import { buildTransformQuery, parseTransformQuery } from "@/lib/image-transform";

export const runtime = "nodejs";

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

    return new NextResponse(body, {
      headers: {
        "content-type": stored.contentType || contentTypeFor(name),
        "cache-control": "private, max-age=3600",
        vary: "Accept",
        etag,
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

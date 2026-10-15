import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { searchPagesPage } from "@/server/queries";
import { rateLimit } from "@/lib/api-guard";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import { refineByRelevance } from "@/lib/search-ranking";

export const runtime = "nodejs";

/**
 * GET /api/v1/search?workspaceId=…&q=…&page_size=…&start_cursor=… — search page
 * titles and bodies. Keyset pagination over the engine's rank with an `id`
 * tie-break. `page_size` defaults to 50, clamped to 1..100; bad values are 400
 * `invalid_page_size`, unreadable cursors 400 `invalid_cursor`. Additive
 * `rank=bm25` re-ranks only the hits loaded for the current page (title-
 * weighted); the default response order and `next_cursor` are unchanged.
 */
export async function GET(request: Request) {
  const limited = rateLimit(request, "v1");
  if (limited) return limited;
  const auth = await authenticateApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const query = url.searchParams.get("q") ?? "";
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }
  const access = await getWorkspaceAccess(auth.userId, workspaceId);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pageSize = url.searchParams.get("page_size");
  if (pageSize !== null && pageSize.trim() !== "" && !Number.isFinite(Number(pageSize))) {
    return NextResponse.json({ error: "invalid_page_size" }, { status: 400 });
  }
  const limit = clampLimit(pageSize, { min: 1, max: 100, fallback: 50 });
  const cursor = url.searchParams.get("start_cursor");
  if (cursor !== null && cursor !== "" && decodeCursor(cursor) === null) {
    return NextResponse.json(malformedCursorResult(), { status: 400 });
  }

  const page = await searchPagesPage(workspaceId, query, null, { limit, cursor });
  const items =
    url.searchParams.get("rank") === "bm25"
      ? refineByRelevance(page.items, query, { titleWeight: 3, getBody: (r) => r.snippet })
      : page.items;
  return NextResponse.json({
    results: items.map((result) => ({
      id: result.id,
      title: result.title || "Untitled",
      icon: result.icon,
      type: result.type,
      snippet: result.snippet,
      updatedAt: result.updatedAt,
    })),
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
  });
}

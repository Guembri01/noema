import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { hasScope } from "@/lib/api-token-scope";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { searchPagesPage } from "@/server/queries";
import { rateLimit } from "@/lib/api-guard";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import { refineByRelevance } from "@/lib/search-ranking";

export const runtime = "nodejs";

/** The engine's `PageType`, keyed by the lower-case `type` query values. */
const SEARCH_TYPE_BY_PARAM: Readonly<Record<string, "PAGE" | "DATABASE">> = {
  page: "PAGE",
  database: "DATABASE",
};

/**
 * Resolve the optional `type` query parameter to a `PageType`, or `null` to
 * search every type. Matching is case-insensitive; an absent, blank or
 * unrecognised value means "all", so the parameter is purely additive.
 */
function parseSearchType(raw: string | null): "PAGE" | "DATABASE" | null {
  if (raw === null) return null;
  return SEARCH_TYPE_BY_PARAM[raw.trim().toLowerCase()] ?? null;
}

/**
 * GET /api/v1/search?workspaceId=…&q=…&page_size=…&start_cursor=…&type=… —
 * search page titles and bodies. Keyset pagination over the engine's rank with an `id`
 * tie-break. `page_size` defaults to 50, clamped to 1..100; bad values are 400
 * `invalid_page_size`, unreadable cursors 400 `invalid_cursor`. Additive
 * `rank=bm25` re-ranks only the hits loaded for the current page (title-
 * weighted); the default response order and `next_cursor` are unchanged.
 * Additive `type=page|database` narrows the returned hits to a single
 * `PageType`; omitting it (or an unknown value) searches every type. The
 * engine keyset still drives the walk, so `has_more` / `next_cursor` are
 * unchanged and a scoped walk neither skips nor repeats a hit.
 *
 * A `GUEST` hits only the pages shared with them (the same scope the
 * workspace UI applies); a full member keeps the whole workspace. The bearer
 * token must also hold the `read:pages` scope; a token without it is refused
 * with 403 `insufficient_scope` before the workspace is even looked up. The
 * scope covers ranked search and the empty-`q` "recent pages" branch (#111).
 */
export async function GET(request: Request) {
  const pre = rateLimit(request, "v1-pre", 120, 60_000);
  if (pre) return pre;
  const auth = await authenticateApiRequest(request);
  const limited = rateLimit(request, "v1", 120, 60_000, { userId: auth?.userId });
  if (limited) return limited;
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasScope(auth.scopes, "read:pages")) {
    return NextResponse.json(
      { error: "insufficient_scope", required: "read:pages" },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const query = url.searchParams.get("q") ?? "";
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }
  const access = await getWorkspaceAccess(auth.userId, workspaceId);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Guests only hit the pages shared with them — the same scope the
  // workspace UI applies, so search can never surface a page they may not
  // open. (The empty-`q` branch is still unscoped — #105.)
  const visiblePageIds = await pageScopeFor(auth.userId, workspaceId, access.role);

  const pageSize = url.searchParams.get("page_size");
  if (pageSize !== null && pageSize.trim() !== "" && !Number.isFinite(Number(pageSize))) {
    return NextResponse.json({ error: "invalid_page_size" }, { status: 400 });
  }
  const limit = clampLimit(pageSize, { min: 1, max: 100, fallback: 50 });
  const cursor = url.searchParams.get("start_cursor");
  if (cursor !== null && cursor !== "" && decodeCursor(cursor) === null) {
    return NextResponse.json(malformedCursorResult(), { status: 400 });
  }

  const type = parseSearchType(url.searchParams.get("type"));

  const page = await searchPagesPage(workspaceId, query, visiblePageIds, { limit, cursor });
  const scoped = type === null ? page.items : page.items.filter((result) => result.type === type);
  const items =
    url.searchParams.get("rank") === "bm25"
      ? refineByRelevance(scoped, query, { titleWeight: 3, getBody: (r) => r.snippet })
      : scoped;
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

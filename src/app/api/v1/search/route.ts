import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { searchPagesPage } from "@/server/queries";
import { rateLimit } from "@/lib/api-guard";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import { buildIndex, rank } from "@/lib/search-ranking";

export const runtime = "nodejs";

/**
 * How strongly a title hit outranks an equally frequent body hit in the
 * opt-in `rank=bm25` refinement. Above `1` so a page-name match surfaces first.
 */
const BM25_TITLE_WEIGHT = 3;

/**
 * Re-rank one loaded page of hits with the shared BM25 scorer
 * (`search-ranking.ts`), weighting title matches. Additive and lossless: rows
 * the scorer does not recognise (prefix and substring-fallback hits, whose
 * terms fold differently) keep their engine order and follow the scored rows,
 * so the result count and the `(rank, id)` keyset window are unchanged. A
 * stable sort leaves the engine's order intact for any remaining ties.
 */
function reRankByBm25<
  T extends { id: string; title: string; snippet: string; updatedAt: Date },
>(rows: readonly T[], query: string): T[] {
  if (rows.length <= 1) return [...rows];
  const index = buildIndex(
    rows.map((row) => ({
      id: row.id,
      fields: { title: row.title, body: row.snippet },
      updatedAt: row.updatedAt.getTime(),
    })),
  );
  const ranked = rank(index, query, {
    titleWeight: BM25_TITLE_WEIGHT,
    limit: rows.length,
  });
  if (ranked.length === 0) return [...rows];
  const position = new Map(ranked.map((result, index) => [result.id, index]));
  return [...rows].sort((a, b) => {
    const left = position.get(a.id);
    const right = position.get(b.id);
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
}

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
    url.searchParams.get("rank") === "bm25" ? reRankByBm25(page.items, query) : page.items;
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

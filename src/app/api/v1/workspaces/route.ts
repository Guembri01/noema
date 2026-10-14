import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { rateLimit } from "@/lib/api-guard";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import { getWorkspacesPage } from "@/server/queries";

export const runtime = "nodejs";

/**
 * GET /api/v1/workspaces?page_size=…&start_cursor=… — list the caller's
 * workspaces (owner or member) in the stable total order `(createdAt, id)`.
 * `page_size` defaults to 50, clamped to 1..100; bad values are 400
 * `invalid_page_size`, unreadable cursors 400 `invalid_cursor`.
 */
export async function GET(request: Request) {
  const limited = rateLimit(request, "v1");
  if (limited) return limited;
  const auth = await authenticateApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const pageSize = url.searchParams.get("page_size");
  if (pageSize !== null && pageSize.trim() !== "" && !Number.isFinite(Number(pageSize))) {
    return NextResponse.json({ error: "invalid_page_size" }, { status: 400 });
  }
  const limit = clampLimit(pageSize, { min: 1, max: 100, fallback: 50 });
  const cursor = url.searchParams.get("start_cursor");
  if (cursor !== null && cursor !== "" && decodeCursor(cursor) === null) {
    return NextResponse.json(malformedCursorResult(), { status: 400 });
  }

  const page = await getWorkspacesPage(auth.userId, { limit, cursor });
  return NextResponse.json({
    workspaces: page.items,
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
  });
}

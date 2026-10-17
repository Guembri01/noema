import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { hasScope } from "@/lib/api-token-scope";
import { rateLimit } from "@/lib/api-guard";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import { getWorkspacesPage } from "@/server/queries";

export const runtime = "nodejs";

/**
 * RFC 5988 `Link` header value pointing at the next page, or `null` when the
 * caller has reached the end (`next_cursor == null`). The request URL is reused
 * so `page_size` and any other query parameters carry over; only `start_cursor`
 * is replaced with the opaque next token. Purely additive: it does not alter
 * the JSON body or the pagination envelope.
 */
function nextLinkHeader(requestUrl: string, nextCursor: string | null): string | null {
  if (!nextCursor) return null;
  const next = new URL(requestUrl);
  next.searchParams.set("start_cursor", nextCursor);
  return `<${next.toString()}>; rel="next"`;
}

/**
 * GET /api/v1/workspaces?page_size=…&start_cursor=… — list the caller's
 * workspaces (owner or member) in the stable total order `(createdAt, id)`.
 * `page_size` defaults to 50, clamped to 1..100; bad values are 400
 * `invalid_page_size`, unreadable cursors 400 `invalid_cursor`. When another
 * page exists, the response carries a `Link: <…>; rel="next"` header derived
 * from `next_cursor`; the body is unchanged.
 *
 * The bearer token must hold the `read:pages` scope; a token without it is
 * refused with 403 `insufficient_scope`.
 *
 * Why `read:pages` and not `read:members`: the body is the caller's own
 * workspace *directory* — id, name, slug, icon — and carries neither member
 * data nor page content. The endpoint is the bootstrap step for the page
 * routes, which all need a `workspaceId` the client can only learn here, so
 * the read scope of that resource is the one that fits. `read:members` stays
 * reserved for member listings, which `/api/v1` does not expose.
 */
export async function GET(request: Request) {
  const limited = rateLimit(request, "v1");
  if (limited) return limited;
  const auth = await authenticateApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasScope(auth.scopes, "read:pages")) {
    return NextResponse.json(
      { error: "insufficient_scope", required: "read:pages" },
      { status: 403 },
    );
  }

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
  const response = NextResponse.json({
    workspaces: page.items,
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
  });
  const link = nextLinkHeader(request.url, page.nextCursor);
  if (link) response.headers.set("Link", link);
  return response;
}

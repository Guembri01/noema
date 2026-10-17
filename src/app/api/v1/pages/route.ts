import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { hasScope } from "@/lib/api-token-scope";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { dispatchWebhooks } from "@/lib/webhooks";
import { rateLimit } from "@/lib/api-guard";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import { buildBreadcrumb } from "@/lib/breadcrumb";
import { withIdempotency } from "@/lib/idempotency";
import { getPagesPage, getPageTree, type ApiPageRow } from "@/server/queries";

export const runtime = "nodejs";

/** One crumb of a `breadcrumbs` trail: the ancestor id plus its display title. */
type BreadcrumbTrailItem = { id: string; title: string };

/** An `ApiPageRow` enriched with its root → page chain (`include=breadcrumbs`). */
type ApiPageWithBreadcrumbs = ApiPageRow & { breadcrumbs: BreadcrumbTrailItem[] };

/**
 * Build the RFC-5988 `Link` header for the list response. Only `rel="next"` is
 * emitted, derived from `next_cursor` by cloning the request URL and swapping
 * its `start_cursor`; every other query parameter (notably `workspaceId` and
 * `page_size`) is preserved. Returns `null` on the last page so callers can
 * omit the header entirely. Purely additive: the JSON body is untouched.
 */
function nextPageLink(requestUrl: URL, nextCursor: string | null): string | null {
  if (!nextCursor) return null;
  const next = new URL(requestUrl.toString());
  next.searchParams.set("start_cursor", nextCursor);
  return `<${next.toString()}>; rel="next"`;
}

/**
 * GET /api/v1/pages?workspaceId=…&page_size=…&start_cursor=… — list pages.
 *
 * Keyset pagination over the stable total order `(position, createdAt, id)`.
 * `page_size` defaults to 50 and is clamped to 1..100; a non-numeric value is
 * a 400 `invalid_page_size`. An unreadable `start_cursor` is a 400
 * `invalid_cursor`; omitting both returns the first page (`has_more` /
 * `next_cursor` always accompany the `pages` key). When there is a next page a
 * `Link: <…>; rel="next"` response header mirrors `next_cursor` (R24.2).
 *
 * Additive `include=breadcrumbs`: when the query parameter equals exactly
 * `breadcrumbs`, each returned page also carries a `breadcrumbs` array — its
 * root → page ancestor chain as `{ id, title }` crumbs, resolved with
 * {@link buildBreadcrumb} over the workspace's live pages (`getPageTree`).
 * The option is omitted by default, so the plain body and the `Link` header /
 * pagination behaviour are unchanged.
 *
 * The bearer token must hold the `read:pages` scope; a token without it is
 * refused with 403 `insufficient_scope` before the workspace is even looked
 * up.
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
  const workspaceId = url.searchParams.get("workspaceId");
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

  const withBreadcrumbs = url.searchParams.get("include") === "breadcrumbs";

  const page = await getPagesPage(workspaceId, { limit, cursor });
  let items: (ApiPageRow | ApiPageWithBreadcrumbs)[] = page.items;
  if (withBreadcrumbs) {
    // Ancestors can fall outside the current keyset slice, so resolve trails
    // against the whole (live) workspace tree, matching `buildBreadcrumb`'s
    // fail-closed contract when an ancestor is missing/deleted.
    const tree = await getPageTree(workspaceId);
    items = page.items.map((item) => ({
      ...item,
      breadcrumbs: buildBreadcrumb(tree, item.id).map((crumb) => ({
        id: crumb.id,
        title: crumb.label,
      })),
    }));
  }

  const headers = new Headers();
  const link = nextPageLink(url, page.nextCursor);
  if (link) headers.set("Link", link);
  return NextResponse.json(
    {
      pages: items,
      has_more: page.hasMore,
      next_cursor: page.nextCursor,
    },
    { headers },
  );
}

/**
 * POST /api/v1/pages — create a page. Body: { workspaceId, title?, parentId?, type? }
 *
 * Creating a page is the classic duplicate-on-retry case: a client that times out
 * and resends would otherwise get two pages. An `Idempotency-Key` header makes the
 * retry replay the first outcome instead of creating again (spec §20). Callers
 * that send no key are unaffected — the handler simply runs.
 *
 * The bearer token must hold the `write:pages` scope; a token without it is
 * refused with 403 `insufficient_scope` before the request is admitted to the
 * idempotency store, so a rejected call is never memoized.
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "v1");
  if (limited) return limited;
  const auth = await authenticateApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasScope(auth.scopes, "write:pages")) {
    return NextResponse.json(
      { error: "insufficient_scope", required: "write:pages" },
      { status: 403 },
    );
  }

  return withIdempotency(request, { userId: auth.userId }, async () => {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (!workspaceId) {
      return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
    }
    const access = await getWorkspaceAccess(auth.userId, workspaceId);
    if (!access || !canEditContent(access.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parentId = typeof body.parentId === "string" ? body.parentId : null;
    const type = body.type === "DATABASE" ? "DATABASE" : "PAGE";
    const title = typeof body.title === "string" ? body.title.slice(0, 500) : "Untitled";

    const last = await prisma.page.findFirst({
      where: { workspaceId, parentId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const page = await prisma.page.create({
      data: {
        workspaceId,
        parentId,
        type,
        title,
        createdById: auth.userId,
        position: (last?.position ?? 0) + 1000,
        content: { type: "doc", content: [{ type: "paragraph" }] },
      },
      select: { id: true, title: true, type: true },
    });

    await dispatchWebhooks(workspaceId, "page.created", { pageId: page.id, via: "api" });
    return NextResponse.json({ page }, { status: 201 });
  });
}

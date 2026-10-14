import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { dispatchWebhooks } from "@/lib/webhooks";
import { rateLimit } from "@/lib/api-guard";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import { getPagesPage } from "@/server/queries";

export const runtime = "nodejs";

/**
 * GET /api/v1/pages?workspaceId=…&page_size=…&start_cursor=… — list pages.
 *
 * Keyset pagination over the stable total order `(position, createdAt, id)`.
 * `page_size` defaults to 50 and is clamped to 1..100; a non-numeric value is
 * a 400 `invalid_page_size`. An unreadable `start_cursor` is a 400
 * `invalid_cursor`; omitting both returns the first page (`has_more` /
 * `next_cursor` always accompany the `pages` key).
 */
export async function GET(request: Request) {
  const limited = rateLimit(request, "v1");
  if (limited) return limited;
  const auth = await authenticateApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const page = await getPagesPage(workspaceId, { limit, cursor });
  return NextResponse.json({
    pages: page.items,
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
  });
}

/** POST /api/v1/pages — create a page. Body: { workspaceId, title?, parentId?, type? } */
export async function POST(request: Request) {
  const limited = rateLimit(request, "v1");
  if (limited) return limited;
  const auth = await authenticateApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
}

import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { hasScope } from "@/lib/api-token-scope";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

/**
 * GET /api/v1/pages/:pageId — read one page including its document.
 *
 * A `GUEST` may only read the pages shared with them (the same scope the
 * workspace UI applies); a page outside the scope is a 404, never a leak.
 *
 * The bearer token must hold the `read:pages` scope; a token without it is
 * refused with 403 `insufficient_scope`. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
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

  const { pageId } = await params;
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      id: true,
      workspaceId: true,
      parentId: true,
      title: true,
      icon: true,
      type: true,
      content: true,
      updatedAt: true,
      deletedAt: true,
    },
  });
  if (!page || page.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const access = await getWorkspaceAccess(auth.userId, page.workspaceId);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Guests may only open the pages shared with them: anything outside the
  // scope is a 404 (not a 403), so the response never confirms that the page
  // exists.
  const visiblePageIds = await pageScopeFor(auth.userId, page.workspaceId, access.role);
  if (visiblePageIds && !visiblePageIds.has(pageId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { workspaceId, deletedAt, ...rest } = page;
  void workspaceId;
  void deletedAt;
  return NextResponse.json({ page: rest });
}

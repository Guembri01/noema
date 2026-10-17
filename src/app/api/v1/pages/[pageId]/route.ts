import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

/** GET /api/v1/pages/:pageId — read one page including its document. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const auth = await authenticateApiRequest(request);
  const limited = rateLimit(request, "v1", 120, 60_000, { userId: auth?.userId });
  if (limited) return limited;
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const { workspaceId, deletedAt, ...rest } = page;
  void workspaceId;
  void deletedAt;
  return NextResponse.json({ page: rest });
}

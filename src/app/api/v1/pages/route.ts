import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { dispatchWebhooks } from "@/lib/webhooks";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

/** GET /api/v1/pages?workspaceId=… — list pages in a workspace. */
export async function GET(request: Request) {
  const limited = rateLimit(request, "v1");
  if (limited) return limited;
  const auth = await authenticateApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }
  const access = await getWorkspaceAccess(auth.userId, workspaceId);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pages = await prisma.page.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, parentId: true, title: true, icon: true, type: true, updatedAt: true },
  });
  return NextResponse.json({ pages });
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

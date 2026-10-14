import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

/** GET /api/v1/workspaces — list the caller's workspaces. */
export async function GET(request: Request) {
  const limited = rateLimit(request, "v1");
  if (limited) return limited;
  const auth = await authenticateApiRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await prisma.workspace.findMany({
    where: {
      OR: [{ ownerId: auth.userId }, { members: { some: { userId: auth.userId } } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true, icon: true },
  });
  return NextResponse.json({ workspaces });
}

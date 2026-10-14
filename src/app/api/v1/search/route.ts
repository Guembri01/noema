import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api-auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { searchPages } from "@/server/queries";
import { rateLimit } from "@/lib/api-guard";

export const runtime = "nodejs";

/** GET /api/v1/search?workspaceId=…&q=… — search page titles and bodies. */
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

  const results = await searchPages(workspaceId, query);
  return NextResponse.json({
    results: results.map((page) => ({
      id: page.id,
      title: page.title || "Untitled",
      icon: page.icon,
      type: page.type,
      snippet: page.snippet,
      updatedAt: page.updatedAt,
    })),
  });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { importNotionPageAction } from "@/server/actions/notion-import";

export const runtime = "nodejs";

/** Import a Notion page tree using an integration token. */
export async function POST(request: Request) {
  const limited = rateLimit(request, "notion-import", 30, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    workspaceId?: string;
    parentId?: string | null;
    token?: string;
    pageId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const result = await importNotionPageAction({
    workspaceId: String(body.workspaceId ?? ""),
    parentId: body.parentId ?? null,
    token: String(body.token ?? ""),
    pageId: String(body.pageId ?? ""),
  });
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

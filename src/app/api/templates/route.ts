import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import {
  createBlockTemplateAction,
  createGalleryTemplateAction,
  createQuickStartAction,
} from "@/server/actions/home-templates";
import type { TemplateId } from "@/lib/templates";

export const runtime = "nodejs";

/**
 * Create a page or database from a template. Body:
 *   { action: "quickstart", workspaceId, kind: "page" | "database", parentId? }
 *   { action: "gallery",    workspaceId, templateId,               parentId? }
 *   { action: "block",      workspaceId, templateId,               parentId? }
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "templates", 30, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    action?: string;
    workspaceId?: string;
    kind?: string;
    templateId?: string;
    parentId?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const workspaceId = String(body.workspaceId ?? "");
  const parentId = body.parentId ?? null;

  let result: { ok: true; id: string; slug: string } | { error: string };
  switch (body.action) {
    case "quickstart":
      result = await createQuickStartAction({
        workspaceId,
        kind: body.kind === "database" ? "database" : "page",
        parentId,
      });
      break;
    case "gallery":
      result = await createGalleryTemplateAction({
        workspaceId,
        templateId: String(body.templateId ?? ""),
        parentId,
      });
      break;
    case "block":
      result = await createBlockTemplateAction({
        workspaceId,
        templateId: String(body.templateId ?? "") as TemplateId,
        parentId,
      });
      break;
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

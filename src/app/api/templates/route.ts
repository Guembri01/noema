import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { assertScopedParent } from "@/lib/page-parent";
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
  const limited = rateLimit(request, "templates", 30, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
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

  // The parent must live in the caller's workspace — `Page.parentId` is a
  // plain foreign key, so a foreign parent would link the new page into
  // another tenant's tree (B08). The template actions repeat the check, so a
  // direct action call is covered as well.
  const parent = await assertScopedParent({ workspaceId, parentId });
  if ("error" in parent) {
    return NextResponse.json({ error: parent.error }, { status: 400 });
  }

  let result: { ok: true; id: string; slug: string } | { error: string };
  switch (body.action) {
    case "quickstart":
      result = await createQuickStartAction({
        workspaceId,
        kind: body.kind === "database" ? "database" : "page",
        parentId: parent.parentId,
      });
      break;
    case "gallery":
      result = await createGalleryTemplateAction({
        workspaceId,
        templateId: String(body.templateId ?? ""),
        parentId: parent.parentId,
      });
      break;
    case "block":
      result = await createBlockTemplateAction({
        workspaceId,
        templateId: String(body.templateId ?? "") as TemplateId,
        parentId: parent.parentId,
      });
      break;
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

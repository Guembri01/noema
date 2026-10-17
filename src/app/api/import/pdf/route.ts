import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { importPdfTextAction } from "@/server/actions/import-pdf";

export const runtime = "nodejs";

/**
 * Import a PDF's extracted text layer through the `pdf-import` engine.
 *
 * Companion to `POST /api/import/notion` (`format=pdf`, which extracts a binary
 * PDF's text layer and stores it as Markdown). This route is the engine path:
 * it accepts text an extractor already produced and runs the structure-recovery
 * pipeline (`src/lib/pdf-import.ts`) before creating the page.
 *
 * Body: `{ workspaceId, parentId?, filename?, text }`.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "pdf-import", 30, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    workspaceId?: string;
    parentId?: string | null;
    filename?: string | null;
    text?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const result = await importPdfTextAction({
    workspaceId: String(body.workspaceId ?? ""),
    parentId: body.parentId ?? null,
    filename: body.filename ?? null,
    text: String(body.text ?? ""),
  });
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

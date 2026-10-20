import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { bodyReadError, readJsonBody } from "@/lib/body-limit";
import { importPdfTextAction } from "@/server/actions/import-pdf";

export const runtime = "nodejs";

/**
 * B22 — the budget for one import request. The body carries the extracted
 * text layer, which the importer caps at 5 000 000 characters; the route
 * budget sits above that so the action still reports its own, more precise
 * error, and far below "whatever the client sends".
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

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
  const limited = rateLimit(request, "pdf-import", 30, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    workspaceId?: string;
    parentId?: string | null;
    filename?: string | null;
    text?: string;
  };
  try {
    body = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Invalid JSON body.");
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

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { bodyReadError, readJsonBody } from "@/lib/body-limit";
import { importNotionPageAction } from "@/server/actions/notion-import";
import { importHtmlAction, importPdfAction } from "@/server/actions/import-formats";

export const runtime = "nodejs";

/** Importers this route dispatches to; `notion` stays the default. */
const IMPORT_FORMATS = ["notion", "html", "pdf"] as const;
type ImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * B22 — the budget for one import request.
 *
 * The route has to be able to carry a 10 MB PDF as base64 (13 981 016
 * characters) and a 5 MB HTML document, so the body is bounded well above
 * both. The point is that it is a *bound*: without it the route buffers
 * whatever the client sends before the action ever gets to look at it.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function isImportFormat(value: unknown): value is ImportFormat {
  return typeof value === "string" && (IMPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * Import a document. `format` selects the importer:
 *   - `notion` (default) — a Notion page tree from an integration token.
 *   - `html` — a Google Docs / Confluence / plain HTML document.
 *   - `pdf` — the text layer of a base64-encoded PDF file.
 * Unknown formats are rejected with the allowlist rather than silently falling
 * back to the Notion path.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "notion-import", 30, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    workspaceId?: string;
    parentId?: string | null;
    format?: string;
    token?: string;
    pageId?: string;
    html?: string;
    data?: string;
    filename?: string;
    spaceKey?: string;
  };
  try {
    body = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Invalid JSON body.");
  }

  const format = body.format ?? "notion";
  if (!isImportFormat(format)) {
    return NextResponse.json(
      { error: `Unknown import format: ${format}.`, valid: IMPORT_FORMATS },
      { status: 400 },
    );
  }

  const base = {
    workspaceId: String(body.workspaceId ?? ""),
    parentId: body.parentId ?? null,
  };

  if (format === "html") {
    const result = await importHtmlAction({
      ...base,
      html: String(body.html ?? ""),
      filename: body.filename ?? null,
      spaceKey: body.spaceKey ?? null,
    });
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json(result);
  }

  if (format === "pdf") {
    const result = await importPdfAction({
      ...base,
      data: String(body.data ?? ""),
      filename: body.filename ?? null,
    });
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json(result);
  }

  const result = await importNotionPageAction({
    ...base,
    token: String(body.token ?? ""),
    pageId: String(body.pageId ?? ""),
  });
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

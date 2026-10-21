import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { prisma } from "@/lib/db";
import { PAGE_EXPORT_FORMATS, parseExportFormat } from "@/lib/export-format";
import { documentToHtml } from "@/lib/html-export";
import { docToPdf } from "@/lib/pdf";
import {
  buildMarkdownExport,
  buildPrintExport,
  contentDisposition,
  docBlocks,
  exportEngineHeaders,
  representationFor,
} from "@/lib/page-export";

export const runtime = "nodejs";

/**
 * Export a page. `?format=` selects the engine (docs/MISSING_FEATURES §12):
 *
 *   • `md` (default) — the round-trip-secure `docToMarkdownFidelity`
 *     serializer, with `frontMatter`/`imageBase`; the `fidelityReport` losses
 *     ride along in `x-export-fidelity*` headers.
 *   • `json` — the raw stored document.
 *   • `html` — `documentToHtml`, or the print-plan HTML with `?print=1`.
 *   • `pdf` — the `buildPrintPlan` + `printStyles` print-plan engine; the
 *     response is the planned PDF (or the print-ready HTML with `?print=1`).
 *
 * Unknown formats → 400 (R23.16); 30 exports/min (R23.22). The plan's page and
 * block counts and the engines' fidelity findings are exposed as `x-export-*`
 * headers, so the work a `?format=` request performed is inspectable.
 *
 * An export is a full-text copy, so it is reserved for full members: a `GUEST`
 * gets a 403. A page outside the caller's scope is a 404, never a leak.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "export-page", 30, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { pageId } = await params;
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, workspaceId: true, title: true, content: true },
  });
  if (!page) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Guests may not export (R23.21) — an export is a full-text copy.
  if (!canEditContent(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Belt and braces: a page outside the caller's scope is a 404.
  const visiblePageIds = await pageScopeFor(user.id, page.workspaceId, access.role);
  if (visiblePageIds && !visiblePageIds.has(pageId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const parsedFormat = parseExportFormat(
    url.searchParams.get("format"),
    PAGE_EXPORT_FORMATS,
    "md",
  );
  if (!parsedFormat.ok) {
    return NextResponse.json(
      { error: parsedFormat.error, valid: parsedFormat.valid },
      { status: 400 },
    );
  }
  const format = parsedFormat.format;
  const representation = representationFor(url.searchParams);
  const safeName =
    (page.title || "untitled").replace(/[^\w.-]+/g, "-").slice(0, 60) || "untitled";

  if (format === "json") {
    const body = JSON.stringify(
      { title: page.title, content: page.content ?? { type: "doc", content: [] } },
      null,
      2,
    );
    return new NextResponse(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName}.json"`,
      },
    });
  }

  // The print-plan engine backs both `?format=pdf` and `?format=html&print=1`.
  if (format === "pdf" || (format === "html" && representation === "print-html")) {
    const print = buildPrintExport(page.title, page.content, {
      includePageNumbers: url.searchParams.get("pageNumbers") !== "0",
      includeToc: url.searchParams.get("toc") === "1",
    });
    const filename = representation === "print-html" ? print.htmlFilename : print.filename;
    const headers = exportEngineHeaders({
      engine: print.engine,
      filename,
      plan: print.plan,
      planFidelity: print.fidelity,
    });

    if (representation === "print-html") {
      return new NextResponse(print.html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": contentDisposition(print.htmlFilename),
          ...headers,
        },
      });
    }

    const pdf = await docToPdf(page.title, page.content);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": contentDisposition(print.filename),
        ...headers,
      },
    });
  }

  if (format === "html") {
    return new NextResponse(documentToHtml(docBlocks(page.content), { title: page.title }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName}.html"`,
      },
    });
  }

  // Markdown (default) — the fidelity serializer plus its loss report.
  const markdown = buildMarkdownExport(page.title, page.content, {
    frontMatter: { title: page.title, exportedAt: new Date().toISOString() },
    imageBase: url.searchParams.get("imageBase") ?? url.origin,
  });
  return new NextResponse(markdown.body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${safeName}.md"`,
      ...exportEngineHeaders({ engine: markdown.engine, fidelity: markdown.fidelity }),
    },
  });
}

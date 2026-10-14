import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { PAGE_EXPORT_FORMATS, parseExportFormat } from "@/lib/export-format";
import { pageToHtml, pageToMarkdown } from "@/lib/serialize";
import { docToPdf } from "@/lib/pdf";

export const runtime = "nodejs";

/**
 * Export a page as Markdown (`?format=md`, default), JSON, HTML or PDF.
 * Unknown formats → 400 (R23.16); 30 exports/min (R23.22).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const limited = rateLimit(request, "export-page", 30, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { pageId } = await params;
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, workspaceId: true, title: true, content: true },
  });
  if (!page) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsedFormat = parseExportFormat(
    new URL(request.url).searchParams.get("format"),
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

  if (format === "html") {
    return new NextResponse(pageToHtml(page.title, page.content), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName}.html"`,
      },
    });
  }

  if (format === "pdf") {
    const pdf = await docToPdf(page.title, page.content);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${safeName}.pdf"`,
      },
    });
  }

  return new NextResponse(pageToMarkdown(page.title, page.content), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${safeName}.md"`,
    },
  });
}

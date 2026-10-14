import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { pageToHtml, pageToMarkdown } from "@/lib/serialize";
import { docToPdf } from "@/lib/pdf";

export const runtime = "nodejs";

/** Export a page as Markdown (?format=md, default) or JSON (?format=json). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
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

  const format = new URL(request.url).searchParams.get("format") ?? "md";
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

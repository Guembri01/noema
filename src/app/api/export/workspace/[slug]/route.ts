import { NextResponse } from "next/server";
import JSZip from "jszip";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { getWorkspaceBySlug } from "@/server/queries";
import { WORKSPACE_EXPORT_FORMATS, parseExportFormat } from "@/lib/export-format";
import { matrixToCsv, pageToMarkdown } from "@/lib/serialize";
import { formatCell, type QueryProperty } from "@/lib/database-query";

export const runtime = "nodejs";

const safeName = (value: string) =>
  value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled";

/**
 * Bulk export: every page as Markdown (nested by ancestry) and every database
 * as CSV, packaged into a zip. Unknown `?format` → 400 (R23.16);
 * 5 exports/min (R23.22).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const limited = rateLimit(request, "export-workspace", 5, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsedFormat = parseExportFormat(
    new URL(request.url).searchParams.get("format"),
    WORKSPACE_EXPORT_FORMATS,
    "zip",
  );
  if (!parsedFormat.ok) {
    return NextResponse.json(
      { error: parsedFormat.error, valid: parsedFormat.valid },
      { status: 400 },
    );
  }

  const pages = await prisma.page.findMany({
    where: { workspaceId: workspace.id, deletedAt: null },
    orderBy: { position: "asc" },
    select: { id: true, parentId: true, title: true, type: true, content: true },
  });
  const byId = new Map(pages.map((p) => [p.id, p]));

  const pathFor = (id: string): string => {
    const segments: string[] = [];
    let cursor: string | null = id;
    let guard = 0;
    while (cursor && guard < 50) {
      const page = byId.get(cursor);
      if (!page) break;
      segments.unshift(safeName(page.title || "Untitled"));
      cursor = page.parentId;
      guard += 1;
    }
    return segments.join("/");
  };

  const zip = new JSZip();
  const used = new Set<string>();
  const unique = (path: string) => {
    let candidate = path;
    let n = 1;
    while (used.has(candidate)) candidate = `${path.replace(/(\.[^.]+)$/, "")} (${n++})$1`;
    used.add(candidate);
    return candidate;
  };

  for (const page of pages) {
    if (page.type === "DATABASE") {
      const [properties, rows] = await Promise.all([
        prisma.property.findMany({
          where: { databasePageId: page.id },
          orderBy: { position: "asc" },
        }),
        prisma.page.findMany({
          where: { parentId: page.id, deletedAt: null },
          orderBy: { position: "asc" },
          include: { propertyValues: true },
        }),
      ]);
      const columns = properties as unknown as QueryProperty[];
      const csv = matrixToCsv(
        properties.map((p) => p.name),
        rows.map((row) =>
          columns.map((property) =>
            property.config?.primary
              ? row.title
              : formatCell(
                  row.propertyValues.find((v) => v.propertyId === property.id)?.value,
                  property,
                ),
          ),
        ),
      );
      zip.file(unique(`${pathFor(page.id)}.csv`), csv);
    } else {
      zip.file(unique(`${pathFor(page.id)}.md`), pageToMarkdown(page.title, page.content));
    }
  }

  zip.file(
    "README.md",
    `# ${workspace.name}\n\nExported from Noema on ${new Date().toISOString()}.\n`,
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${safeName(workspace.name)}.zip"`,
    },
  });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { getWorkspaceBySlug } from "@/server/queries";
import {
  WORKSPACE_EXPORT_FORMATS,
  attachmentZipPath,
  buildWorkspaceZip,
  collectExportPageIds,
  parseExportFormat,
  parseIncludeSubpages,
  rewriteAttachments,
  type WorkspaceZipFile,
} from "@/lib/export-format";
import { collectFileUrls, fileKeyFromUrl } from "@/lib/trash";
import { storageDriver } from "@/lib/storage";
import { matrixToCsv, pageToMarkdown } from "@/lib/serialize";
import { formatCell, type QueryProperty } from "@/lib/database-query";

export const runtime = "nodejs";

const safeName = (value: string) =>
  value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled";

/**
 * Bulk export: every page as Markdown (nested by ancestry) and every database
 * as CSV, packaged into a zip with a `manifest.json` structure manifest and
 * the uploaded attachments of every exported page (MISSING_FEATURES §12).
 * `?includeSubpages=false` exports top-level pages only; unknown `?format`
 * → 400 (R23.16); 5 exports/min (R23.22).
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

  const searchParams = new URL(request.url).searchParams;
  const parsedFormat = parseExportFormat(
    searchParams.get("format"),
    WORKSPACE_EXPORT_FORMATS,
    "zip",
  );
  if (!parsedFormat.ok) {
    return NextResponse.json(
      { error: parsedFormat.error, valid: parsedFormat.valid },
      { status: 400 },
    );
  }
  const includeSubpages = parseIncludeSubpages(searchParams.get("includeSubpages"));

  const pages = await prisma.page.findMany({
    where: { workspaceId: workspace.id, deletedAt: null },
    orderBy: { position: "asc" },
    select: { id: true, parentId: true, title: true, type: true, content: true, coverUrl: true },
  });
  const byId = new Map(pages.map((p) => [p.id, p]));

  // Depth toggle: `?includeSubpages=false` keeps top-level pages only.
  const exportIds = new Set(collectExportPageIds(pages, { includeSubpages }));
  const exported = pages.filter((page) => exportIds.has(page.id));

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

  const files: WorkspaceZipFile[] = [];

  for (const page of exported) {
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
      files.push({ path: `${pathFor(page.id)}.csv`, kind: "database", pageId: page.id, content: csv });
    } else {
      files.push({
        path: `${pathFor(page.id)}.md`,
        kind: "page",
        pageId: page.id,
        // Rewrite /api/files/... references to the bundled copies so the
        // export stands on its own.
        content: rewriteAttachments(pageToMarkdown(page.title, page.content)),
      });
    }
  }

  // Attachments: bundle every upload referenced by an exported page's content
  // or cover, best-effort — a missing blob skips that file, never the export.
  const attachmentUrls = new Set<string>();
  for (const page of exported) {
    for (const url of collectFileUrls({ content: page.content, coverUrl: page.coverUrl })) {
      attachmentUrls.add(url);
    }
  }
  const driver = storageDriver();
  for (const url of attachmentUrls) {
    const key = fileKeyFromUrl(url);
    const zipPath = attachmentZipPath(url);
    if (!key || !zipPath) continue;
    const stored = await driver.get(key).catch(() => null);
    if (!stored) continue;
    files.push({ path: zipPath, kind: "attachment", content: stored.body, mimeType: stored.contentType });
  }

  const buffer = await buildWorkspaceZip({ workspaceName: workspace.name, includeSubpages, files });
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${safeName(workspace.name)}.zip"`,
    },
  });
}

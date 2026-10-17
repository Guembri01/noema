import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { prisma } from "@/lib/db";
import { DATABASE_EXPORT_FORMATS, parseExportFormat } from "@/lib/export-format";
import { matrixToCsv } from "@/lib/serialize";
import { formatCell, type QueryProperty } from "@/lib/database-query";
import { exportDatabaseJson } from "@/lib/json-export";

export const runtime = "nodejs";

/**
 * Export a database page as CSV (`?format=csv`, default) or JSON
 * (`?format=json`, the full `{ schemaVersion, name, properties, rows, views }`
 * snapshot from `json-export.ts`).
 * Unknown `?format` → 400 (R23.16); 30 exports/min (R23.22).
 *
 * An export is a full-text copy, so it is reserved for full members: a `GUEST`
 * gets a 403. A database outside the caller's scope is a 404, never a leak.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const limited = rateLimit(request, "export-database", 30, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { pageId } = await params;
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, workspaceId: true, title: true, type: true },
  });
  if (!page || page.type !== "DATABASE") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Guests may not export (R23.21) — an export is a full-text copy.
  if (!canEditContent(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Belt and braces: a database outside the caller's scope is a 404.
  const visiblePageIds = await pageScopeFor(user.id, page.workspaceId, access.role);
  if (visiblePageIds && !visiblePageIds.has(pageId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsedFormat = parseExportFormat(
    new URL(request.url).searchParams.get("format"),
    DATABASE_EXPORT_FORMATS,
    "csv",
  );
  if (!parsedFormat.ok) {
    return NextResponse.json(
      { error: parsedFormat.error, valid: parsedFormat.valid },
      { status: 400 },
    );
  }

  const [properties, views, rows] = await Promise.all([
    prisma.property.findMany({
      where: { databasePageId: page.id },
      orderBy: { position: "asc" },
    }),
    prisma.databaseView.findMany({
      where: { databasePageId: page.id },
      orderBy: { position: "asc" },
    }),
    prisma.page.findMany({
      where: { parentId: page.id, deletedAt: null },
      orderBy: { position: "asc" },
      include: { propertyValues: true },
    }),
  ]);

  const safeName =
    (page.title || "database").replace(/[^\w.-]+/g, "-").slice(0, 60) || "database";

  if (parsedFormat.format === "json") {
    return new NextResponse(
      exportDatabaseJson({
        name: page.title,
        properties: properties.map((property) => ({
          id: property.id,
          name: property.name,
          type: property.type,
          position: property.position,
          config: property.config ?? null,
        })),
        rows: rows.map((row) => ({
          id: row.id,
          title: row.title,
          position: row.position,
          propertyValues: row.propertyValues.map((value) => ({
            id: value.id,
            propertyId: value.propertyId,
            value: value.value ?? null,
          })),
        })),
        views: views.map((view) => ({
          id: view.id,
          name: view.name,
          type: view.type,
          position: view.position,
          config: view.config ?? null,
        })),
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${safeName}.json"`,
        },
      },
    );
  }

  const columns = properties as unknown as QueryProperty[];
  const header = properties.map((p) => p.name);
  const matrix = rows.map((row) =>
    columns.map((property) => {
      if (property.config?.primary) return row.title;
      const value = row.propertyValues.find((v) => v.propertyId === property.id)?.value;
      return formatCell(value, property);
    }),
  );

  return new NextResponse(matrixToCsv(header, matrix), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${safeName}.csv"`,
    },
  });
}

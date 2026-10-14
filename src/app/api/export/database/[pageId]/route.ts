import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/api-guard";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { DATABASE_EXPORT_FORMATS, parseExportFormat } from "@/lib/export-format";
import { matrixToCsv } from "@/lib/serialize";
import { formatCell, type QueryProperty } from "@/lib/database-query";

export const runtime = "nodejs";

/**
 * Export a database page's rows as CSV (default).
 * Unknown `?format` → 400 (R23.16); 30 exports/min (R23.22).
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
  const header = properties.map((p) => p.name);
  const matrix = rows.map((row) =>
    columns.map((property) => {
      if (property.config?.primary) return row.title;
      const value = row.propertyValues.find((v) => v.propertyId === property.id)?.value;
      return formatCell(value, property);
    }),
  );

  const safeName =
    (page.title || "database").replace(/[^\w.-]+/g, "-").slice(0, 60) || "database";

  return new NextResponse(matrixToCsv(header, matrix), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${safeName}.csv"`,
    },
  });
}

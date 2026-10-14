"use server";

import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { getDatabase } from "@/server/queries";

export type LinkedDatabaseData = {
  databasePageId: string;
  title: string;
  icon: string | null;
  properties: { id: string; name: string; type: string }[];
  views: { id: string; name: string; type: string }[];
  rows: { id: string; title: string; icon: string | null; values: Record<string, unknown> }[];
};

/** Workspace databases available to link. */
export async function listDatabasesAction(
  workspaceId: string,
): Promise<{ id: string; title: string; icon: string | null }[]> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return [];
  return prisma.page.findMany({
    where: { workspaceId, type: "DATABASE", deletedAt: null },
    orderBy: { position: "asc" },
    select: { id: true, title: true, icon: true },
  });
}

/** Read a linked database's schema + rows for an embedded (read-only) view. */
export async function getLinkedDatabaseAction(
  databasePageId: string,
): Promise<LinkedDatabaseData | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: databasePageId },
    select: { workspaceId: true, type: true, title: true, icon: true },
  });
  if (!page || page.type !== "DATABASE") return { error: "Database not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "You do not have access to that database." };

  const database = await getDatabase(databasePageId);
  return {
    databasePageId,
    title: page.title,
    icon: page.icon,
    properties: database.properties.map((property) => ({
      id: property.id,
      name: property.name,
      type: property.type,
    })),
    views: database.views.map((view) => ({
      id: view.id,
      name: view.name,
      type: view.type,
    })),
    rows: database.rows.map((row) => ({
      id: row.id,
      title: row.title,
      icon: row.icon,
      values: Object.fromEntries(row.propertyValues.map((value) => [value.propertyId, value.value])),
    })),
  };
}

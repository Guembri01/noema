"use server";

import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { guestReadablePageIds } from "@/lib/guest-access";
import { getDatabase } from "@/server/queries";

export type LinkedDatabaseData = {
  databasePageId: string;
  title: string;
  icon: string | null;
  properties: { id: string; name: string; type: string }[];
  views: { id: string; name: string; type: string }[];
  rows: { id: string; title: string; icon: string | null; values: Record<string, unknown> }[];
};

/**
 * Workspace databases available to link.
 *
 * A guest only sees the databases inside their **read** scope (the pages shared
 * with them plus their subtree, ancestors excluded — see `guest-access.ts`).
 * Every other role keeps the whole workspace, exactly as before.
 */
export async function listDatabasesAction(
  workspaceId: string,
): Promise<{ id: string; title: string; icon: string | null }[]> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return [];
  // A guest may only link a database they may read: workspace membership
  // alone says nothing about which pages were shared with them.
  const readable =
    access.role === "GUEST" ? await guestReadablePageIds(user.id, workspaceId) : null;
  return prisma.page.findMany({
    where: {
      workspaceId,
      type: "DATABASE",
      deletedAt: null,
      ...(readable ? { id: { in: [...readable] } } : {}),
    },
    orderBy: { position: "asc" },
    select: { id: true, title: true, icon: true },
  });
}

/**
 * Read a linked database's schema + rows for an embedded (read-only) view.
 *
 * The scope check comes before the row query: a guest whose read scope does not
 * contain the database gets the same `Database not found.` as a guest asking
 * for an id that does not exist — a refusal must not confirm that the database
 * exists (no existence oracle), and an out-of-scope call must not read a
 * single row.
 */
export async function getLinkedDatabaseAction(
  databasePageId: string,
): Promise<LinkedDatabaseData | { error: string }> {
  const user = await requireUser();
  // The page's metadata is read first because the read scope is
  // workspace-scoped — the workspace can only be resolved from the page
  // itself. This select never touches the rows; the row query below runs
  // only after the scope check passed.
  const page = await prisma.page.findUnique({
    where: { id: databasePageId },
    select: { workspaceId: true, type: true, title: true, icon: true },
  });
  if (!page || page.type !== "DATABASE") return { error: "Database not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  // No membership at all is the same answer as "not in your scope": a refusal
  // must not confirm that the database exists (no existence oracle).
  if (!access) return { error: "Database not found." };

  /**
   * The viewer's **read** scope — the pages they may read (the pages shared
   * with them plus their whole subtree, never an ancestor).
   *
   * A guest may read a database only inside their read scope: a shared row
   * does not grant the database above it, a shared parent page does grant the
   * database below it. The same scope decides which relation *targets* of this
   * database may be resolved: `getDatabase` filters them by it, so a target
   * outside the scope delivers no rows, no cell values and no schema. Every
   * other role has no scope (`null`) and sees the workspace as before — the
   * scope query therefore runs for a guest alone, and **once**.
   */
  const readable =
    access.role === "GUEST"
      ? await guestReadablePageIds(user.id, page.workspaceId)
      : null;
  if (readable && !readable.has(databasePageId)) {
    return { error: "Database not found." };
  }

  const database = await getDatabase(databasePageId, readable);
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

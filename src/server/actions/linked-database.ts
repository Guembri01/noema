"use server";

import { requireUser } from "@/lib/auth";
import {
  canPerformWorkspaceAction,
  getWorkspaceAccess,
} from "@/lib/permissions";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { prisma } from "@/lib/db";
import { guestReadablePageIds } from "@/lib/guest-access";
import { getDatabase, getWorkspaceMembers } from "@/server/queries";

export type LinkedDatabaseData = {
  databasePageId: string;
  title: string;
  icon: string | null;
  properties: { id: string; name: string; type: string; config: unknown }[];
  views: { id: string; name: string; type: string; config: unknown }[];
  rows: { id: string; title: string; icon: string | null; values: Record<string, unknown> }[];
  /** Whether this reader may write rows through the embed. */
  canEdit: boolean;
  /** The signed-in reader, for agent-stamped cells (VERIFICATION). */
  actingUserId: string;
  /** Workspace members offered by PEOPLE cells; empty without directory access. */
  members: { id: string; name: string }[];
  /** Relation targets keyed by property id, already scoped like the source view. */
  relations: Record<string, { id: string; title: string; icon: string | null }[]>;
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
    select: {
      workspaceId: true,
      type: true,
      title: true,
      icon: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page || page.type !== "DATABASE") return { error: "Database not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  // No membership at all is the same answer as "not in your scope": a refusal
  // must not confirm that the database exists (no existence oracle).
  if (!access) return { error: "Database not found." };

  // A guest's read scope answers both questions below: whether they may open
  // the requested database at all, and which relation *targets* of it may be
  // resolved. A shared row does not grant the database above it; a shared
  // parent page does grant the database below it. Every other role has no
  // scope (`null`) and keeps the whole workspace. Compute it once, so the two
  // checks cannot disagree.
  const readable =
    access.role === "GUEST"
      ? await guestReadablePageIds(user.id, page.workspaceId)
      : null;
  if (readable && !readable.has(databasePageId)) {
    return { error: "Database not found." };
  }

  // A row write is authorised by `createRowAction` / `setPropertyValueAction` /
  // `deleteRowAction` too; this only decides whether the embed *shows* the
  // affordances. A guest never gets them (page capabilities deny edit), and an
  // explicit READ/COMMENT page grant on the database denies them as well.
  const canEdit = pageCapabilitiesFromRelation(access.role, page.permissions).edit;
  const [database, memberRows] = await Promise.all([
    getDatabase(databasePageId, readable),
    // The directory is only read for a reader who can actually use the PEOPLE
    // picker, and only when their workspace role may see the directory.
    canEdit && canPerformWorkspaceAction(access.role, "viewMemberDirectory")
      ? getWorkspaceMembers(page.workspaceId)
      : Promise.resolve([]),
  ]);
  const relationData = database.relationData ?? {};
  return {
    databasePageId,
    title: page.title,
    icon: page.icon,
    properties: database.properties.map((property) => ({
      id: property.id,
      name: property.name,
      type: property.type,
      config: property.config ?? null,
    })),
    views: database.views.map((view) => ({
      id: view.id,
      name: view.name,
      type: view.type,
      config: view.config ?? null,
    })),
    rows: database.rows.map((row) => ({
      id: row.id,
      title: row.title,
      icon: row.icon,
      values: Object.fromEntries(row.propertyValues.map((value) => [value.propertyId, value.value])),
    })),
    canEdit,
    actingUserId: user.id,
    members: memberRows.map((member) => ({ id: member.id, name: member.name })),
    relations: Object.fromEntries(
      Object.entries(relationData).map(([propertyId, data]) => [
        propertyId,
        data.options.map((option) => ({
          id: option.id,
          title: option.title,
          icon: option.icon,
        })),
      ]),
    ),
  };
}

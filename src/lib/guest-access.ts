/**
 * Guest page-scoping.
 *
 * A `GUEST` is an external collaborator: they may only open pages that were
 * explicitly shared with them (a `PagePermission` row), pages inside a teamspace
 * they belong to, and pages they created themselves. Everyone else with any role
 * sees the whole workspace.
 *
 * The pure helpers here are unit-tested; `guestVisiblePageIds` is the query the
 * sidebar, search and the page route all use, so the rule cannot drift.
 */

import { prisma } from "@/lib/db";

/** Minimal shape needed to walk parent chains. */
export type PageLink = { id: string; parentId: string | null };

/**
 * Add every ancestor of the given pages, so a shared child can still be reached
 * through the tree (the sidebar renders parent chains).
 */
export function withAncestors(visibleIds: Iterable<string>, pages: PageLink[]): Set<string> {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const result = new Set<string>(visibleIds);
  for (const id of [...result]) {
    let cursor = byId.get(id)?.parentId ?? null;
    let guard = 0;
    while (cursor && guard < 200) {
      result.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
      guard += 1;
    }
  }
  return result;
}

/** True when the page is reachable for a guest (given the scoped id set). */
export function isVisibleToGuest(pageId: string, visibleIds: Set<string>): boolean {
  return visibleIds.has(pageId);
}

/**
 * Every page a guest may read in this workspace: explicit permissions, pages in
 * their teamspaces, and their own pages — plus the ancestors of all of those.
 */
export async function guestVisiblePageIds(
  userId: string,
  workspaceId: string,
): Promise<Set<string>> {
  const [permissions, memberships, created, pages] = await Promise.all([
    prisma.pagePermission.findMany({
      where: { userId, page: { workspaceId } },
      select: { pageId: true },
    }),
    prisma.teamspaceMember.findMany({
      where: { userId, teamspace: { workspaceId } },
      select: { teamspaceId: true },
    }),
    prisma.page.findMany({
      where: { workspaceId, createdById: userId, deletedAt: null },
      select: { id: true },
    }),
    prisma.page.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, parentId: true, teamspaceId: true },
    }),
  ]);

  const teamspaceIds = new Set(memberships.map((member) => member.teamspaceId));
  const direct = new Set<string>([
    ...permissions.map((permission) => permission.pageId),
    ...created.map((page) => page.id),
  ]);
  for (const page of pages) {
    if (page.teamspaceId && teamspaceIds.has(page.teamspaceId)) direct.add(page.id);
  }
  return withAncestors(direct, pages);
}

/**
 * The id filter to apply to a query, or `null` when the viewer sees everything.
 * Callers pass the result to `getPageTree`/`searchPages`.
 */
export async function pageScopeFor(
  userId: string,
  workspaceId: string,
  role: string,
): Promise<Set<string> | null> {
  if (role !== "GUEST") return null;
  return guestVisiblePageIds(userId, workspaceId);
}

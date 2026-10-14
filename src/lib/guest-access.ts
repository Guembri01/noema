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

/* -------------------------------------------------------------------------- *
 * Pure scoping primitive
 *
 * The helpers below resolve a guest's scope from an in-memory page list, with
 * no database. They model *permission* propagation: a grant on a page covers
 * its whole subtree (descendants inherit it) but never its ancestors — knowing
 * a child exists does not let a guest open its parent, matching the "no
 * existence oracle" rule (`access-inheritance.ts` resolves grants along an
 * explicit ancestry chain the same way, nearest grant winning).
 *
 * NOTE: this is intentionally stricter than `withAncestors`, which adds
 * ancestor *rows* so the sidebar can render a breadcrumb path. Reaching an
 * ancestor to display the tree is not the same as being allowed to read it.
 * -------------------------------------------------------------------------- */

/** A page as the pure scoping helpers see it. */
export type GuestPage = {
  id: string;
  parentId: string | null;
  /** Guests granted read access on this exact page. */
  sharedWithGuestIds?: readonly string[];
  /** Guests granted edit access on this exact page (implies read). */
  editableGuestIds?: readonly string[];
};

function listsGuest(ids: readonly string[] | undefined, guestId: string): boolean {
  return Array.isArray(ids) && ids.includes(guestId);
}

function indexGuestPages(pages: readonly GuestPage[]): Map<string, GuestPage> {
  const byId = new Map<string, GuestPage>();
  for (const page of pages) {
    if (page && typeof page.id === "string") byId.set(page.id, page);
  }
  return byId;
}

/**
 * Every page a guest may **read**: the shared/editable pages plus their whole
 * subtree. Ancestors are never included by inheritance. Fails closed — a
 * blank/unknown guest id or an empty page list yields an empty set.
 */
export function visiblePageIdsForGuest(
  pages: readonly GuestPage[],
  guestId: string,
): Set<string> {
  const visible = new Set<string>();
  if (!guestId) return visible;

  const childrenOf = new Map<string, string[]>();
  for (const page of pages) {
    if (!page || typeof page.id !== "string") continue;
    if (typeof page.parentId !== "string") continue;
    const siblings = childrenOf.get(page.parentId);
    if (siblings) siblings.push(page.id);
    else childrenOf.set(page.parentId, [page.id]);
  }

  const queue: string[] = [];
  for (const page of pages) {
    if (!page || typeof page.id !== "string") continue;
    if (listsGuest(page.sharedWithGuestIds, guestId) || listsGuest(page.editableGuestIds, guestId)) {
      queue.push(page.id);
    }
  }

  // BFS down the tree; `visible` doubles as the visited set, so cycles stop.
  for (const id of queue) {
    if (visible.has(id)) continue;
    visible.add(id);
    const children = childrenOf.get(id);
    if (children) {
      for (const child of children) {
        if (!visible.has(child)) queue.push(child);
      }
    }
  }
  return visible;
}

/**
 * Whether the guest may open the page. Fail closed: an unknown sheet, an
 * unknown guest and a blank id all return `false`.
 */
export function canGuestAccess(
  pages: readonly GuestPage[],
  guestId: string,
  pageId: string,
): boolean {
  if (!guestId || typeof pageId !== "string" || pageId.length === 0) return false;
  return visiblePageIdsForGuest(pages, guestId).has(pageId);
}

/**
 * The readable pages the guest may **edit** (a strict subset of
 * `visiblePageIdsForGuest`): a page is editable when an edit grant sits on it
 * or on any ancestor. Pages covered only by a read share stay in the visible
 * set but are omitted here. Fails closed on a blank guest id, and edit stops
 * at a broken/unknown ancestor chain rather than assuming a grant.
 */
export function guestEditablePageIds(
  pages: readonly GuestPage[],
  guestId: string,
): Set<string> {
  const editableIds = new Set<string>();
  if (!guestId) return editableIds;

  const byId = indexGuestPages(pages);
  for (const id of visiblePageIdsForGuest(pages, guestId)) {
    let cursor: string | null = id;
    let guard = 0;
    while (cursor && guard < 1000) {
      const page = byId.get(cursor);
      if (!page) break;
      if (listsGuest(page.editableGuestIds, guestId)) {
        editableIds.add(id);
        break;
      }
      cursor = typeof page.parentId === "string" ? page.parentId : null;
      guard += 1;
    }
  }
  return editableIds;
}

/**
 * Workspace, page tree, page detail, members and projects.
 *
 * Extracted from src/server/queries.ts; callers keep importing from
 * @/server/queries through the re-export barrel.
 */
import { prisma } from "@/lib/db";
import { paginateSlice, type PaginateResult } from "@/lib/cursor-pagination";

export type PageTreeNode = {
  id: string;
  parentId: string | null;
  teamspaceId: string | null;
  title: string;
  icon: string | null;
  type: "PAGE" | "DATABASE";
  position: number;
  isFavorite: boolean;
};

/** Every workspace the user can open (owner or member). */
export async function getUserWorkspaces(userId: string) {
  return prisma.workspace.findMany({
    where: {
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true, icon: true, ownerId: true },
  });
}

/** Row shape of `GET /api/v1/workspaces`. */
export type ApiWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
};

/**
 * One keyset page of the caller's workspaces (owner or member), ordered by the
 * documented tuple `(createdAt, id)`. Mirrors `getUserWorkspaces`'s access
 * predicate but pages over the opaque cursor dialect.
 */
export async function getWorkspacesPage(
  userId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<PaginateResult<ApiWorkspaceRow>> {
  const rows = await prisma.workspace.findMany({
    where: {
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, slug: true, icon: true, createdAt: true },
  });
  const page = paginateSlice(rows, {
    limit: options.limit,
    cursor: options.cursor,
    direction: "asc",
    keyOf: (row) => ({ key: row.createdAt.toISOString(), tiebreaker: row.id }),
  });
  return {
    items: page.items.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      icon: row.icon,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getWorkspaceBySlug(slug: string) {
  return prisma.workspace.findUnique({ where: { slug } });
}

/** Live (non-trashed) pages in a workspace, ordered for tree rendering. */
export async function getPageTree(
  workspaceId: string,
  /**
   * Guest scoping: only these page ids (plus ancestors) are returned; `null`
   * returns the whole workspace. Required — like `getPagesPage` — so a caller
   * can never forget the filter and silently widen the tree.
   */
  visiblePageIds: Set<string> | null,
): Promise<PageTreeNode[]> {
  return prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      parentId: true,
      teamspaceId: true,
      title: true,
      icon: true,
      type: true,
      position: true,
      isFavorite: true,
    },
  });
}

/** Row shape of `GET /api/v1/pages` (the cursor's sort fields stay internal). */
export type ApiPageRow = {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  type: "PAGE" | "DATABASE";
  updatedAt: Date;
};

/**
 * One keyset page of a workspace's live pages, in the documented total order
 * `(position, createdAt, id)`. The opaque cursor carries `position` as its key
 * and a `createdAt|id` composite tiebreaker, so pages that share a position
 * (`Page.position` defaults to `0`) never overlap or get skipped between calls.
 *
 * `visiblePageIds` is the guest scope (see `pageScopeFor`): `null` returns the
 * whole workspace, a set returns only those pages. It is a required argument
 * so a caller can never forget the filter and silently widen the listing.
 */
export async function getPagesPage(
  workspaceId: string,
  /** Guest scoping: only these page ids are returned; `null` = the whole workspace. */
  visiblePageIds: Set<string> | null,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<PaginateResult<ApiPageRow>> {
  const rows = await prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      parentId: true,
      title: true,
      icon: true,
      type: true,
      updatedAt: true,
      position: true,
      createdAt: true,
    },
  });
  const page = paginateSlice(rows, {
    limit: options.limit,
    cursor: options.cursor,
    direction: "asc",
    keyOf: (row) => ({
      key: row.position,
      tiebreaker: `${row.createdAt.toISOString()}|${row.id}`,
    }),
  });
  return {
    items: page.items.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      title: row.title,
      icon: row.icon,
      type: row.type,
      updatedAt: row.updatedAt,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/** A teamspace as the clients see it. */
export type TeamspaceView = { id: string; name: string; icon: string | null };

/**
 * The teamspaces of a workspace, scoped for the viewer.
 *
 * `visibleTeamspaceIds` is the viewer's teamspace scope (see `viewerScopeFor`
 * in `@/lib/guest-access`): `null` returns every teamspace of the workspace, a
 * set returns only the teamspaces it names. The scope is a **required**
 * argument, so a caller can never forget it and silently widen the listing.
 *
 * The filter is applied twice on purpose: the query narrows the rows the
 * database hands over, and the filter below drops everything outside the scope
 * even if the query layer returned more. A guest's payload must never carry
 * the name of a teamspace they have no business seeing.
 */
export async function getTeamspaces(
  workspaceId: string,
  visibleTeamspaceIds: Set<string> | null,
): Promise<TeamspaceView[]> {
  const rows = await prisma.teamspace.findMany({
    where: {
      workspaceId,
      ...(visibleTeamspaceIds ? { id: { in: [...visibleTeamspaceIds] } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      icon: true,
    },
  });
  if (!visibleTeamspaceIds) return rows;
  return rows.filter((row) => visibleTeamspaceIds.has(row.id));
}

/** Only pages whose own parent chain reaches the workspace root. */
export function rootPages(tree: PageTreeNode[]): PageTreeNode[] {
  return tree.filter((p) => p.parentId === null);
}

export function childrenOf(tree: PageTreeNode[], parentId: string): PageTreeNode[] {
  return tree.filter((p) => p.parentId === parentId);
}

/**
 * The workspace trash: the pages that were archived, with restore and
 * permanent delete.
 *
 * `visiblePageIds` is the guest scope (see `pageScopeFor`): `null` returns the
 * whole trash, a set returns only the trashed pages the caller may see. It is
 * a required argument — like `getPageTree` — so a caller can never forget the
 * filter and list a title the guest was never given.
 */
export async function getTrash(
  workspaceId: string,
  visiblePageIds: Set<string> | null,
) {
  return prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: { not: null },
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
    select: { id: true, title: true, icon: true, deletedAt: true, parentId: true },
  });
}

export async function getFavorites(
  userId: string,
  workspaceId: string,
  /**
   * Guest scoping: only these page ids are returned. `null` = every page of
   * the workspace. The scope is a **required** argument, so a caller can never
   * forget the filter and silently widen the listing.
   */
  visiblePageIds: Set<string> | null,
) {
  return prisma.favorite.findMany({
    where: {
      userId,
      page: {
        workspaceId,
        deletedAt: null,
        ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
      },
    },
    orderBy: { id: "asc" },
    select: {
      page: { select: { id: true, title: true, icon: true, type: true } },
    },
  });
}

export async function getPageDetail(pageId: string) {
  return prisma.page.findUnique({
    where: { id: pageId },
    include: {
      createdBy: { select: { id: true, name: true, avatarUrl: true } },
      versions: {
        orderBy: { createdAt: "desc" },
        take: 25,
        select: {
          id: true,
          title: true,
          summary: true,
          charDelta: true,
          createdAt: true,
          createdById: true,
          // Stored ProseMirror body, folded here so the page route can derive its
          // inline-diff plain text without a second `pageVersion.findMany`.
          content: true,
        },
      },
      shareLinks: {
        select: { id: true, token: true },
        take: 1,
      },
      comments: {
        where: { parentId: null },
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { id: true, name: true, avatarUrl: true } },
          reactions: { select: { emoji: true, userId: true } },
          replies: {
            orderBy: { createdAt: "asc" },
            include: {
              author: { select: { id: true, name: true, avatarUrl: true } },
              reactions: { select: { emoji: true, userId: true } },
            },
          },
        },
      },
    },
  });
}

export async function getWorkspaceMembers(workspaceId: string) {  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
    },
  });
  return members.map((m) => ({ ...m.user, role: m.role }));
}

/** Ancestry trail (root → … → parent) for the breadcrumb block. */export async function getAncestorTrail(
  workspaceId: string,
  pageId: string,
): Promise<{ id: string; title: string }[]> {
  const trail: { id: string; title: string }[] = [];
  let cursor = await prisma.page.findUnique({
    where: { id: pageId },
    select: { parentId: true },
  });
  let guard = 0;
  while (cursor?.parentId && guard < 50) {
    const parent = await prisma.page.findUnique({
      where: { id: cursor.parentId },
      select: { id: true, title: true, parentId: true, workspaceId: true },
    });
    if (!parent || parent.workspaceId !== workspaceId) break;
    trail.unshift({ id: parent.id, title: parent.title });
    cursor = { parentId: parent.parentId };
    guard += 1;
  }
  return trail;
}

/** Projects with their milestones, for the projects area. */
export async function getProjects(workspaceId: string) {
  return prisma.project.findMany({
    where: { workspaceId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      summary: true,
      description: true,
      status: true,
      color: true,
      icon: true,
      startDate: true,
      dueDate: true,
      milestones: {
        orderBy: [{ position: "asc" }],
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          dueDate: true,
          completedAt: true,
        },
      },
      _count: { select: { pages: true } },
    },
  });
}

export async function getProjectDetail(workspaceId: string, projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: {
      id: true,
      name: true,
      summary: true,
      description: true,
      status: true,
      color: true,
      icon: true,
      startDate: true,
      dueDate: true,
      createdAt: true,
      members: {
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
      },
      milestones: {
        orderBy: [{ position: "asc" }],
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          dueDate: true,
          completedAt: true,
        },
      },
      pages: {
        where: { deletedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, icon: true, type: true },
      },
    },
  });
}

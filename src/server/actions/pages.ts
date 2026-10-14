"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/activity";
import { pageSearchText } from "@/lib/search";
import { requireUser } from "@/lib/auth";
import { dispatchWebhooks } from "@/lib/webhooks";
import {
  canEditContent,
  getWorkspaceAccess,
  type WorkspaceAccess,
} from "@/lib/permissions";
import { parsePageContent } from "@/lib/validation";
import { prosemirrorToText } from "@/lib/blocks";

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

async function authorizePage(
  pageId: string,
): Promise<
  | { error: string }
  | {
      page: { id: string; workspaceId: string; parentId: string | null };
      access: NonNullable<WorkspaceAccess>;
    }
> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, workspaceId: true, parentId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "You do not have access to this page." };
  return { page, access };
}

function revalidateWorkspace(workspaceId: string): void {
  revalidatePath(`/w`, "layout");
  void workspaceId;
}

/** Create a page (or database) and return its id. */
export async function createPageAction(input: {
  workspaceId: string;
  parentId?: string | null;
  type?: "PAGE" | "DATABASE";
  title?: string;
  projectId?: string | null;
}): Promise<Result<{ id: string; slug: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create pages." };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  // Sibling ordering: place the new page after the current maximum.
  const last = await prisma.page.findFirst({
    where: { workspaceId: input.workspaceId, parentId: input.parentId ?? null },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const page = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      type: input.type ?? "PAGE",
      title:
        input.title ?? (input.type === "DATABASE" ? "New database" : "Untitled"),
      createdById: user.id,
      position: (last?.position ?? 0) + 1000,
      searchText: pageSearchText(
        input.title ?? (input.type === "DATABASE" ? "New database" : "Untitled"),
        null,
      ),
    },
    select: { id: true },
  });

  if ((input.type ?? "PAGE") === "DATABASE") {
    await seedDatabaseStructure(page.id);
  }

  await dispatchWebhooks(input.workspaceId, "page.created", {
    pageId: page.id,
    type: input.type ?? "PAGE",
  });

  revalidateWorkspace(input.workspaceId);
  return { ok: true, id: page.id, slug: workspace.slug };
}

/** Create the default properties + views for a fresh database page. */
async function seedDatabaseStructure(databasePageId: string): Promise<void> {
  const name = await prisma.property.create({
    data: {
      databasePageId,
      name: "Name",
      type: "TEXT",
      position: 1000,
      config: { primary: true },
    },
  });
  const status = await prisma.property.create({
    data: {
      databasePageId,
      name: "Status",
      type: "STATUS",
      position: 2000,
      config: {
        options: [
          { id: "todo", name: "To-do", color: "gray" },
          { id: "doing", name: "In progress", color: "blue" },
          { id: "done", name: "Done", color: "green" },
        ],
      },
    },
  });
  await prisma.property.create({
    data: {
      databasePageId,
      name: "Owner",
      type: "PEOPLE",
      position: 3000,
    },
  });
  await prisma.property.create({
    data: {
      databasePageId,
      name: "Due",
      type: "DATE",
      position: 4000,
    },
  });

  await prisma.databaseView.createMany({
    data: [
      { databasePageId, name: "Table", type: "TABLE", position: 1000 },
      {
        databasePageId,
        name: "Board",
        type: "BOARD",
        position: 2000,
        config: { groupByPropertyId: status.id },
      },
      { databasePageId, name: "List", type: "LIST", position: 3000 },
    ],
  });

  // A couple of starter rows so the views are not empty.
  const seeded = [
    { name: "Draft the project brief", status: "doing" },
    { name: "Collect requirements", status: "todo" },
  ];
  for (const row of seeded) {
    const page = await prisma.page.create({
      data: {
        workspaceId: (
          await prisma.page.findUniqueOrThrow({
            where: { id: databasePageId },
            select: { workspaceId: true },
          })
        ).workspaceId,
        parentId: databasePageId,
        title: row.name,
        createdById: (await prisma.page.findUniqueOrThrow({
          where: { id: databasePageId },
          select: { createdById: true },
        })).createdById,
      },
      select: { id: true },
    });
    await prisma.propertyValue.create({
      data: {
        propertyId: name.id,
        pageId: page.id,
        value: { text: row.name },
      },
    });
    await prisma.propertyValue.create({
      data: {
        propertyId: status.id,
        pageId: page.id,
        value: { optionId: row.status },
      },
    });
  }
}

/** Patch a page's title/icon/cover/content. */
export async function updatePageAction(
  pageId: string,
  patch: {
    title?: string;
    icon?: string | null;
    coverUrl?: string | null;
    fullWidth?: boolean;
    smallText?: boolean;
    font?: string;
    locked?: boolean;
    content?: unknown;
  },
): Promise<Result> {
  const auth = await authorizePage(pageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) {
    return { error: "You do not have permission to edit this page." };
  }

  // Snapshot the previous revision for history before overwriting content.
  const contentResult =
    patch.content !== undefined
      ? parsePageContent(patch.content)
      : ({ ok: true, doc: undefined } as const);
  if (!contentResult.ok) return { error: contentResult.error };

  const author = await requireUser();
  const previous = await prisma.page.findUnique({
    where: { id: pageId },
    select: { title: true, content: true },
  });
  const contentChanged = contentResult.doc !== undefined;
  const titleChanged =
    patch.title !== undefined && previous !== null && patch.title !== previous.title;
  if (previous && (contentChanged || titleChanged)) {
    const before = prosemirrorToText(previous.content).length;
    const after = contentChanged ? prosemirrorToText(contentResult.doc).length : before;
    await prisma.pageVersion.create({
      data: {
        pageId,
        title: previous.title,
        content: (previous.content ?? undefined) as Prisma.InputJsonValue,
        createdById: author.id,
        summary: titleChanged
          ? contentChanged
            ? `Edited content and renamed to “${patch.title}”`
            : `Renamed to “${patch.title}”`
          : "Edited content",
        charDelta: after - before,
      },
    });
  }

  await prisma.page.update({
    where: { id: pageId },
    data: {
      ...(patch.title !== undefined ? { title: patch.title.slice(0, 500) } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
      ...(patch.coverUrl !== undefined ? { coverUrl: patch.coverUrl } : {}),
      ...(patch.fullWidth !== undefined ? { fullWidth: patch.fullWidth } : {}),
      ...(patch.smallText !== undefined ? { smallText: patch.smallText } : {}),
      ...(patch.font !== undefined ? { font: patch.font.slice(0, 20) } : {}),
      ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
      ...(contentResult.doc !== undefined
        ? { content: contentResult.doc as Prisma.InputJsonValue }
        : {}),
      // Keep the search mirror in step with whatever changed.
      ...(contentResult.doc !== undefined || patch.title !== undefined
        ? {
            searchText: pageSearchText(
              patch.title !== undefined ? patch.title : previous?.title ?? "",
              contentResult.doc !== undefined ? contentResult.doc : previous?.content,
            ),
          }
        : {}),
    },
  });
  await dispatchWebhooks(auth.page.workspaceId, "page.updated", { pageId });
  revalidateWorkspace(auth.page.workspaceId);
  return { ok: true };
}

/** Move a page under a new parent (or to the workspace root). */
export async function movePageAction(
  pageId: string,
  parentId: string | null,
): Promise<Result> {
  const auth = await authorizePage(pageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) {
    return { error: "You do not have permission to move this page." };
  }
  if (parentId === pageId) return { error: "A page cannot be its own parent." };

  // Guard against cycles: the new parent must not be a descendant.
  if (parentId) {
    let cursor: string | null = parentId;
    while (cursor) {
      if (cursor === pageId) {
        return { error: "Cannot move a page into one of its own children." };
      }
      const next: { parentId: string | null } | null =
        await prisma.page.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = next?.parentId ?? null;
    }
  }

  const last = await prisma.page.findFirst({
    where: { workspaceId: auth.page.workspaceId, parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  await prisma.page.update({
    where: { id: pageId },
    data: { parentId, position: (last?.position ?? 0) + 1000 },
  });
  revalidateWorkspace(auth.page.workspaceId);
  return { ok: true };
}

/** Permanently delete every page in the workspace trash (one transaction). */
export async function emptyTrashAction(workspaceId: string): Promise<Result<{ deleted: number }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to empty the trash." };
  }
  const result = await prisma.page.deleteMany({
    where: { workspaceId, deletedAt: { not: null } },
  });
  revalidateWorkspace(workspaceId);
  return { ok: true, deleted: result.count };
}

/** Read a page's document for a read-only synced view. */
export async function getPageContentAction(
  pageId: string,
): Promise<
  | { id: string; title: string; icon: string | null; content: unknown }
  | { error: string }
> {
  const auth = await authorizePage(pageId);
  if ("error" in auth) return auth;
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, title: true, icon: true, content: true },
  });
  if (!page) return { error: "Page not found." };
  return { id: page.id, title: page.title, icon: page.icon, content: page.content };
}

export async function toggleFavoriteAction(
  workspaceId: string,
  pageId: string,
): Promise<Result<{ favorite: boolean }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return { error: "No access." };
  const existing = await prisma.favorite.findUnique({
    where: { userId_pageId: { userId: user.id, pageId } },
  });
  if (existing) {
    await prisma.favorite.delete({ where: { id: existing.id } });
    revalidateWorkspace(workspaceId);
    return { ok: true, favorite: false };
  }
  await prisma.favorite.create({ data: { userId: user.id, pageId } });
  revalidateWorkspace(workspaceId);
  return { ok: true, favorite: true };
}

export async function toggleFollowAction(
  workspaceId: string,
  pageId: string,
): Promise<Result<{ following: boolean }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return { error: "No access." };
  const existing = await prisma.pageFollow.findUnique({
    where: { userId_pageId: { userId: user.id, pageId } },
  });
  if (existing) {
    await prisma.pageFollow.delete({ where: { id: existing.id } });
    revalidateWorkspace(workspaceId);
    return { ok: true, following: false };
  }
  await prisma.pageFollow.create({ data: { userId: user.id, pageId } });
  revalidateWorkspace(workspaceId);
  return { ok: true, following: true };
}

/** Move a page (and its subtree) to another workspace the user can edit. */
export async function transferPageAction(
  pageId: string,
  targetWorkspaceId: string,
): Promise<Result> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  if (page.workspaceId === targetWorkspaceId) {
    return { error: "That page is already in this workspace." };
  }

  const sourceAccess = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!sourceAccess || !canEditContent(sourceAccess.role)) {
    return { error: "You do not have permission to move this page." };
  }
  const targetAccess = await getWorkspaceAccess(user.id, targetWorkspaceId);
  if (!targetAccess || !canEditContent(targetAccess.role)) {
    return { error: "You do not have permission in the target workspace." };
  }

  // Collect the page and every descendant.
  const nodes = await prisma.page.findMany({
    where: { workspaceId: page.workspaceId },
    select: { id: true, parentId: true },
  });
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node.id);
    childrenByParent.set(node.parentId, list);
  }
  const ids: string[] = [];
  const queue = [pageId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    ids.push(current);
    for (const child of childrenByParent.get(current) ?? []) queue.push(child);
  }

  await prisma.page.updateMany({
    where: { id: { in: ids } },
    data: { workspaceId: targetWorkspaceId },
  });
  // The moved root becomes a top-level page in the target workspace.
  await prisma.page.update({ where: { id: pageId }, data: { parentId: null } });

  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Soft-delete a page (moves it to Trash). */
export async function archivePageAction(pageId: string): Promise<Result> {
  const auth = await authorizePage(pageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) {
    return { error: "You do not have permission to delete this page." };
  }
  await prisma.page.update({
    where: { id: pageId },
    data: { deletedAt: new Date(), isArchived: true },
  });
  await logActivity({
    workspaceId: auth.page.workspaceId,
    actorId: null,
    action: "page.archived",
    targetType: "page",
    targetId: pageId,
  });
  revalidateWorkspace(auth.page.workspaceId);
  return { ok: true };
}

export async function restorePageAction(pageId: string): Promise<Result> {
  const auth = await authorizePage(pageId);
  if ("error" in auth) return auth;
  // A page whose parent is still in the trash would restore into an invisible
  // branch, so re-attach it at the workspace root in that case.
  const parentId = auth.page.parentId;
  const parentTrashed = parentId
    ? await prisma.page.findFirst({
        where: { id: parentId, deletedAt: { not: null } },
        select: { id: true },
      })
    : null;
  await prisma.page.update({
    where: { id: pageId },
    data: { deletedAt: null, isArchived: false, ...(parentTrashed ? { parentId: null } : {}) },
  });
  await logActivity({
    workspaceId: auth.page.workspaceId,
    actorId: null,
    action: "page.restored",
    targetType: "page",
    targetId: pageId,
  });
  revalidateWorkspace(auth.page.workspaceId);
  return { ok: true };
}

/** Permanently delete a trashed page and its subtree. */
export async function deletePageAction(pageId: string): Promise<Result> {
  const auth = await authorizePage(pageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) {
    return { error: "You do not have permission to delete this page." };
  }
  await prisma.page.delete({ where: { id: pageId } });
  await logActivity({
    workspaceId: auth.page.workspaceId,
    actorId: null,
    action: "page.deleted",
    targetType: "page",
    targetId: pageId,
  });
  revalidateWorkspace(auth.page.workspaceId);
  return { ok: true };
}

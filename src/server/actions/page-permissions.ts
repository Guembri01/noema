"use server";

import { revalidatePath } from "next/cache";
import type { SharePermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canPerformWorkspaceAction, getWorkspaceAccess } from "@/lib/permissions";

export type PagePermissionRow = {
  userId: string;
  name: string;
  email: string;
  level: SharePermission | null;
};

/** Levels a page permission may be set to; anything else is refused. */
const ASSIGNABLE_LEVELS: SharePermission[] = ["READ", "COMMENT", "EDIT", "FULL"];

/** Workspace members with their explicit page-level permission (or null). */
export async function listPagePermissionsAction(
  pageId: string,
): Promise<PagePermissionRow[]> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return [];
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  // Fail closed: guests (and revoked users) never see the member directory —
  // the roster carries every member's name and email.
  if (!canPerformWorkspaceAction(access?.role ?? null, "viewMemberDirectory")) return [];

  const [members, permissions] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId: page.workspaceId },
      orderBy: { createdAt: "asc" },
      select: { user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.pagePermission.findMany({ where: { pageId } }),
  ]);
  const byUser = new Map(permissions.map((entry) => [entry.userId, entry.level]));
  return members.map((member) => ({
    userId: member.user.id,
    name: member.user.name,
    email: member.user.email,
    level: byUser.get(member.user.id) ?? null,
  }));
}

export async function setPagePermissionAction(
  pageId: string,
  userId: string,
  level: SharePermission | "NONE",
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to change sharing." };
  }
  if (level !== "NONE" && !ASSIGNABLE_LEVELS.includes(level)) {
    return { error: "That access level does not exist." };
  }
  // Only workspace members can hold a page permission; otherwise rows would be
  // written for arbitrary user ids with no membership to back them.
  const target = await prisma.workspaceMember.findFirst({
    where: { workspaceId: page.workspaceId, userId },
    select: { userId: true },
  });
  if (!target) return { error: "That person is not a member of this workspace." };

  if (level === "NONE") {
    await prisma.pagePermission.deleteMany({ where: { pageId, userId } });
  } else {
    await prisma.pagePermission.upsert({
      where: { userId_pageId: { userId, pageId } },
      create: { userId, pageId, level },
      update: { level },
    });
  }
  revalidatePath("/w", "layout");
  return { ok: true };
}


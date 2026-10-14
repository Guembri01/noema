"use server";

import { revalidatePath } from "next/cache";
import type { SharePermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";

export type PagePermissionRow = {
  userId: string;
  name: string;
  email: string;
  level: SharePermission | null;
};

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
  if (!access) return [];

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
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to change sharing." };
  }

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


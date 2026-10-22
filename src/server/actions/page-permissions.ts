"use server";

import { revalidatePath } from "next/cache";
import type { SharePermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canPerformWorkspaceAction, getWorkspaceAccess } from "@/lib/permissions";
import {
  ASSIGNABLE_GUEST_LEVELS,
  ASSIGNABLE_PAGE_LEVELS,
  pageCapabilitiesFromRelation,
} from "@/lib/page-access";

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
    select: {
      workspaceId: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page) return [];
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  // Fail closed: guests (and revoked users) never see the member directory —
  // the roster carries every member's name and email. A page-level READ or
  // COMMENT row also keeps a member out of the sharing panel.
  if (!canPerformWorkspaceAction(access?.role ?? null, "viewMemberDirectory")) return [];
  if (!pageCapabilitiesFromRelation(access?.role, page.permissions).share) return [];

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
    select: {
      workspaceId: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to change sharing." };
  }
  if (!pageCapabilitiesFromRelation(access?.role, page.permissions).share) {
    return { error: "You do not have permission to change sharing on this page." };
  }
  if (level !== "NONE" && !ASSIGNABLE_PAGE_LEVELS.includes(level)) {
    return { error: "That access level does not exist." };
  }
  // Only workspace members can hold a page permission; otherwise rows would be
  // written for arbitrary user ids with no membership to back them.
  const target = await prisma.workspaceMember.findFirst({
    where: { workspaceId: page.workspaceId, userId },
    select: { userId: true, role: true },
  });
  if (!target) return { error: "That person is not a member of this workspace." };

  // A member cannot widen their own page access. Owners and admins are
  // deliberately immune from page restrictions, so their own rows are inert.
  if (target.userId === user.id && access?.role !== "OWNER") {
    return { error: "You cannot change your own page access." };
  }
  // Page restrictions never apply to workspace owners or admins. Only the
  // owner may write a row for them, and even then it has no effect.
  if (
    (target.role === "OWNER" || target.role === "ADMIN") &&
    access?.role !== "OWNER"
  ) {
    return { error: "The workspace owner and admins always have full access." };
  }
  // Guests cannot edit yet, so only read and comment levels are meaningful.
  if (
    target.role === "GUEST" &&
    level !== "NONE" &&
    !ASSIGNABLE_GUEST_LEVELS.includes(level)
  ) {
    return { error: "Guests can only be given read or comment access." };
  }

  if (level === "NONE") {
    // B135: the follow row goes with the permission. A guest whose access to
    // the page was taken away must not keep the notifications of that page:
    // the title would still reach them, long after the access was revoked.
    // The membership removal deletes the follow rows for the same reason
    // (B37) — this is the same revocation on a smaller scale.
    await prisma.$transaction([
      prisma.pagePermission.deleteMany({ where: { pageId, userId } }),
      prisma.pageFollow.deleteMany({ where: { pageId, userId } }),
    ]);
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


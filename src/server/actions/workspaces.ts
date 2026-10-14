"use server";

import { revalidatePath } from "next/cache";
import type { Prisma, WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { workspaceSchema } from "@/lib/validation";
import { uniqueWorkspaceSlug } from "@/server/unique";
import { welcomeDoc } from "@/lib/welcome";
import { logActivity } from "@/lib/activity";
import {
  canDeleteWorkspace,
  canManageMembers,
  getWorkspaceAccess,
} from "@/lib/permissions";

export type WorkspaceResult<T = unknown> =
  | ({ ok: true } & T)
  | { error: string };

/** Roles an admin/owner can assign. Ownership moves only via `transferOwnershipAction`. */
const ASSIGNABLE_ROLES: WorkspaceRole[] = ["ADMIN", "MEMBER", "GUEST"];

/**
 * Create a workspace with a starter page.
 *
 * Returns the new slug instead of redirecting: a thrown redirect inside a Server
 * Action is caught by the caller's wrapper and would surface as a failure, so the
 * client navigates once the action reports success.
 */
export async function createWorkspaceAction(input: {
  name: string;
  icon?: string;
  withWelcomePage?: boolean;
}): Promise<WorkspaceResult<{ slug: string; pageId: string | null }>> {
  const user = await requireUser();
  const parsed = workspaceSchema.safeParse({ name: input.name, icon: input.icon || undefined });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const existing = await prisma.workspace.count({
    where: { OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }] },
  });
  if (existing >= 50) {
    return { error: "You have reached the workspace limit for this instance." };
  }

  const workspace = await prisma.workspace.create({
    data: {
      name: parsed.data.name,
      icon: parsed.data.icon ?? null,
      slug: await uniqueWorkspaceSlug(parsed.data.name),
      ownerId: user.id,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
    select: { id: true, slug: true },
  });

  let pageId: string | null = null;
  if (input.withWelcomePage !== false) {
    const page = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        title: "Getting started",
        icon: "👋",
        createdById: user.id,
        content: welcomeDoc() as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    pageId = page.id;
  }

  await logActivity({ workspaceId: workspace.id, actorId: user.id, action: "workspace.created", targetType: "workspace", targetId: workspace.id, meta: { name: parsed.data.name } });
  revalidatePath("/", "layout");
  return { ok: true, slug: workspace.slug, pageId };
}

/** Rename a workspace and/or change its icon. */
export async function updateWorkspaceAction(input: {
  workspaceId: string;
  name?: string;
  icon?: string | null;
}): Promise<WorkspaceResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to change this workspace." };
  }

  const data: Prisma.WorkspaceUpdateInput = {};
  if (input.name !== undefined) {
    const clean = input.name.trim().slice(0, 80);
    if (!clean) return { error: "Name cannot be empty." };
    data.name = clean;
  }
  if (input.icon !== undefined) {
    const icon = (input.icon ?? "").trim().slice(0, 8);
    data.icon = icon || null;
  }
  if (Object.keys(data).length === 0) return { ok: true };

  await prisma.workspace.update({ where: { id: input.workspaceId }, data });
  await logActivity({ workspaceId: input.workspaceId, actorId: user.id, action: "workspace.updated", targetType: "workspace", targetId: input.workspaceId });
  revalidatePath("/", "layout");
  revalidatePath("/w", "layout");
  return { ok: true };
}

/**
 * Delete a workspace and everything in it (owner only, typed confirmation).
 */
export async function deleteWorkspaceAction(
  workspaceId: string,
  confirmation: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canDeleteWorkspace(access.role)) {
    return { error: "Only the workspace owner can delete it." };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });
  if (!workspace) return { error: "Workspace not found." };
  if (confirmation.trim() !== workspace.name) {
    return { error: "The name you typed does not match this workspace." };
  }
  await prisma.workspace.delete({ where: { id: workspaceId } });
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Change a member's role. Ownership moves only through `transferOwnershipAction`. */
export async function setMemberRoleAction(
  workspaceId: string,
  userId: string,
  role: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to change roles." };
  }
  if (!ASSIGNABLE_ROLES.includes(role as WorkspaceRole)) {
    return { error: "That role cannot be assigned here." };
  }

  const target = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true, role: true, user: { select: { name: true } } },
  });
  if (!target) return { error: "That person is not a member of this workspace." };

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true, name: true },
  });
  if (!workspace) return { error: "Workspace not found." };
  if (target.role === "OWNER" || userId === workspace.ownerId) {
    return { error: "Transfer ownership before changing the owner's role." };
  }
  if (access.role === "ADMIN" && target.role === "ADMIN") {
    return { error: "Only the owner can change another admin." };
  }

  await prisma.workspaceMember.update({
    where: { id: target.id },
    data: { role: role as WorkspaceRole },
  });
  await logActivity({ workspaceId, actorId: user.id, action: "member.role_changed", targetType: "member", targetId: userId, meta: { role, name: target.user.name } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Remove someone from the workspace (they keep nothing; pages stay). */
export async function removeMemberAction(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to remove members." };
  }
  if (userId === user.id) return { error: "Use “Leave workspace” to remove yourself." };

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });
  if (!workspace) return { error: "Workspace not found." };
  if (userId === workspace.ownerId) {
    return { error: "The owner cannot be removed — transfer ownership first." };
  }

  const target = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true, role: true },
  });
  if (!target) return { error: "That person is not a member of this workspace." };
  if (access.role === "ADMIN" && target.role === "ADMIN") {
    return { error: "Only the owner can remove another admin." };
  }

  await prisma.workspaceMember.delete({ where: { id: target.id } });
  await logActivity({ workspaceId, actorId: user.id, action: "member.removed", targetType: "member", targetId: userId });
  await prisma.pagePermission.deleteMany({ where: { userId, page: { workspaceId } } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Leave a workspace you were invited to. The owner must transfer or delete it. */
export async function leaveWorkspaceAction(workspaceId: string): Promise<WorkspaceResult> {
  const user = await requireUser();
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });
  if (!workspace) return { error: "Workspace not found." };
  if (workspace.ownerId === user.id) {
    return {
      error: "You own this workspace — transfer ownership or delete it instead of leaving.",
    };
  }
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: user.id },
    select: { id: true },
  });
  if (!membership) return { error: "You are not a member of this workspace." };

  await prisma.workspaceMember.delete({ where: { id: membership.id } });
  await logActivity({ workspaceId, actorId: user.id, action: "member.left", targetType: "member", targetId: user.id });
  await prisma.pagePermission.deleteMany({ where: { userId: user.id, page: { workspaceId } } });
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Hand the workspace to another member (owner only). */
export async function transferOwnershipAction(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canDeleteWorkspace(access.role)) {
    return { error: "Only the current owner can transfer this workspace." };
  }
  if (userId === user.id) return { error: "You already own this workspace." };

  const target = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  });
  if (!target) return { error: "That person is not a member of this workspace." };

  await logActivity({ workspaceId, actorId: user.id, action: "member.ownership_transferred", targetType: "member", targetId: userId });

  await prisma.$transaction([
    prisma.workspace.update({ where: { id: workspaceId }, data: { ownerId: userId } }),
    prisma.workspaceMember.update({ where: { id: target.id }, data: { role: "OWNER" } }),
    prisma.workspaceMember.updateMany({
      where: { workspaceId, userId: user.id },
      data: { role: "ADMIN" },
    }),
  ]);
  revalidatePath("/", "layout");
  revalidatePath("/w", "layout");
  return { ok: true };
}

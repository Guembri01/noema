"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canManageMembers, canEditContent } from "@/lib/permissions";

export async function createTeamspaceAction(
  workspaceId: string,
  name: string,
  icon?: string,
): Promise<{ ok: true; id: string } | { error: string }> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage teamspaces." };
  }
  const teamspace = await prisma.teamspace.create({
    data: {
      workspaceId,
      name: name.trim().slice(0, 80) || "Teamspace",
      icon: icon?.trim().slice(0, 8) || null,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
    select: { id: true },
  });
  revalidatePath("/w", "layout");
  return { ok: true, id: teamspace.id };
}

export async function deleteTeamspaceAction(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const teamspace = await prisma.teamspace.findUnique({
    where: { id },
    select: { workspaceId: true },
  });
  if (!teamspace) return { error: "Teamspace not found." };
  const access = await getWorkspaceAccess(user.id, teamspace.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage teamspaces." };
  }
  await prisma.teamspace.delete({ where: { id } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

export async function addTeamspaceMemberAction(
  teamspaceId: string,
  userId: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const teamspace = await prisma.teamspace.findUnique({
    where: { id: teamspaceId },
    select: { workspaceId: true },
  });
  if (!teamspace) return { error: "Teamspace not found." };
  const access = await getWorkspaceAccess(user.id, teamspace.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage teamspaces." };
  }
  await prisma.teamspaceMember.upsert({
    where: { teamspaceId_userId: { teamspaceId, userId } },
    create: { teamspaceId, userId, role: "MEMBER" },
    update: {},
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}

export async function removeTeamspaceMemberAction(
  teamspaceId: string,
  userId: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const teamspace = await prisma.teamspace.findUnique({
    where: { id: teamspaceId },
    select: { workspaceId: true },
  });
  if (!teamspace) return { error: "Teamspace not found." };
  const access = await getWorkspaceAccess(user.id, teamspace.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage teamspaces." };
  }
  await prisma.teamspaceMember.deleteMany({ where: { teamspaceId, userId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Assign a page to a teamspace (or clear it). */
export async function setPageTeamspaceAction(
  pageId: string,
  teamspaceId: string | null,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to move this page." };
  }
  await prisma.page.update({ where: { id: pageId }, data: { teamspaceId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

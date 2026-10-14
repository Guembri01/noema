import { WorkspaceRole } from "@prisma/client";
import { prisma } from "./db";

export type WorkspaceAccess = { role: WorkspaceRole } | null;

/**
 * Resolve a user's effective access to a workspace. The workspace owner is
 * always treated as OWNER even if no membership row exists.
 */
export async function getWorkspaceAccess(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceAccess> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (member) return { role: member.role };

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });
  if (workspace?.ownerId === userId) return { role: WorkspaceRole.OWNER };
  return null;
}

export function canEditContent(role: WorkspaceRole): boolean {
  return role !== WorkspaceRole.GUEST;
}

export function canManageMembers(role: WorkspaceRole): boolean {
  return role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN;
}

export function canDeleteWorkspace(role: WorkspaceRole): boolean {
  return role === WorkspaceRole.OWNER;
}

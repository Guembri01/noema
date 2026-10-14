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

/**
 * Workspace actions with an explicit role grant-list. Every entry names the
 * roles allowed to perform the action; anything not listed here is denied.
 */
export type WorkspaceAction =
  /** Read the workspace member directory (names + emails). */
  | "viewMemberDirectory"
  /** Invite, remove and re-role members (owner/admin). */
  | "manageMembers"
  /** Change workspace settings: rename, webhooks, labels, email, teamspaces. */
  | "manageSettings"
  /** Create/edit/move pages. */
  | "editContent"
  /** Publish share links and set page-level permissions. */
  | "sharePage"
  /** Delete the workspace (owner only). */
  | "deleteWorkspace"
  /** Hand ownership to another member (owner only). */
  | "transferOwnership";

const ACTION_GRANTS: Record<WorkspaceAction, readonly WorkspaceRole[]> = {
  viewMemberDirectory: [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER],
  manageMembers: [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
  manageSettings: [WorkspaceRole.OWNER, WorkspaceRole.ADMIN],
  editContent: [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER],
  sharePage: [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER],
  deleteWorkspace: [WorkspaceRole.OWNER],
  transferOwnership: [WorkspaceRole.OWNER],
};

/**
 * The single authorization decision for workspace-scoped actions — fail closed.
 *
 * - No membership (`null`/`undefined`, i.e. revoked access or never a member)
 *   denies every action.
 * - A role the matrix does not grant (forged/unknown value) denies the action.
 * - An unknown action denies even the owner.
 *
 * Server actions call this instead of hand-rolling role comparisons so the
 * matrix has exactly one home and `permissions.test.ts` can pin it.
 */
export function canPerformWorkspaceAction(
  role: WorkspaceRole | null | undefined,
  action: WorkspaceAction,
): boolean {
  if (!role) return false;
  const grants = ACTION_GRANTS[action];
  if (!grants) return false;
  return grants.includes(role);
}

import { WorkspaceRole } from "@prisma/client";
import { prisma } from "./db";
import { API_SCOPE_IDS } from "./api-token-scope";

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

/** Every read scope of the catalogue — the ceiling of a read-only role. */
const READ_ONLY_API_SCOPES: readonly string[] = API_SCOPE_IDS.filter((id) =>
  id.startsWith("read:"),
);

/**
 * The API scopes a role may exercise, whatever the caller's token asks for.
 *
 * A guest is an external collaborator: they may read, never write and never
 * administer. The list is a *ceiling*, not a grant — the token still decides
 * which of these scopes the caller actually holds, and the request's workspace
 * role is what caps the token, because a token belongs to a user while a role
 * belongs to a workspace.
 */
export function apiScopesForRole(role: WorkspaceRole): readonly string[] {
  return role === WorkspaceRole.GUEST ? READ_ONLY_API_SCOPES : API_SCOPE_IDS;
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

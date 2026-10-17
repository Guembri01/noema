"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser, verifyPassword } from "@/lib/auth";
import { workspaceSchema } from "@/lib/validation";
import { uniqueWorkspaceSlug } from "@/server/unique";
import { welcomeDoc } from "@/lib/welcome";
import { logActivity } from "@/lib/activity";
import {
  canPerformWorkspaceAction,
  getWorkspaceAccess,
} from "@/lib/permissions";
import {
  roleChangeMessage,
  toPersistedRole,
  validatePersistedRoleChange,
} from "@/lib/workspace-role-map";
import {
  PROJECT_ROLE_HIERARCHY,
  assignRole,
  canProjectAction,
  createRoleOverride,
  describeRole,
  effectiveRole,
  listMembers,
  removeMember,
  validateRoleMatrix,
  type ProjectMemberSummary,
  type ProjectRole,
  type RoleOverride,
} from "@/lib/project-roles";
import {
  acceptTransfer,
  auditEntry,
  cancelTransfer,
  declineTransfer,
  describeTransfer,
  expireTransfers,
  isTransferExpired,
  pendingFor,
  startTransfer,
  validateTransfer,
  type TransferRequest,
} from "@/lib/ownership-transfer";

export type WorkspaceResult<T = unknown> =
  | ({ ok: true } & T)
  | { error: string };

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
  if (!canPerformWorkspaceAction(access?.role ?? null, "manageSettings")) {
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
  if (!canPerformWorkspaceAction(access?.role ?? null, "deleteWorkspace")) {
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

/**
 * Change a member's role. Ownership moves only through `transferOwnershipAction`.
 *
 * The decision is made by `@/lib/workspace-roles` via the persisted-enum bridge
 * in `@/lib/workspace-role-map`: `validateRoleChange` gets the full roster so
 * the last-owner check reads real counts, and an admin may only grant a role
 * strictly below their own. The two explicit guards below are kept because the
 * engine does not express them: the owner's row is never re-roled here (that is
 * what a transfer is for), and only the owner may re-role another admin.
 */
export async function setMemberRoleAction(
  workspaceId: string,
  userId: string,
  role: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canPerformWorkspaceAction(access.role, "manageMembers")) {
    return { error: "You do not have permission to change roles." };
  }
  const nextRole = toPersistedRole(role);
  if (!nextRole) {
    return { error: "That role cannot be assigned here." };
  }

  const [target, workspace, roster] = await Promise.all([
    prisma.workspaceMember.findFirst({
      where: { workspaceId, userId },
      select: { id: true, role: true, user: { select: { name: true } } },
    }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { role: true },
    }),
  ]);
  if (!target) return { error: "That person is not a member of this workspace." };
  if (!workspace) return { error: "Workspace not found." };
  if (target.role === "OWNER" || userId === workspace.ownerId) {
    return { error: "Transfer ownership before changing the owner's role." };
  }
  if (access.role === "ADMIN" && target.role === "ADMIN") {
    return { error: "Only the owner can change another admin." };
  }

  const validation = validatePersistedRoleChange({
    actorRole: access.role,
    targetRole: target.role,
    newRole: nextRole,
    members: roster,
    self: userId === user.id,
  });
  if (!validation.ok) return { error: roleChangeMessage(validation.errors) };

  await prisma.workspaceMember.update({
    where: { id: target.id },
    data: { role: nextRole },
  });
  await logActivity({ workspaceId, actorId: user.id, action: "member.role_changed", targetType: "member", targetId: userId, meta: { role: nextRole, name: target.user.name } });
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
  if (!access || !canPerformWorkspaceAction(access.role, "manageMembers")) {
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
  // A removed member keeps nothing: the follow/favorite rows go with the
  // permission rows, so the bell cannot go on reporting the pages of a
  // workspace the person no longer belongs to (the notice carries the title).
  await prisma.pageFollow.deleteMany({ where: { userId, page: { workspaceId } } });
  await prisma.favorite.deleteMany({ where: { userId, page: { workspaceId } } });
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
  // Leaving takes the subscriptions with it: a follow row that outlived the
  // membership would keep reporting the pages of a workspace the person has
  // left (the notice carries the title).
  await prisma.pageFollow.deleteMany({ where: { userId: user.id, page: { workspaceId } } });
  await prisma.favorite.deleteMany({ where: { userId: user.id, page: { workspaceId } } });
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
  if (!canPerformWorkspaceAction(access?.role ?? null, "transferOwnership")) {
    return { error: "Only the current owner can transfer this workspace." };
  }
  if (userId === user.id) return { error: "You already own this workspace." };

  const target = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
    select: { id: true, role: true },
  });
  if (!target) return { error: "That person is not a member of this workspace." };
  // A GUEST is a read-only external collaborator (canEditContent is false), so
  // promoting one to owner would produce an owner who cannot edit content.
  if (target.role === "GUEST") {
    return { error: "A guest cannot own this workspace — promote them to a member first." };
  }

  // The transaction runs first: the activity log records what actually happened,
  // never an attempt that failed halfway.
  await prisma.$transaction([
    prisma.workspace.update({ where: { id: workspaceId }, data: { ownerId: userId } }),
    prisma.workspaceMember.update({ where: { id: target.id }, data: { role: "OWNER" } }),
    prisma.workspaceMember.updateMany({
      where: { workspaceId, userId: user.id },
      data: { role: "ADMIN" },
    }),
  ]);
  await logActivity({ workspaceId, actorId: user.id, action: "member.ownership_transferred", targetType: "member", targetId: userId });
  revalidatePath("/", "layout");
  revalidatePath("/w", "layout");
  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Per-project roles (MISSING_FEATURES §20). Project scope is stored on
 * `ProjectMember.role` as a plain string; every decision is made by the pure
 * `@/lib/project-roles` engine (no role logic is re-derived here).
 * ------------------------------------------------------------------------- */

/**
 * Bridge the persisted `ProjectMember.role` string onto the engine's project
 * roles. Legacy `CLIENT` rows (external, view-only) read as `viewer`; anything
 * unrecognised confers no override at all (fail closed).
 */
const PERSISTED_PROJECT_ROLES: Readonly<Record<string, ProjectRole>> = {
  owner: "owner",
  admin: "admin",
  editor: "editor",
  commenter: "commenter",
  viewer: "viewer",
  OWNER: "owner",
  ADMIN: "admin",
  EDITOR: "editor",
  COMMENTER: "commenter",
  VIEWER: "viewer",
  client: "viewer",
  CLIENT: "viewer",
};

function toProjectRole(role: unknown): ProjectRole | null {
  if (typeof role !== "string") return null;
  return PERSISTED_PROJECT_ROLES[role.trim()] ?? null;
}

/** Project member rows → the engine's override roster, dropping unusable rows. */
function projectOverrides(members: readonly { userId: string; role: string }[]): RoleOverride[] {
  const overrides: RoleOverride[] = [];
  for (const member of members) {
    const role = toProjectRole(member.role);
    if (!role) continue;
    const override = createRoleOverride({ userId: member.userId, role });
    if (override) overrides.push(override);
  }
  return overrides;
}

/**
 * The acting user's effective project role and the roster, resolving the
 * workspace baseline against every project override. A workspace owner/admin
 * keeps a floor on every project even without an explicit `ProjectMember` row,
 * so `assignRole` is handed an explicit override for them (it requires the
 * actor to be a member of the roster it is given).
 */
async function loadProjectRoleContext(projectId: string, actorId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, ownerId: true },
  });
  if (!project) return { ok: false as const, error: "Project not found." };
  const access = await getWorkspaceAccess(actorId, project.workspaceId);
  if (!access) return { ok: false as const, error: "You do not have access to this project." };

  const roster = await prisma.projectMember.findMany({
    where: { projectId },
    select: { userId: true, role: true },
  });
  const overrides = projectOverrides(roster);
  const actorRole = effectiveRole({ id: actorId }, { workspaceRole: access.role, overrides });
  const withActor: RoleOverride[] =
    actorRole && !overrides.some((override) => override.userId === actorId)
      ? [...overrides, { userId: actorId, role: actorRole }]
      : overrides;
  return { ok: true as const, project, access, overrides, actorRole, withActor };
}

/**
 * The editable project role roster: every workspace member with their effective
 * project role, plus the project's own overrides. Gated on workspace access;
 * the editor may render read-only when `canManage` is false.
 *
 * The roster carries every member's name, so it needs the member-directory
 * permission: a `GUEST` never receives it.
 */
export async function listProjectRolesAction(projectId: string): Promise<
  WorkspaceResult<{
    members: ProjectMemberSummary[];
    roles: { id: ProjectRole; description: string }[];
    canManage: boolean;
    actorRole: ProjectRole | null;
    matrixOk: boolean;
  }>
> {
  const user = await requireUser();
  const context = await loadProjectRoleContext(projectId, user.id);
  if (!context.ok) return { error: context.error };
  if (!canPerformWorkspaceAction(context.access.role, "viewMemberDirectory")) {
    return { error: "You do not have permission to view the member directory." };
  }

  const workspaceMembers = await prisma.workspaceMember.findMany({
    where: { workspaceId: context.project.workspaceId },
    select: { userId: true, role: true, user: { select: { id: true, name: true } } },
  });

  const members = listMembers(
    context.overrides,
    workspaceMembers.map((member) => ({
      id: member.userId,
      name: member.user.name,
      workspaceRole: member.role,
    })),
  );

  return {
    ok: true,
    members,
    roles: PROJECT_ROLE_HIERARCHY.map((role) => ({ id: role, description: describeRole(role) })),
    canManage: canProjectAction(context.actorRole, "manageMembers"),
    actorRole: context.actorRole,
    matrixOk: validateRoleMatrix().ok,
  };
}

/** Assign a project role, enforcing the engine's ceiling and last-owner guard. */
export async function setProjectRoleAction(
  projectId: string,
  userId: string,
  role: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const nextRole = toProjectRole(role);
  if (!nextRole) return { error: "That project role is not recognised." };

  const context = await loadProjectRoleContext(projectId, user.id);
  if (!context.ok) return { error: context.error };
  if (!canProjectAction(context.actorRole, "manageMembers")) {
    return { error: "You cannot manage this project's members." };
  }

  const decision = assignRole(context.withActor, { userId, role: nextRole, byUserId: user.id });
  if (!decision.ok) return { error: decision.error };

  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId, userId } },
    create: { projectId, userId, role: nextRole },
    update: { role: nextRole },
  });
  await logActivity({
    workspaceId: context.project.workspaceId,
    actorId: user.id,
    action: "member.role_changed",
    targetType: "member",
    targetId: userId,
    meta: { scope: "project", projectId, role: nextRole },
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Remove someone from a project, never orphaning its last owner. */
export async function removeProjectRoleAction(
  projectId: string,
  userId: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const context = await loadProjectRoleContext(projectId, user.id);
  if (!context.ok) return { error: context.error };
  if (userId === context.project.ownerId) {
    return { error: "Transfer project ownership before removing the owner." };
  }
  if (!canProjectAction(context.actorRole, "manageMembers")) {
    return { error: "You cannot manage this project's members." };
  }

  const decision = removeMember(context.withActor, userId);
  if (!decision.ok) return { error: decision.error };

  await prisma.projectMember.deleteMany({ where: { projectId, userId } });
  await logActivity({
    workspaceId: context.project.workspaceId,
    actorId: user.id,
    action: "member.removed",
    targetType: "member",
    targetId: userId,
    meta: { scope: "project", projectId },
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Workspace ownership transfer (§8). The two-party state machine lives in
 * `@/lib/ownership-transfer`; this module owns persistence and the final
 * atomic swap the accepted request implies.
 *
 * There is no `OwnershipTransfer` Prisma model yet, so live (pending) requests
 * are held in an in-process store — they survive the request/accept window on a
 * single server instance and are replayed deterministically by the engine. A
 * model is required for durable, cross-instance transfers. The terminal swap itself is durable (it writes the real rows).
 * ------------------------------------------------------------------------- */

/** Default acceptance window: 7 days. */
const DEFAULT_TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const transferRequests = new Map<string, TransferRequest>();

/** Every transfer row recorded for a workspace (including resolved ones). */
function transfersFor(workspaceId: string): TransferRequest[] {
  return [...transferRequests.values()].filter((request) => request.workspaceId === workspaceId);
}

/** Lapse every expired pending request in the store, returning the fresh rows. */
function expireFor(workspaceId: string, now: number): TransferRequest[] {
  const lapsed = expireTransfers(transfersFor(workspaceId), now);
  for (const request of lapsed) transferRequests.set(request.id, request);
  return transfersFor(workspaceId);
}

/** Open a two-party ownership transfer (owner only). The recipient must accept. */
export async function startOwnershipTransferAction(input: {
  workspaceId: string;
  toUserId: string;
  ttlMs?: number;
  requirePassword?: boolean;
}): Promise<WorkspaceResult<{ id: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "transferOwnership")) {
    return { error: "Only the current owner can start an ownership transfer." };
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { id: true, members: { select: { userId: true, role: true } } },
  });
  if (!workspace) return { error: "Workspace not found." };

  const now = Date.now();
  expireFor(input.workspaceId, now);

  const started = startTransfer({
    workspace: { id: workspace.id, members: workspace.members },
    fromUserId: user.id,
    toUserId: input.toUserId,
    actorRole: access?.role ?? null,
    now,
    ttlMs: input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TRANSFER_TTL_MS,
    requests: transfersFor(input.workspaceId),
    requirePassword: input.requirePassword === true,
    idFactory: () =>
      `xfer_${workspace.id}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  });
  if (!started.ok) return { error: started.error };

  const validation = validateTransfer(started.request, {
    members: workspace.members.map((member) => member.userId),
    now,
  });
  if (!validation.ok) return { error: validation.errors[0] ?? "That transfer is not valid." };

  transferRequests.set(started.request.id, started.request);
  revalidatePath("/w", "layout");
  return { ok: true, id: started.request.id };
}

/**
 * B14 — compare a candidate password with the stored hash of the account that
 * acts.
 *
 * The candidate travels from the client; the verdict does not: it is the
 * server's own comparison against `User.passwordHash`, so a client can no
 * longer assert that a password was confirmed. A stored value that is not a
 * bcrypt hash — an SSO account's `sso:<token>`, for instance — can never match
 * a password, and `bcrypt.compare` throws on some of those values; such an
 * account therefore fails closed.
 */
async function verifyAccountPassword(
  userId: string,
  candidate: string | undefined,
): Promise<boolean> {
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  const stored = account?.passwordHash;
  if (!stored) return false;
  try {
    return await verifyPassword(candidate ?? "", stored);
  } catch {
    // A hash bcrypt cannot work with (unknown variant, illegal cost) can
    // never match a password — the comparison fails closed.
    return false;
  }
}

/**
 * Accept a pending transfer as its recipient. On success the recipient becomes
 * OWNER and the previous owner is demoted to ADMIN, in one transaction.
 *
 * B14 — the password step is the server's own. The client sends the candidate
 * password; the server compares it with the stored hash of the account that
 * acts (the recipient, never the sender) and hands only the *result* to the
 * engine. The old `passwordOk` option is gone: a client that claims the
 * password was confirmed is ignored.
 */
export async function acceptOwnershipTransferAction(
  transferId: string,
  options: { password?: string } = {},
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const request = transferRequests.get(transferId);
  if (!request) return { error: "That transfer request does not exist." };

  const now = Date.now();
  if (isTransferExpired(request, now)) {
    transferRequests.set(request.id, { ...request, status: "expired" });
    return { error: "This transfer request has expired." };
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: request.workspaceId },
    select: { ownerId: true },
  });
  if (!workspace) return { error: "Workspace not found." };
  const target = await prisma.workspaceMember.findFirst({
    where: { workspaceId: request.workspaceId, userId: request.toUserId },
    select: { id: true, role: true },
  });
  if (!target) return { error: "That person is no longer a member of this workspace." };

  // The verdict belongs to the server: the candidate is compared with the
  // acting account's own hash. A non-recipient is never asked for a password.
  const passwordOk =
    request.requirePassword === true && user.id === request.toUserId
      ? await verifyAccountPassword(user.id, options.password)
      : undefined;

  const accepted = acceptTransfer(request, {
    byUserId: user.id,
    now,
    passwordOk,
    memberRole: target.role,
  });
  if (!accepted.ok) return { error: accepted.error };

  // The terminal swap, mirroring `transferOwnershipAction`: owner → ADMIN,
  // recipient → OWNER, and the workspace's `ownerId` handed over.
  await prisma.$transaction([
    prisma.workspace.update({
      where: { id: request.workspaceId },
      data: { ownerId: request.toUserId },
    }),
    prisma.workspaceMember.update({ where: { id: target.id }, data: { role: "OWNER" } }),
    prisma.workspaceMember.updateMany({
      where: { workspaceId: request.workspaceId, userId: request.fromUserId },
      data: { role: "ADMIN" },
    }),
  ]);
  transferRequests.set(request.id, accepted.request);
  await logActivity({
    workspaceId: request.workspaceId,
    actorId: user.id,
    action: "member.ownership_transferred",
    targetType: "member",
    targetId: request.toUserId,
  });
  revalidatePath("/", "layout");
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Decline a pending transfer as its recipient. */
export async function declineOwnershipTransferAction(
  transferId: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const request = transferRequests.get(transferId);
  if (!request) return { error: "That transfer request does not exist." };
  const declined = declineTransfer(request, { byUserId: user.id, now: Date.now() });
  if (!declined.ok) return { error: declined.error };
  transferRequests.set(request.id, declined.request);
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Withdraw a pending transfer as its sender. */
export async function cancelOwnershipTransferAction(
  transferId: string,
): Promise<WorkspaceResult> {
  const user = await requireUser();
  const request = transferRequests.get(transferId);
  if (!request) return { error: "That transfer request does not exist." };
  const cancelled = cancelTransfer(request, { byUserId: user.id, now: Date.now() });
  if (!cancelled.ok) return { error: cancelled.error };
  transferRequests.set(request.id, cancelled.request);
  revalidatePath("/w", "layout");
  return { ok: true };
}

/**
 * The workspace's transfer history, with lazy expiry applied first so a lapsed
 * pending request reads as `expired` rather than silently blocking a new one.
 *
 * Starting a transfer is owner-only (`transferOwnership`), so the history is
 * management data too: a `GUEST` never receives it.
 */
export async function listOwnershipTransfersAction(workspaceId: string): Promise<
  WorkspaceResult<{
    transfers: {
      id: string;
      fromUserId: string;
      toUserId: string;
      status: TransferRequest["status"];
      expiresAt: number;
      acceptedAt: number | null;
      pending: boolean;
      summary: string;
      audit: ReturnType<typeof auditEntry>;
    }[];
  }>
> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canPerformWorkspaceAction(access.role, "manageMembers")) {
    return { error: "You do not have permission to view ownership transfers." };
  }

  const now = Date.now();
  const rows = expireFor(workspaceId, now);
  const live = new Set(pendingFor(rows, workspaceId).map((request) => request.id));
  return {
    ok: true,
    transfers: rows.map((request) => ({
      id: request.id,
      fromUserId: request.fromUserId,
      toUserId: request.toUserId,
      status: request.status,
      expiresAt: request.expiresAt,
      acceptedAt: request.acceptedAt ?? null,
      pending: live.has(request.id),
      summary: describeTransfer(request),
      audit: auditEntry(request, { now }),
    })),
  };
}

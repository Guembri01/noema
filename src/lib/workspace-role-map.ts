/**
 * Bridge between the persisted `WorkspaceRole` enum (uppercase: `OWNER`,
 * `ADMIN`, `MEMBER`, `GUEST` — prisma/schema.prisma) and the pure enforcement
 * engine in `@/lib/workspace-roles` (lowercase: `owner`, `admin`, `member`,
 * `guest`), plus the member-management actions the settings UI and the server
 * actions share.
 *
 * The database enum is what is stored; the engine is what decides. Nothing else
 * is allowed to re-derive the mapping, so this module is deliberately pure and
 * DB-free — it never imports Prisma. Every conversion fails closed: an
 * unrecognised value maps to `null`, and the engine denies a `null` role. The
 * decisions themselves are never re-implemented here; `canWorkspace`,
 * `capabilitiesFor`, `assignableRoles` and `validateRoleChange` remain the only
 * decision table, and the helpers below merely translate their inputs/outputs
 * into the enum the members UI and the workspace actions already speak.
 */

import {
  assignableRoles,
  capabilitiesFor,
  canWorkspace,
  validateRoleChange,
} from "@/lib/workspace-roles";
import type {
  RoleChangeErrorCode,
  RoleChangeIssue,
  RoleChangeValidation,
  WorkspaceAction,
  WorkspaceMemberLike,
  WorkspaceRole,
} from "@/lib/workspace-roles";

/** The persisted enum values, most privileged first (mirrors prisma's enum). */
export const PERSISTED_WORKSPACE_ROLES = ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const;

/** A value of prisma's `WorkspaceRole` enum. */
export type PersistedWorkspaceRole = (typeof PERSISTED_WORKSPACE_ROLES)[number];

const PERSISTED_TO_ENGINE: Readonly<Record<PersistedWorkspaceRole, WorkspaceRole>> = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  GUEST: "guest",
};

const ENGINE_TO_PERSISTED: Readonly<Record<WorkspaceRole, PersistedWorkspaceRole>> = {
  owner: "OWNER",
  admin: "ADMIN",
  member: "MEMBER",
  guest: "GUEST",
};

/** Whether `value` names a persisted workspace role. */
export function isPersistedWorkspaceRole(value: unknown): value is PersistedWorkspaceRole {
  return (
    typeof value === "string" && (PERSISTED_WORKSPACE_ROLES as readonly string[]).includes(value)
  );
}

/**
 * The engine role for a persisted role, or `null` for anything unknown (an
 * untrusted value can never be interpreted as a grant).
 */
export function toEngineRole(role: unknown): WorkspaceRole | null {
  return isPersistedWorkspaceRole(role) ? PERSISTED_TO_ENGINE[role] : null;
}

/**
 * The persisted role for an engine role, or `null` for anything unknown. The
 * match is case-insensitive and trimmed so both the enum (`"ADMIN"`) and the
 * engine spelling (`"admin"`) round-trip.
 */
export function toPersistedRole(role: unknown): PersistedWorkspaceRole | null {
  if (typeof role !== "string") return null;
  const upper = role.trim().toUpperCase();
  return isPersistedWorkspaceRole(upper) ? upper : null;
}

/** The engine actions the members screen exposes, in the order it presents them. */
export const MEMBERS_ACTIONS = [
  "inviteMember",
  "removeMember",
  "changeRole",
  "transferOwnership",
] as const;

/** A member-management action the members UI can gate on. */
export type MembersAction = (typeof MEMBERS_ACTIONS)[number];

/** Whether a persisted role may perform a member-management action. */
export function canMembersAction(role: unknown, action: MembersAction): boolean {
  return canWorkspace(toEngineRole(role), action);
}

/** What a persisted role may do on the members screen. */
export type MembersCapabilities = {
  /** The engine role, or `null` when the persisted role is unknown. */
  role: WorkspaceRole | null;
  /** The persisted role, or `null` when unknown. */
  persistedRole: PersistedWorkspaceRole | null;
  /** Every workspace action the role holds, from `capabilitiesFor`. */
  actions: WorkspaceAction[];
  /** May invite people. */
  canInvite: boolean;
  /** May remove members. */
  canRemove: boolean;
  /** May change roles. */
  canChangeRole: boolean;
  /** May hand ownership over (owner only). */
  canTransferOwnership: boolean;
  /** Any of the three member-directory powers: invite, remove or re-role. */
  canManageMembers: boolean;
  /** Persisted roles this role may grant, most privileged first. */
  assignable: PersistedWorkspaceRole[];
};

/**
 * Everything the members UI needs to gate itself, derived once from the engine:
 * `capabilitiesFor` for the action set and `assignableRoles` for the picker.
 * An unknown role gets the empty fail-closed shape.
 */
export function membersCapabilities(role: unknown): MembersCapabilities {
  const engineRole = toEngineRole(role);
  const actions = capabilitiesFor(engineRole);
  const has = (action: WorkspaceAction) => actions.includes(action);
  return {
    role: engineRole,
    persistedRole: toPersistedRole(role),
    actions,
    canInvite: has("inviteMember"),
    canRemove: has("removeMember"),
    canChangeRole: has("changeRole"),
    canTransferOwnership: has("transferOwnership"),
    canManageMembers: has("inviteMember") || has("removeMember") || has("changeRole"),
    assignable: assignableRoles(engineRole).map((granted) => ENGINE_TO_PERSISTED[granted]),
  };
}

/** Input for {@link validatePersistedRoleChange}; every role is a persisted value. */
export type PersistedRoleChangeInput = {
  /** The persisted role of the member performing the change. */
  actorRole: unknown;
  /** The persisted role the target holds now. */
  targetRole: unknown;
  /** The persisted role the target should end up with. */
  newRole: unknown;
  /** The roster, used by the engine to count owners. */
  members?: readonly WorkspaceMemberLike[] | null;
  /** True when the actor is changing their own membership. */
  self?: boolean;
};

/**
 * Translate a persisted-role change into the engine's `validateRoleChange` and
 * return its verdict untouched. The roster's roles are translated too, so the
 * engine's owner count reads the same enum it expects.
 */
export function validatePersistedRoleChange(
  input: PersistedRoleChangeInput,
): RoleChangeValidation {
  const members =
    input.members === undefined || input.members === null
      ? undefined
      : input.members.map((member) => ({ role: toEngineRole(member?.role) }));
  return validateRoleChange({
    actorRole: toEngineRole(input.actorRole),
    targetRole: toEngineRole(input.targetRole),
    newRole: toEngineRole(input.newRole),
    members,
    self: input.self,
  });
}

/** A readable message per stable engine error code. */
const ROLE_CHANGE_MESSAGES: Readonly<Record<RoleChangeErrorCode, string>> = {
  unknown_actor: "You do not have permission to change roles.",
  unknown_target_role: "That person is not a member of this workspace.",
  unknown_new_role: "That role cannot be assigned here.",
  actor_cannot_change_roles: "You do not have permission to change roles.",
  role_not_assignable: "You can only assign a role below your own.",
  last_owner: "Transfer ownership before changing the owner's role.",
  self_demotion: "Transfer ownership before changing your own role.",
};

/**
 * Catalogue keys for the one-word role names, keyed by persisted role.
 *
 * The member list, the pending-invite rows and the invitation-acceptance card
 * all name a role, and they must name it the same way — so the mapping lives
 * here, in a module with no client boundary, rather than in whichever component
 * happened to need it first.
 */
export const ROLE_LABEL_KEYS: Readonly<
  Record<PersistedWorkspaceRole, "owner" | "admin" | "member" | "guest">
> = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  GUEST: "guest",
};

/** The i18n key for a role, defaulting to `member` for unknown input. */
export function roleLabelKey(role: unknown): "owner" | "admin" | "member" | "guest" {
  const persisted = toPersistedRole(role);
  return persisted ? ROLE_LABEL_KEYS[persisted] : "member";
}

/** The first readable issue, or a generic fallback for an empty list. */
export function roleChangeMessage(issues: readonly RoleChangeIssue[]): string {
  const first = issues[0];
  return first ? ROLE_CHANGE_MESSAGES[first.code] : "That change is not allowed.";
}

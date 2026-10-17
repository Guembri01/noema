/**
 * Workspace role enforcement matrix — the pure decision table behind §8
 * ("Workspace roles", "Owner role", "Admin role"; docs/FEATURE_MATRIX.md).
 *
 * The four roles form a strict inheritance chain `owner ⊃ admin ⊃ member ⊃
 * guest`: a higher role can do everything every lower role can, plus more. The
 * matrix records, per action, the exact prefix of the hierarchy allowed to
 * perform it, so `canWorkspace` is a single table lookup and the inheritance
 * property cannot drift out of sync.
 *
 * This module is deliberately DB-free and side-effect-free: no Prisma, routes,
 * React or clock. Both role and action arguments are typed `unknown` because
 * real callers feed persisted or otherwise untrusted values (a forged
 * membership role, an action read from JSON). Unknown roles, unknown actions,
 * blanks and wrong types all fail closed: `canWorkspace` denies,
 * `capabilitiesFor`/`assignableRoles` return nothing and `describeRole` returns
 * a neutral label. Only {@link assertCan} throws, and only after the same
 * fail-closed checks.
 *
 * The role-change policy is layered on top of the matrix:
 *
 * - an actor may only grant a role *strictly below* its own rank
 *   ({@link assignableRoles}, {@link canGrantRole}) — no peer or upward
 *   escalation; the same rule governs the role a *new* member is invited with,
 *   so an invitation can never grant more than a role change could;
 * - a change that would leave the workspace with no owner is refused
 *   (`last_owner`);
 * - an owner may not demote themselves through a role change (`self_demotion`)
 *   — ownership moves through the `transferOwnership` action instead.
 */

/** The four workspace roles, most privileged first. */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"] as const;

/** A workspace role. */
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * The workspace-scoped actions the matrix governs, in the order a permissions
 * UI should present them.
 */
export const WORKSPACE_ACTIONS = [
  "inviteMember",
  "removeMember",
  "changeRole",
  "manageBilling",
  "manageSettings",
  "deleteWorkspace",
  "transferOwnership",
  "createPage",
  "shareExternally",
  "manageGuests",
  "viewAuditLog",
  "manageIntegrations",
] as const;

/** A workspace-scoped action. */
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

/**
 * The enforcement matrix: for every action, the roles that may perform it,
 * always a prefix of {@link WORKSPACE_ROLES} (so the inheritance chain holds by
 * construction). `owner` appears in every list; `deleteWorkspace` and
 * `transferOwnership` are owner-only.
 */
export const WORKSPACE_PERMISSIONS: Readonly<Record<WorkspaceAction, readonly WorkspaceRole[]>> = {
  inviteMember: ["owner", "admin"],
  removeMember: ["owner", "admin"],
  changeRole: ["owner", "admin"],
  manageBilling: ["owner", "admin"],
  manageSettings: ["owner", "admin"],
  deleteWorkspace: ["owner"],
  transferOwnership: ["owner"],
  createPage: ["owner", "admin", "member"],
  shareExternally: ["owner", "admin"],
  manageGuests: ["owner", "admin"],
  viewAuditLog: ["owner", "admin"],
  manageIntegrations: ["owner", "admin"],
};

/** Short, human-facing display name per role, for a picker or a member list. */
export const ROLE_LABELS: Readonly<Record<WorkspaceRole, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** The hierarchy as a readable alias, most privileged first. */
export const roleHierarchy: readonly WorkspaceRole[] = WORKSPACE_ROLES;

/** One-line description per role, for a picker or a consent screen. */
const ROLE_DESCRIPTIONS: Readonly<Record<WorkspaceRole, string>> = {
  owner: "Owns the workspace and can do everything, including deleting and transferring it",
  admin: "Runs the workspace day to day: members, settings, billing and integrations",
  member: "Creates and edits pages but cannot manage the workspace",
  guest: "Read-only access to the pages they were invited to",
};

/** Fail-closed neutral label for a role that is not in the hierarchy. */
const UNKNOWN_ROLE_DESCRIPTION = "Unknown role";

/** Why a role assertion failed. */
export type WorkspaceRoleErrorCode = "unknown_role" | "unknown_action" | "forbidden";

/** Thrown by {@link assertCan} when a role does not hold an action. */
export class WorkspaceRoleError extends Error {
  readonly code: WorkspaceRoleErrorCode;
  readonly role: unknown;
  readonly action: unknown;

  constructor(code: WorkspaceRoleErrorCode, message: string, role: unknown, action: unknown) {
    super(message);
    this.name = "WorkspaceRoleError";
    this.code = code;
    this.role = role;
    this.action = action;
  }
}

/** Stable rejection codes for {@link validateRoleChange}. */
export type RoleChangeErrorCode =
  | "unknown_actor"
  | "unknown_target_role"
  | "unknown_new_role"
  | "actor_cannot_change_roles"
  | "role_not_assignable"
  | "last_owner"
  | "self_demotion";

/** One reason a role change was refused. */
export type RoleChangeIssue = { code: RoleChangeErrorCode; message: string };

/** A membership reduced to the field the last-owner check reads. */
export type WorkspaceMemberLike = { role?: unknown };

/** Input for {@link validateRoleChange}. Roles are untrusted, hence `unknown`. */
export interface ValidateRoleChangeInput {
  /** The role of the member performing the change. */
  actorRole: unknown;
  /** The current role of the member being changed. */
  targetRole: unknown;
  /** The role the target should end up with. */
  newRole: unknown;
  /** The workspace members, used to count owners. Omitted ⇒ one owner assumed. */
  members?: readonly WorkspaceMemberLike[];
  /** True when the actor is changing their own membership. */
  self?: boolean;
}

/** Outcome of {@link validateRoleChange}; `errors` is empty exactly when `ok`. */
export type RoleChangeValidation = { ok: boolean; errors: RoleChangeIssue[] };

/** Whether `value` names a known workspace role. */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** Whether `value` names a known workspace action. */
export function isWorkspaceAction(value: unknown): value is WorkspaceAction {
  return typeof value === "string" && (WORKSPACE_ACTIONS as readonly string[]).includes(value);
}

/**
 * The rank of a role (lower is more privileged). Unknown values rank *below
 * every known role* so an unrankable value can never outrank a real one.
 */
function rankOf(role: unknown): number {
  return isWorkspaceRole(role) ? WORKSPACE_ROLES.indexOf(role) : WORKSPACE_ROLES.length;
}

/**
 * Whether `role` may perform `action`. Unknown roles and unknown actions fail
 * closed (deny), never throw.
 */
export function canWorkspace(role: unknown, action: unknown): boolean {
  if (!isWorkspaceRole(role) || !isWorkspaceAction(action)) return false;
  return WORKSPACE_PERMISSIONS[action].includes(role);
}

/**
 * Every action `role` may perform, sorted ascending (the UI enabling list).
 * Unknown roles get an empty list (fail closed). The array is freshly built, so
 * callers may mutate it freely.
 */
export function capabilitiesFor(role: unknown): WorkspaceAction[] {
  if (!isWorkspaceRole(role)) return [];
  return WORKSPACE_ACTIONS.filter((action) => canWorkspace(role, action)).sort();
}

/**
 * Assert that `role` may perform `action`, throwing a typed
 * {@link WorkspaceRoleError} otherwise. Unknown roles/actions are rejected as
 * such; a known role without the grant raises `forbidden` carrying both values.
 */
export function assertCan(role: unknown, action: unknown): void {
  if (!isWorkspaceRole(role)) {
    throw new WorkspaceRoleError("unknown_role", `unknown workspace role: ${String(role)}`, role, action);
  }
  if (!isWorkspaceAction(action)) {
    throw new WorkspaceRoleError(
      "unknown_action",
      `unknown workspace action: ${String(action)}`,
      role,
      action,
    );
  }
  if (!canWorkspace(role, action)) {
    throw new WorkspaceRoleError(
      "forbidden",
      `role ${role} may not perform ${action}`,
      role,
      action,
    );
  }
}

/**
 * The roles `actorRole` may grant through a role change, most privileged first.
 *
 * An actor may only grant a role *strictly below* its own rank, so an admin may
 * grant `member`/`guest` but never `admin` or `owner`. Roles that cannot
 * `changeRole` at all (member, guest) and unknown actors get an empty list. The
 * returned array is freshly built.
 */
export function assignableRoles(actorRole: unknown): WorkspaceRole[] {
  if (!isWorkspaceRole(actorRole) || !canWorkspace(actorRole, "changeRole")) return [];
  const actorRank = rankOf(actorRole);
  return WORKSPACE_ROLES.filter((role) => rankOf(role) > actorRank);
}

/**
 * Whether `actorRole` may grant `newRole` to a member.
 *
 * This is the grant rule the role-change path enforces (the
 * `role_not_assignable` check in {@link validateRoleChange}), so the
 * invitation path can ask the same question instead of re-deriving it: an
 * actor may only grant a role *strictly below* its own rank, so an admin may
 * hand out member/guest but never admin — only the owner may grant the admin
 * role.
 *
 * Fails closed on both sides: an unknown actor grants nothing, and an unknown
 * target role is never granted.
 */
export function canGrantRole(actorRole: unknown, newRole: unknown): boolean {
  if (!isWorkspaceRole(newRole)) return false;
  return assignableRoles(actorRole).includes(newRole);
}

/**
 * Compare two roles by privilege: negative when `a` outranks `b`, positive when
 * `b` outranks `a`, zero when they rank equally. Unknown values rank below every
 * known role, so an unrankable value sorts last and never appears more
 * privileged than a real one (`compareRoles("bogus", "guest") > 0`).
 */
export function compareRoles(a: unknown, b: unknown): number {
  return rankOf(a) - rankOf(b);
}

/**
 * A human-facing description of `role`, or a neutral label for an unknown role
 * (fail closed: never guess a role's capabilities).
 */
export function describeRole(role: unknown): string {
  if (isWorkspaceRole(role)) return ROLE_DESCRIPTIONS[role];
  return UNKNOWN_ROLE_DESCRIPTION;
}

/** Count the owners in `members`, assuming the target owner when none are listed. */
function countOwners(
  members: readonly WorkspaceMemberLike[] | undefined,
  assumeTargetOwner: boolean,
): number {
  let count = 0;
  if (Array.isArray(members)) {
    for (const member of members) {
      if (member && typeof member === "object" && member.role === "owner") count += 1;
    }
  }
  // Fail closed: when the caller did not tell us about any owner, the target is
  // the only one we can be sure of.
  if (assumeTargetOwner && count === 0) count = 1;
  return count;
}

function issue(code: RoleChangeErrorCode, message: string): RoleChangeIssue {
  return { code, message };
}

/**
 * Decide whether `actorRole` may move `targetRole` to `newRole`. Every refusal
 * is collected as a stable {@link RoleChangeIssue}, so `ok` is true exactly when
 * `errors` is empty. Checks:
 *
 * - the actor must be a known role that may `changeRole`;
 * - `targetRole` and `newRole` must be known roles;
 * - `newRole` must be assignable by the actor (`role_not_assignable` otherwise),
 *   which blocks peer/upward escalation;
 * - a change that would leave the workspace with no owner is refused
 *   (`last_owner`); with no `members` list the target is assumed to be the only
 *   owner, so the check fails closed;
 * - an owner may not demote themselves (`self_demotion`) — transfer ownership
 *   instead.
 *
 * A no-op change (`newRole === targetRole`) is accepted once the inputs are
 * valid, so the UI can round-trip a selection without a spurious error.
 */
export function validateRoleChange(input: ValidateRoleChangeInput): RoleChangeValidation {
  const errors: RoleChangeIssue[] = [];

  const actor = isWorkspaceRole(input?.actorRole) ? input.actorRole : null;
  if (actor === null) {
    errors.push(issue("unknown_actor", `unknown actor role: ${String(input?.actorRole)}`));
  } else if (!canWorkspace(actor, "changeRole")) {
    errors.push(issue("actor_cannot_change_roles", `role ${actor} may not change roles`));
  }

  const target = isWorkspaceRole(input?.targetRole) ? input.targetRole : null;
  if (target === null) {
    errors.push(issue("unknown_target_role", `unknown target role: ${String(input?.targetRole)}`));
  }

  const next = isWorkspaceRole(input?.newRole) ? input.newRole : null;
  if (next === null) {
    errors.push(issue("unknown_new_role", `unknown new role: ${String(input?.newRole)}`));
  }

  if (actor === null || target === null || next === null) {
    return { ok: false, errors };
  }

  if (target === next) {
    return { ok: errors.length === 0, errors };
  }

  if (!assignableRoles(actor).includes(next)) {
    errors.push(issue("role_not_assignable", `role ${actor} may not grant ${next}`));
  }

  if (target === "owner" && next !== "owner" && countOwners(input?.members, true) <= 1) {
    errors.push(issue("last_owner", "the workspace must keep at least one owner"));
  }

  if (input?.self === true && actor === "owner" && next !== "owner") {
    errors.push(issue("self_demotion", "an owner cannot demote themselves; transfer ownership instead"));
  }

  return { ok: errors.length === 0, errors };
}

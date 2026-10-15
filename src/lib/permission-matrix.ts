/**
 * Workspace permission matrix — one decision table mapping a workspace role to
 * the workspace-scoped actions it may perform.
 *
 * The four roles form a strict inheritance chain
 * `owner ⊃ admin ⊃ member ⊃ guest`: a higher role can do everything every
 * lower role can, plus more. Each action therefore records only the *least*
 * privileged role allowed to perform it, and `can` reads that as a rank
 * comparison. This keeps the table tiny and makes the inheritance property
 * impossible to state inconsistently (a call site cannot grant an action to a
 * lower role without implicitly granting it to every role above).
 *
 * Everything here is pure and synchronous — no DB, routes, React or clock. Both
 * arguments are typed `unknown` because real callers feed the helpers
 * persisted or otherwise untrusted values (a forged membership role, an action
 * read from JSON). Unknown roles, unknown actions, blanks and wrong types all
 * fail closed: `can` denies, `allowedActions` returns nothing and
 * `describeRole` returns a neutral label. Nothing throws.
 *
 * This is the workspace-scoped vocabulary. It intentionally does not import the
 * Prisma enum: callers convert their `WorkspaceRole`/`WorkspaceAction` values at
 * the boundary, so the pure table stays free of the database layer.
 */

/** The four workspace roles, least privileged last. */
export type PermissionRole = "owner" | "admin" | "member" | "guest";

/** The workspace-scoped actions a role can be granted. */
export type PermissionAction =
  | "read"
  | "comment"
  | "edit"
  | "share"
  | "manageMembers"
  | "manageBilling"
  | "deleteWorkspace";

/**
 * The role inheritance chain, most privileged first. A role's rank is its
 * position here; a lower index outranks a higher one. Exported so callers and
 * tests can render the hierarchy directly.
 */
export const ROLE_HIERARCHY: readonly PermissionRole[] = ["owner", "admin", "member", "guest"];

/**
 * Every action, in the order {@link allowedActions} reports them and the order
 * a permissions UI should present them.
 */
export const ACTION_ORDER: readonly PermissionAction[] = [
  "read",
  "comment",
  "edit",
  "share",
  "manageMembers",
  "manageBilling",
  "deleteWorkspace",
];

/**
 * The least privileged role allowed to perform each action. Anything a higher
 * role inherits follows from the rank comparison in {@link can}; there is no
 * per-role list to keep in sync.
 *
 * - `read` / `comment`: any member, including a guest.
 * - `edit` / `share`: members and up — a guest is read/comment only.
 * - `manageMembers` / `manageBilling`: admins and the owner.
 * - `deleteWorkspace`: the owner alone.
 *
 * Typed as a plain string map so an untrusted `action` is a miss (undefined)
 * rather than a type error.
 */
const MIN_ROLE: Record<string, PermissionRole | undefined> = {
  read: "guest",
  comment: "guest",
  edit: "member",
  share: "member",
  manageMembers: "admin",
  manageBilling: "admin",
  deleteWorkspace: "owner",
};

/** One-line, human-facing description per role, for a picker or consent screen. */
const ROLE_DESCRIPTIONS: Record<PermissionRole, string> = {
  owner: "Owns the workspace and can do everything, including deleting it",
  admin: "Can edit and share content and manage members and billing",
  member: "Can read, comment, edit and share content",
  guest: "Can read and comment only",
};

/** Fail-closed neutral label for a role that is not in the hierarchy. */
const UNKNOWN_ROLE_DESCRIPTION = "Unknown role";

/** The rank of a role (lower is more privileged), or `-1` when it is unknown. */
function rankOf(role: unknown): number {
  return typeof role === "string" ? ROLE_HIERARCHY.indexOf(role as PermissionRole) : -1;
}

/**
 * Whether `role` may perform `action`. Inheritance applies: a role can perform
 * an action when it ranks at least as high as the action's minimum role.
 * Unknown roles and actions fail closed (deny).
 */
export function can(role: unknown, action: unknown): boolean {
  const required = typeof action === "string" ? MIN_ROLE[action] : undefined;
  const rank = rankOf(role);
  if (required === undefined || rank === -1) return false;
  return rank <= ROLE_HIERARCHY.indexOf(required);
}

/**
 * Every action `role` may perform, in {@link ACTION_ORDER}. Unknown roles get an
 * empty list (fail closed). The returned array is freshly built, so callers may
 * mutate it freely.
 */
export function allowedActions(role: unknown): PermissionAction[] {
  if (rankOf(role) === -1) return [];
  return ACTION_ORDER.filter((action) => can(role, action));
}

/**
 * A human-facing description of `role`, or a neutral label when the role is
 * unknown (fail closed: never guess a role's capabilities).
 */
export function describeRole(role: unknown): string {
  if (typeof role === "string" && Object.prototype.hasOwnProperty.call(ROLE_DESCRIPTIONS, role)) {
    return ROLE_DESCRIPTIONS[role as PermissionRole];
  }
  return UNKNOWN_ROLE_DESCRIPTION;
}

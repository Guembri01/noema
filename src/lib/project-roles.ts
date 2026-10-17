/**
 * Per-project role editor engine (MISSING_FEATURES §20 "Per-project role
 * editor", built on the §8 workspace roles).
 *
 * A workspace has four coarse roles (`OWNER`/`ADMIN`/`MEMBER`/`GUEST`). This
 * module adds the finer, project-scoped vocabulary that a project owner can
 * edit: five project roles (`owner`/`admin`/`editor`/`commenter`/`viewer`)
 * against six project actions (`view`/`comment`/`edit`/`manageMembers`/
 * `manageSettings`/`deleteProject`), a per-user project override that layers on
 * top of the workspace role, and the roster mutations that keep the project
 * coherent (no privilege escalation above the assigner, never orphaning the
 * last owner).
 *
 * Design rules (the `src/lib` contract):
 *
 * - **Pure and synchronous.** No DB, routes, React or clock. Callers fetch the
 *   workspace role and the project roster, then hand them in; the engine owns
 *   the decision table and the invariants.
 * - **Layering, not replacement.** A project override is a *grant*. The
 *   effective role is the more privileged of the workspace baseline and the
 *   override, so a guest can be raised to `editor` on one project while a
 *   workspace owner or admin keeps their floor everywhere (mirroring the
 *   OWNER/ADMIN grant list of `permissions.ts`).
 * - **Fail closed.** Unknown roles, unknown actions, blanks and wrong types are
 *   denied (`canProjectAction`), dropped (`createRoleOverride`) or reported
 *   (`validateRoleMatrix`); nothing throws.
 * - **Immutable.** Every mutation returns a fresh roster; the inputs are never
 *   touched.
 *
 * `PROJECT_ROLE_PERMISSIONS` is a full role × action grid (not the compressed
 * minimum-role table of `permission-matrix.ts`) because the editor renders the
 * whole grid and {@link validateRoleMatrix} must be able to prove it complete
 * and monotonic.
 */

/** The five project roles, most privileged first. */
export type ProjectRole = "owner" | "admin" | "editor" | "commenter" | "viewer";

/** The project-scoped actions a role can be granted. */
export type ProjectAction =
  | "view"
  | "comment"
  | "edit"
  | "manageMembers"
  | "manageSettings"
  | "deleteProject";

/** The role inheritance chain, most privileged first (index 0 owns the project). */
export const PROJECT_ROLE_HIERARCHY: readonly ProjectRole[] = [
  "owner",
  "admin",
  "editor",
  "commenter",
  "viewer",
];

/** Every action, in the order the editor and {@link effectivePermissions} report them. */
export const PROJECT_ACTION_ORDER: readonly ProjectAction[] = [
  "view",
  "comment",
  "edit",
  "manageMembers",
  "manageSettings",
  "deleteProject",
];

/**
 * The role → action decision table. The chain is strict
 * (`owner ⊃ admin ⊃ editor ⊃ commenter ⊃ viewer`): a higher role can do
 * everything a lower one can, plus more. `owner` alone may delete the project;
 * `admin` and up manage members and settings; `editor` and up edit; `commenter`
 * and up comment; everyone with access may view.
 */
export const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, Record<ProjectAction, boolean>> = {
  owner: {
    view: true,
    comment: true,
    edit: true,
    manageMembers: true,
    manageSettings: true,
    deleteProject: true,
  },
  admin: {
    view: true,
    comment: true,
    edit: true,
    manageMembers: true,
    manageSettings: true,
    deleteProject: false,
  },
  editor: {
    view: true,
    comment: true,
    edit: true,
    manageMembers: false,
    manageSettings: false,
    deleteProject: false,
  },
  commenter: {
    view: true,
    comment: true,
    edit: false,
    manageMembers: false,
    manageSettings: false,
    deleteProject: false,
  },
  viewer: {
    view: true,
    comment: false,
    edit: false,
    manageMembers: false,
    manageSettings: false,
    deleteProject: false,
  },
};

/** A `WorkspaceRole` value as a plain string, so the table stays DB-free. */
export type ProjectWorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";

/** The project-role baseline a workspace role confers on every project. */
const WORKSPACE_BASELINE: Record<ProjectWorkspaceRole, ProjectRole> = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "editor",
  GUEST: "viewer",
};

/** One-line, human-facing description per role, for a picker or consent screen. */
const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: "Owns the project and can do everything, including deleting it",
  admin: "Can edit content and manage project members and settings",
  editor: "Can view, comment on and edit project content",
  commenter: "Can view and comment on project content",
  viewer: "Can view project content only",
};

/** Fail-closed neutral label for a role that is not in the hierarchy. */
const UNKNOWN_ROLE_DESCRIPTION = "Unknown role";

/** A user's project-scoped role assignment. */
export type RoleOverride = {
  /** The user this assignment applies to. */
  userId: string;
  /** The project role granted. */
  role: ProjectRole;
  /**
   * Extra project actions granted on top of the role's matrix, deduped and in
   * `PROJECT_ACTION_ORDER`. Omitted when the role's defaults are enough.
   */
  permissions?: ProjectAction[];
};

/** A user in the roster passed to {@link listMembers}, with their workspace role. */
export type ProjectMemberUser = {
  /** The user's id. */
  id: string;
  /** Display name, when known. */
  name?: string | null;
  /** The user's workspace role, if any; unknown values confer no baseline. */
  workspaceRole?: unknown;
};

/** Where a member's effective project role came from. */
export type ProjectMemberSource = "project" | "workspace" | "none";

/** One row of the project member editor: a user, their effective role and what it allows. */
export type ProjectMemberSummary = {
  userId: string;
  name: string | null;
  role: ProjectRole | null;
  permissions: ProjectAction[];
  source: ProjectMemberSource;
};

/** Options for {@link effectiveRole} / {@link effectivePermissions}. */
export type EffectiveRoleOptions = {
  /** The user's workspace role; anything outside the enum confers no baseline. */
  workspaceRole?: unknown;
  /** The project's roster of overrides. */
  overrides?: readonly RoleOverride[] | null;
};

/** Input for {@link createRoleOverride}; fields are `unknown` to tolerate untrusted JSON. */
export type CreateRoleOverrideInput = {
  userId: unknown;
  role: unknown;
  permissions?: unknown;
};

/** Input for {@link assignRole}. */
export type AssignRoleInput = {
  /** The member whose role changes. */
  userId: unknown;
  /** The requested project role. */
  role: unknown;
  /** The acting member; their own role is the ceiling. */
  byUserId: unknown;
};

/** `ok` carries the new roster; otherwise a refusal never mutates anything. */
export type AssignRoleResult =
  | { ok: true; overrides: RoleOverride[] }
  | { ok: false; error: string };

/** Same contract as {@link AssignRoleResult} for removals. */
export type RemoveMemberResult =
  | { ok: true; overrides: RoleOverride[] }
  | { ok: false; error: string };

/** The outcome of {@link validateRoleMatrix}: `ok` or the invariant violations. */
export type RoleMatrixValidation = { ok: true } | { ok: false; errors: string[] };

/** Whether `value` is one of the five project roles. */
export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === "string" && (PROJECT_ROLE_HIERARCHY as readonly string[]).includes(value);
}

/** Whether `value` is one of the six project actions. */
export function isProjectAction(value: unknown): value is ProjectAction {
  return typeof value === "string" && (PROJECT_ACTION_ORDER as readonly string[]).includes(value);
}

/** The privilege rank of a valid role (lower is more privileged), else `-1`. */
function rankOf(role: ProjectRole): number {
  return PROJECT_ROLE_HIERARCHY.indexOf(role);
}

/** A non-blank trimmed string, or `null` for anything else. */
function toId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Read the id off a `string` or `{ id }` user reference; `null` when unusable. */
function userIdOf(user: unknown): string | null {
  if (typeof user === "string") return toId(user);
  if (user !== null && typeof user === "object" && !Array.isArray(user)) {
    return toId((user as Record<string, unknown>).id);
  }
  return null;
}

/** The project baseline for a workspace role; case-insensitive, else `null`. */
function baselineRole(workspaceRole: unknown): ProjectRole | null {
  if (typeof workspaceRole !== "string") return null;
  const key = workspaceRole.trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(WORKSPACE_BASELINE, key)) return null;
  return WORKSPACE_BASELINE[key as ProjectWorkspaceRole];
}

/** Keep only known actions, deduped, in `PROJECT_ACTION_ORDER`. */
function normalizePermissions(value: unknown): ProjectAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ProjectAction>();
  for (const entry of value) if (isProjectAction(entry)) seen.add(entry);
  return PROJECT_ACTION_ORDER.filter((action) => seen.has(action));
}

/** Coerce untrusted input into a {@link RoleOverride}; `null` when unusable. */
function normalizeOverride(raw: unknown): RoleOverride | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const userId = toId(record.userId);
  if (userId === null || !isProjectRole(record.role)) return null;
  const override: RoleOverride = { userId, role: record.role };
  const permissions = normalizePermissions(record.permissions);
  if (permissions.length > 0) override.permissions = permissions;
  return override;
}

/** Normalise a roster, dropping every entry that is not a usable override. */
function normalizeOverrides(overrides: unknown): RoleOverride[] {
  if (!Array.isArray(overrides)) return [];
  const out: RoleOverride[] = [];
  for (const raw of overrides) {
    const override = normalizeOverride(raw);
    if (override) out.push(override);
  }
  return out;
}

/** The last valid override for `userId`, or `null` (last write wins). */
function findOverride(overrides: readonly RoleOverride[], userId: string): RoleOverride | null {
  let found: RoleOverride | null = null;
  for (const override of overrides) if (override.userId === userId) found = override;
  return found;
}

/** How many distinct users the roster places in the owner role. */
function countOwners(overrides: readonly RoleOverride[]): number {
  const owners = new Set<string>();
  for (const override of overrides) if (override.role === "owner") owners.add(override.userId);
  return owners.size;
}

/** Layer an override over a baseline: the more privileged wins (tie → override). */
function resolveRole(override: RoleOverride | null, baseline: ProjectRole | null): ProjectRole | null {
  if (!override) return baseline;
  if (baseline === null) return override.role;
  return rankOf(override.role) <= rankOf(baseline) ? override.role : baseline;
}

/** The action set for a role plus any custom grant on the override, fresh and ordered. */
function permissionsFor(role: ProjectRole, override: RoleOverride | null): ProjectAction[] {
  const granted = new Set<ProjectAction>();
  for (const action of PROJECT_ACTION_ORDER) {
    if (PROJECT_ROLE_PERMISSIONS[role][action]) granted.add(action);
  }
  if (override?.permissions) for (const action of override.permissions) granted.add(action);
  return PROJECT_ACTION_ORDER.filter((action) => granted.has(action));
}

/**
 * Whether `role` may perform `action`, straight from {@link PROJECT_ROLE_PERMISSIONS}.
 * Unknown roles and actions fail closed (deny). Never throws.
 */
export function canProjectAction(role: unknown, action: unknown): boolean {
  if (!isProjectRole(role) || !isProjectAction(action)) return false;
  return PROJECT_ROLE_PERMISSIONS[role][action] === true;
}

/**
 * Build a normalised {@link RoleOverride}: the id is trimmed, the role must be
 * known, and `permissions` is filtered to known actions, deduped, ordered and
 * omitted when empty. Returns `null` for a blank id, unknown role or bad shape.
 */
export function createRoleOverride(input: unknown): RoleOverride | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as CreateRoleOverrideInput;
  const userId = toId(record.userId);
  if (userId === null || !isProjectRole(record.role)) return null;
  const override: RoleOverride = { userId, role: record.role };
  const permissions = normalizePermissions(record.permissions);
  if (permissions.length > 0) override.permissions = permissions;
  return override;
}

/**
 * A user's effective project role: the more privileged of their workspace
 * baseline and any project override. Returns `null` when neither applies (no
 * workspace role and no override), i.e. no project access. Unknown workspace
 * roles and blank user ids fail closed.
 */
export function effectiveRole(user: unknown, options: EffectiveRoleOptions = {}): ProjectRole | null {
  const userId = userIdOf(user);
  if (userId === null) return null;
  const override = findOverride(normalizeOverrides(options.overrides), userId);
  return resolveRole(override, baselineRole(options.workspaceRole));
}

/**
 * Every action a user may perform on the project: their effective role's matrix
 * plus any custom grant on their override, in `PROJECT_ACTION_ORDER`. Empty when
 * they have no role. The returned array is fresh.
 */
export function effectivePermissions(
  user: unknown,
  options: EffectiveRoleOptions = {},
): ProjectAction[] {
  const userId = userIdOf(user);
  if (userId === null) return [];
  const override = findOverride(normalizeOverrides(options.overrides), userId);
  const role = resolveRole(override, baselineRole(options.workspaceRole));
  return role === null ? [] : permissionsFor(role, override);
}

/**
 * Assign `role` to `userId` as `byUserId`. Refuses, with a readable `error` and
 * no changes, when the role is unknown, the assigner is not a project member,
 * the assigner cannot `manageMembers`, the role would escalate above the
 * assigner, or the change would demote the last owner. On success returns a
 * fresh roster where the member's custom permissions (if any) are preserved and
 * duplicates are collapsed. The input is never mutated.
 */
export function assignRole(overrides: unknown, input: AssignRoleInput): AssignRoleResult {
  const list = normalizeOverrides(overrides);
  const targetId = toId(input.userId);
  const actorId = toId(input.byUserId);
  if (!isProjectRole(input.role)) return { ok: false, error: "Unknown project role." };
  if (targetId === null || actorId === null) {
    return { ok: false, error: "An assignment needs a target and an actor." };
  }

  const actor = findOverride(list, actorId);
  if (!actor) return { ok: false, error: "The assigner is not a project member." };
  if (!canProjectAction(actor.role, "manageMembers")) {
    return { ok: false, error: "The assigner cannot manage project members." };
  }
  if (rankOf(input.role) < rankOf(actor.role)) {
    return { ok: false, error: "Cannot assign a role above your own." };
  }

  const current = findOverride(list, targetId);
  if (current?.role === "owner" && input.role !== "owner" && countOwners(list) <= 1) {
    return { ok: false, error: "Cannot demote the last owner." };
  }

  const next = list.filter((override) => override.userId !== targetId);
  const assigned: RoleOverride = { userId: targetId, role: input.role };
  if (current?.permissions) assigned.permissions = current.permissions;
  next.push(assigned);
  return { ok: true, overrides: next };
}

/**
 * Remove `userId` from the project. Refuses when they are not a member or are
 * the last owner (removing them would leave the project ownerless). On success
 * returns a fresh roster; the input is never mutated.
 */
export function removeMember(overrides: unknown, userId: unknown): RemoveMemberResult {
  const list = normalizeOverrides(overrides);
  const id = toId(userId);
  if (id === null) return { ok: false, error: "A member id is required." };
  const current = findOverride(list, id);
  if (!current) return { ok: false, error: "Not a project member." };
  if (current.role === "owner" && countOwners(list) <= 1) {
    return { ok: false, error: "Cannot remove the last owner." };
  }
  return { ok: true, overrides: list.filter((override) => override.userId !== id) };
}

/**
 * The editable member list: every user in `users` plus any override-only member
 * missing from the roster, each with their effective role, permissions and
 * source. Sorted most privileged first, then by name/id; members with no role
 * sort last. Fresh objects; neither input is mutated.
 */
export function listMembers(overrides: unknown, users: unknown): ProjectMemberSummary[] {
  const list = normalizeOverrides(overrides);
  const roster = Array.isArray(users) ? (users as unknown[]) : [];

  const byId = new Map<string, ProjectMemberUser>();
  const order: string[] = [];
  const add = (user: ProjectMemberUser) => {
    if (byId.has(user.id)) return;
    byId.set(user.id, user);
    order.push(user.id);
  };

  for (const raw of roster) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const id = toId(record.id);
    if (id === null) continue;
    add({
      id,
      name: typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : null,
      workspaceRole: record.workspaceRole,
    });
  }
  for (const override of list) add({ id: override.userId });

  const summaries = order.map((id) => {
    const user = byId.get(id)!;
    const override = findOverride(list, id);
    const baseline = baselineRole(user.workspaceRole);
    const role = resolveRole(override, baseline);
    const source: ProjectMemberSource =
      role === null
        ? "none"
        : override && (baseline === null || rankOf(override.role) <= rankOf(baseline))
          ? "project"
          : "workspace";
    return {
      userId: id,
      name: user.name ?? null,
      role,
      permissions: role === null ? [] : permissionsFor(role, override),
      source,
    };
  });

  summaries.sort((a, b) => {
    const rankA = a.role === null ? Number.POSITIVE_INFINITY : rankOf(a.role);
    const rankB = b.role === null ? Number.POSITIVE_INFINITY : rankOf(b.role);
    if (rankA !== rankB) return rankA - rankB;
    return (a.name ?? a.userId).localeCompare(b.name ?? b.userId);
  });
  return summaries;
}

/** Whether `matrix[role][action]` is strictly `true` (defensive lookup). */
function isGranted(matrix: Record<string, unknown>, role: string, action: ProjectAction): boolean {
  const row = matrix[role];
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  return (row as Record<string, unknown>)[action] === true;
}

/**
 * Prove the shipped matrix (or an injected candidate) complete and monotonic:
 * every role has a boolean for every action and no stray keys, inheritance holds
 * (`owner ⊃ admin ⊃ editor ⊃ commenter ⊃ viewer`), everyone can `view`, the
 * owner can do everything, some role can delete the project and every action is
 * reachable. Returns `{ ok: true }` or the list of violations; never throws.
 */
export function validateRoleMatrix(
  matrix: unknown = PROJECT_ROLE_PERMISSIONS,
): RoleMatrixValidation {
  if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix)) {
    return { ok: false, errors: ["The role matrix must be an object."] };
  }
  const record = matrix as Record<string, unknown>;
  const errors: string[] = [];

  for (const role of PROJECT_ROLE_HIERARCHY) {
    if (!Object.prototype.hasOwnProperty.call(record, role)) errors.push(`Missing role: ${role}`);
  }
  for (const key of Object.keys(record)) {
    if (!isProjectRole(key)) errors.push(`Unknown role: ${key}`);
  }

  for (const role of PROJECT_ROLE_HIERARCHY) {
    const row = record[role];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`Role ${role} has no permission row.`);
      continue;
    }
    const cells = row as Record<string, unknown>;
    for (const action of PROJECT_ACTION_ORDER) {
      if (typeof cells[action] !== "boolean") {
        errors.push(`Role ${role} is missing a boolean for ${action}.`);
      }
    }
    for (const key of Object.keys(cells)) {
      if (!isProjectAction(key)) errors.push(`Role ${role} has an unknown action: ${key}`);
    }
  }

  for (let i = 1; i < PROJECT_ROLE_HIERARCHY.length; i += 1) {
    const higher = PROJECT_ROLE_HIERARCHY[i - 1];
    const lower = PROJECT_ROLE_HIERARCHY[i];
    for (const action of PROJECT_ACTION_ORDER) {
      if (isGranted(record, lower, action) && !isGranted(record, higher, action)) {
        errors.push(`Role ${lower} grants ${action} but ${higher} does not.`);
      }
    }
  }

  for (const role of PROJECT_ROLE_HIERARCHY) {
    if (!isGranted(record, role, "view")) errors.push(`Role ${role} cannot view the project.`);
  }
  for (const action of PROJECT_ACTION_ORDER) {
    if (!isGranted(record, "owner", action)) errors.push(`The owner cannot ${action}.`);
    if (!PROJECT_ROLE_HIERARCHY.some((role) => isGranted(record, role, action))) {
      errors.push(`No role can ${action}.`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * A human-facing description of `role`, or a neutral label when the role is
 * unknown (fail closed: never guess a role's capabilities).
 */
export function describeRole(role: unknown): string {
  if (isProjectRole(role)) return ROLE_DESCRIPTIONS[role];
  return UNKNOWN_ROLE_DESCRIPTION;
}

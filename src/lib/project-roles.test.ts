import { describe, expect, it } from "vitest";
import {
  PROJECT_ACTION_ORDER,
  PROJECT_ROLE_HIERARCHY,
  PROJECT_ROLE_PERMISSIONS,
  assignRole,
  canProjectAction,
  createRoleOverride,
  describeRole,
  effectivePermissions,
  effectiveRole,
  listMembers,
  removeMember,
  validateRoleMatrix,
} from "./project-roles";
import type { ProjectAction, ProjectMemberUser, ProjectRole, RoleOverride } from "./project-roles";

/**
 * Per-project role editor engine (MISSING_FEATURES §20 "Per-project role
 * editor", built on the §8 workspace roles).
 *
 * Red-first: `src/lib/project-roles.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 *
 * The engine is pure and synchronous — no DB, routes, React or clock. It owns
 * the project-role vocabulary (`viewer`/`commenter`/`editor`/`admin`/`owner` ×
 * the six project actions), layers project-scoped overrides on top of a
 * workspace role, and guards the roster mutations (no privilege escalation, no
 * orphaning the last owner). Unknown roles, actions and junk input fail closed,
 * never throw.
 */

const ROLES: readonly ProjectRole[] = ["owner", "admin", "editor", "commenter", "viewer"];
const ACTIONS: readonly ProjectAction[] = [
  "view",
  "comment",
  "edit",
  "manageMembers",
  "manageSettings",
  "deleteProject",
];

/** The shipped matrix, cloned so a test can knock a hole in it. */
function matrix(
  patch: Partial<Record<string, Record<string, unknown>>> = {},
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const role of ROLES) out[role] = { ...PROJECT_ROLE_PERMISSIONS[role] };
  for (const [role, row] of Object.entries(patch)) out[role] = row as Record<string, unknown>;
  return out;
}

/** A roster with one owner, one admin and one editor. */
const roster = (): RoleOverride[] => [
  createRoleOverride({ userId: "owner1", role: "owner" })!,
  createRoleOverride({ userId: "admin1", role: "admin" })!,
  createRoleOverride({ userId: "member1", role: "editor" })!,
];

describe("PROJECT_ROLE_HIERARCHY", () => {
  it("orders the five roles owner → viewer, each exactly once", () => {
    expect(PROJECT_ROLE_HIERARCHY).toEqual(["owner", "admin", "editor", "commenter", "viewer"]);
    expect(new Set(PROJECT_ROLE_HIERARCHY).size).toBe(PROJECT_ROLE_HIERARCHY.length);
  });
});

describe("PROJECT_ACTION_ORDER", () => {
  it("declares every action once in the documented order", () => {
    expect(PROJECT_ACTION_ORDER).toEqual(ACTIONS);
    expect(new Set(PROJECT_ACTION_ORDER).size).toBe(PROJECT_ACTION_ORDER.length);
  });
});

describe("PROJECT_ROLE_PERMISSIONS", () => {
  it("grants the owner everything and view to every role", () => {
    for (const action of ACTIONS) expect(PROJECT_ROLE_PERMISSIONS.owner[action]).toBe(true);
    for (const role of ROLES) expect(PROJECT_ROLE_PERMISSIONS[role].view).toBe(true);
  });

  it("reserves deleteProject for the owner and management for the admin", () => {
    expect(PROJECT_ROLE_PERMISSIONS.owner.deleteProject).toBe(true);
    for (const role of ROLES.filter((r) => r !== "owner")) {
      expect(PROJECT_ROLE_PERMISSIONS[role].deleteProject).toBe(false);
    }
    expect(PROJECT_ROLE_PERMISSIONS.admin.manageMembers).toBe(true);
    expect(PROJECT_ROLE_PERMISSIONS.admin.manageSettings).toBe(true);
    expect(PROJECT_ROLE_PERMISSIONS.editor.manageMembers).toBe(false);
    expect(PROJECT_ROLE_PERMISSIONS.editor.manageSettings).toBe(false);
  });

  it("separates viewers, commenters and editors", () => {
    expect(PROJECT_ROLE_PERMISSIONS.viewer.comment).toBe(false);
    expect(PROJECT_ROLE_PERMISSIONS.commenter.comment).toBe(true);
    expect(PROJECT_ROLE_PERMISSIONS.commenter.edit).toBe(false);
    expect(PROJECT_ROLE_PERMISSIONS.editor.edit).toBe(true);
  });
});

describe("canProjectAction", () => {
  it("lets the owner do every action", () => {
    for (const action of ACTIONS) expect(canProjectAction("owner", action)).toBe(true);
  });

  it("enforces each role's boundary", () => {
    expect(canProjectAction("viewer", "comment")).toBe(false);
    expect(canProjectAction("commenter", "comment")).toBe(true);
    expect(canProjectAction("commenter", "edit")).toBe(false);
    expect(canProjectAction("editor", "edit")).toBe(true);
    expect(canProjectAction("editor", "manageMembers")).toBe(false);
    expect(canProjectAction("admin", "manageMembers")).toBe(true);
    expect(canProjectAction("admin", "deleteProject")).toBe(false);
    expect(canProjectAction("owner", "deleteProject")).toBe(true);
  });

  it("inherits: whatever a lower role may do, the role above it may too", () => {
    for (let i = 1; i < ROLES.length; i += 1) {
      const higher = ROLES[i - 1];
      const lower = ROLES[i];
      for (const action of ACTIONS) {
        if (canProjectAction(lower, action)) expect(canProjectAction(higher, action)).toBe(true);
      }
    }
  });

  it("fails closed for unknown roles and actions", () => {
    for (const role of ["root", "OWNER", "", " owner", null, undefined, 42]) {
      expect(canProjectAction(role, "view")).toBe(false);
    }
    for (const action of ["delete", "VIEW", "", null, undefined, 7]) {
      expect(canProjectAction("owner", action)).toBe(false);
    }
  });
});

describe("validateRoleMatrix", () => {
  it("accepts the shipped matrix", () => {
    expect(validateRoleMatrix()).toEqual({ ok: true });
  });

  it("flags a missing role, a missing cell and an unknown key", () => {
    const missingRole = matrix();
    delete missingRole.admin;
    expect(validateRoleMatrix(missingRole).ok).toBe(false);

    const missingCell = matrix();
    delete missingCell.viewer.view;
    expect(validateRoleMatrix(missingCell).ok).toBe(false);

    const extraRole = matrix();
    extraRole.superadmin = { ...PROJECT_ROLE_PERMISSIONS.viewer };
    expect(validateRoleMatrix(extraRole).ok).toBe(false);

    const extraAction = matrix();
    extraAction.viewer.fly = true;
    expect(validateRoleMatrix(extraAction).ok).toBe(false);
  });

  it("flags a non-monotonic grant (a lower role outranks the one above)", () => {
    const broken = matrix();
    broken.viewer.edit = true; // the commenter above it still cannot edit
    const result = validateRoleMatrix(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("edit"))).toBe(true);
  });

  it("flags a matrix where nobody can delete the project", () => {
    const broken = matrix();
    broken.owner = { ...broken.owner, deleteProject: false };
    expect(validateRoleMatrix(broken).ok).toBe(false);
  });

  it("fails closed on a non-object matrix", () => {
    expect(validateRoleMatrix(null).ok).toBe(false);
    expect(validateRoleMatrix("nope").ok).toBe(false);
  });
});

describe("createRoleOverride", () => {
  it("builds a normalised override and trims the id", () => {
    expect(createRoleOverride({ userId: "  u1  ", role: "editor" })).toEqual({
      userId: "u1",
      role: "editor",
    });
  });

  it("returns null for a blank id, unknown role or bad shape", () => {
    expect(createRoleOverride({ userId: "", role: "editor" })).toBeNull();
    expect(createRoleOverride({ userId: "u1", role: "root" })).toBeNull();
    expect(createRoleOverride({ userId: "u1", role: 3 })).toBeNull();
    expect(createRoleOverride(null)).toBeNull();
  });

  it("keeps only known permissions, deduped and in action order", () => {
    expect(
      createRoleOverride({
        userId: "u1",
        role: "viewer",
        permissions: ["edit", "view", "bogus", "edit", "view"],
      }),
    ).toEqual({ userId: "u1", role: "viewer", permissions: ["view", "edit"] });
  });

  it("omits permissions when none survive and never shares the array", () => {
    expect(createRoleOverride({ userId: "u1", role: "viewer", permissions: [] })).toEqual({
      userId: "u1",
      role: "viewer",
    });
    expect(createRoleOverride({ userId: "u1", role: "viewer", permissions: ["nope"] })).toEqual({
      userId: "u1",
      role: "viewer",
    });

    const first = createRoleOverride({ userId: "u1", role: "editor", permissions: ["view"] })!;
    first.permissions!.push("deleteProject");
    expect(
      createRoleOverride({ userId: "u1", role: "editor", permissions: ["view"] })?.permissions,
    ).toEqual(["view"]);
  });
});

describe("effectiveRole", () => {
  it("maps each workspace role to its project baseline", () => {
    expect(effectiveRole("u1", { workspaceRole: "OWNER" })).toBe("owner");
    expect(effectiveRole("u1", { workspaceRole: "ADMIN" })).toBe("admin");
    expect(effectiveRole("u1", { workspaceRole: "MEMBER" })).toBe("editor");
    expect(effectiveRole("u1", { workspaceRole: "GUEST" })).toBe("viewer");
  });

  it("accepts a lowercase or padded workspace role", () => {
    expect(effectiveRole("u1", { workspaceRole: "member" })).toBe("editor");
    expect(effectiveRole("u1", { workspaceRole: " guest " })).toBe("viewer");
  });

  it("returns null when there is neither a workspace role nor an override", () => {
    expect(effectiveRole("u1", {})).toBeNull();
    expect(effectiveRole("u1", { workspaceRole: "CONTRACTOR" })).toBeNull();
    expect(effectiveRole("u1", { workspaceRole: null })).toBeNull();
  });

  it("lets a project override elevate beyond the workspace role", () => {
    const overrides = [createRoleOverride({ userId: "u1", role: "editor" })!];
    expect(effectiveRole("u1", { workspaceRole: "GUEST", overrides })).toBe("editor");
  });

  it("never lets an override silently demote below the workspace floor", () => {
    const overrides = [createRoleOverride({ userId: "u1", role: "viewer" })!];
    expect(effectiveRole("u1", { workspaceRole: "MEMBER", overrides })).toBe("editor");
  });

  it("uses an override when the workspace role is unknown, and one user's id object works", () => {
    const overrides = [
      createRoleOverride({ userId: "u1", role: "commenter" })!,
      createRoleOverride({ userId: "u2", role: "owner" })!,
    ];
    expect(effectiveRole("u1", { workspaceRole: "CONTRACTOR", overrides })).toBe("commenter");
    expect(effectiveRole({ id: "u2" }, { workspaceRole: "GUEST", overrides })).toBe("owner");
  });

  it("fails closed for a blank user id", () => {
    expect(effectiveRole("", { workspaceRole: "OWNER" })).toBeNull();
    expect(effectiveRole(null, { workspaceRole: "OWNER" })).toBeNull();
    expect(effectiveRole({ id: "  " }, { workspaceRole: "OWNER" })).toBeNull();
  });
});

describe("effectivePermissions", () => {
  it("reflects the effective role's matrix", () => {
    const overrides = [createRoleOverride({ userId: "u1", role: "editor" })!];
    expect(effectivePermissions("u1", { workspaceRole: "GUEST", overrides })).toEqual([
      "view",
      "comment",
      "edit",
    ]);
  });

  it("adds custom permissions an override grants beyond its role", () => {
    const overrides = [
      createRoleOverride({ userId: "u1", role: "viewer", permissions: ["comment"] })!,
    ];
    expect(effectivePermissions("u1", { workspaceRole: "GUEST", overrides })).toEqual([
      "view",
      "comment",
    ]);

    const elevated = [
      createRoleOverride({ userId: "u1", role: "viewer", permissions: ["manageMembers"] })!,
    ];
    expect(effectivePermissions("u1", { overrides: elevated })).toEqual(["view", "manageMembers"]);
  });

  it("fails closed without a role and returns a fresh array", () => {
    expect(effectivePermissions("u1", {})).toEqual([]);
    expect(effectivePermissions("", { workspaceRole: "OWNER" })).toEqual([]);

    const first = effectivePermissions("u1", { workspaceRole: "OWNER" });
    first.length = 0;
    expect(effectivePermissions("u1", { workspaceRole: "OWNER" })).toEqual([...ACTIONS]);
  });
});

describe("assignRole", () => {
  it("adds a new member at the requested role", () => {
    const result = assignRole(roster(), { userId: "newbie", role: "commenter", byUserId: "admin1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overrides).toHaveLength(4);
      expect(effectiveRole("newbie", { overrides: result.overrides })).toBe("commenter");
    }
  });

  it("updates an existing member without duplicating or mutating the input", () => {
    const input = roster();
    const before = structuredClone(input);
    const result = assignRole(input, { userId: "member1", role: "admin", byUserId: "owner1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const matches = result.overrides.filter((o) => o.userId === "member1");
      expect(matches).toHaveLength(1);
      expect(matches[0].role).toBe("admin");
    }
    expect(input).toEqual(before);
  });

  it("preserves an existing member's custom permissions", () => {
    const input = [
      createRoleOverride({ userId: "owner1", role: "owner" })!,
      createRoleOverride({ userId: "member1", role: "editor", permissions: ["manageMembers"] })!,
    ];
    const result = assignRole(input, { userId: "member1", role: "commenter", byUserId: "owner1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.overrides.find((o) => o.userId === "member1")!;
      expect(entry.role).toBe("commenter");
      expect(entry.permissions).toEqual(["manageMembers"]);
    }
  });

  it("refuses to escalate above the assigner but allows an equal role", () => {
    const escalated = assignRole(roster(), { userId: "member1", role: "owner", byUserId: "admin1" });
    expect(escalated.ok).toBe(false);
    if (!escalated.ok) expect(escalated.error).toMatch(/above your own/i);

    const equal = assignRole(roster(), { userId: "member1", role: "admin", byUserId: "admin1" });
    expect(equal.ok).toBe(true);
  });

  it("refuses to demote the last owner, but allows it when another owner remains", () => {
    const lastOwner = assignRole(roster(), { userId: "owner1", role: "admin", byUserId: "owner1" });
    expect(lastOwner.ok).toBe(false);
    if (!lastOwner.ok) expect(lastOwner.error).toMatch(/last owner/i);

    const two = [
      createRoleOverride({ userId: "owner1", role: "owner" })!,
      createRoleOverride({ userId: "owner2", role: "owner" })!,
    ];
    expect(assignRole(two, { userId: "owner1", role: "admin", byUserId: "owner2" }).ok).toBe(true);
  });

  it("refuses when the assigner is absent or cannot manage members", () => {
    expect(assignRole(roster(), { userId: "member1", role: "editor", byUserId: "ghost" }).ok).toBe(
      false,
    );
    const weak = assignRole(roster(), { userId: "member1", role: "viewer", byUserId: "member1" });
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.error).toMatch(/manage/i);
  });

  it("refuses an unknown requested role", () => {
    expect(assignRole(roster(), { userId: "member1", role: "root", byUserId: "owner1" }).ok).toBe(
      false,
    );
  });
});

describe("removeMember", () => {
  it("removes a member", () => {
    const result = removeMember(roster(), "member1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.overrides.some((o) => o.userId === "member1")).toBe(false);
  });

  it("refuses to remove the last owner, but allows it when another remains", () => {
    const lastOwner = removeMember(roster(), "owner1");
    expect(lastOwner.ok).toBe(false);
    if (!lastOwner.ok) expect(lastOwner.error).toMatch(/last owner/i);

    const two = [
      createRoleOverride({ userId: "owner1", role: "owner" })!,
      createRoleOverride({ userId: "owner2", role: "owner" })!,
    ];
    expect(removeMember(two, "owner1").ok).toBe(true);
  });

  it("refuses to remove a non-member or a blank id", () => {
    expect(removeMember(roster(), "ghost").ok).toBe(false);
    expect(removeMember(roster(), "").ok).toBe(false);
  });
});

describe("listMembers", () => {
  it("sorts the most privileged first, with members who have no role last", () => {
    const users: ProjectMemberUser[] = [
      { id: "g", workspaceRole: "GUEST" },
      { id: "m", workspaceRole: "MEMBER" },
      { id: "o", workspaceRole: "OWNER" },
      { id: "x" },
    ];
    expect(listMembers([], users).map((m) => m.userId)).toEqual(["o", "m", "g", "x"]);
  });

  it("reports each member's effective role, permissions and source", () => {
    const overrides = [createRoleOverride({ userId: "g", role: "editor" })!];
    const [entry] = listMembers(overrides, [{ id: "g", workspaceRole: "GUEST" }]);
    expect(entry).toMatchObject({
      userId: "g",
      role: "editor",
      source: "project",
      permissions: ["view", "comment", "edit"],
    });

    const [fromWorkspace] = listMembers([], [{ id: "m", workspaceRole: "MEMBER", name: "Mia" }]);
    expect(fromWorkspace).toMatchObject({ role: "editor", source: "workspace", name: "Mia" });
  });

  it("includes a project member missing from the roster", () => {
    const overrides = [createRoleOverride({ userId: "client", role: "viewer" })!];
    expect(listMembers(overrides, [{ id: "o", workspaceRole: "OWNER" }]).map((m) => m.userId)).toEqual(
      ["o", "client"],
    );
  });

  it("does not mutate its inputs", () => {
    const overrides = [createRoleOverride({ userId: "u", role: "editor" })!];
    const users: ProjectMemberUser[] = [{ id: "u", workspaceRole: "GUEST" }];
    const before = structuredClone({ overrides, users });
    listMembers(overrides, users);
    expect({ overrides, users }).toEqual(before);
  });
});

describe("describeRole", () => {
  it("gives every known role a distinct, non-empty label and a neutral fallback", () => {
    const labels = ROLES.map((role) => describeRole(role));
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);

    for (const role of ["root", "", null, undefined, 3]) {
      expect(describeRole(role)).toBe("Unknown role");
    }
  });
});

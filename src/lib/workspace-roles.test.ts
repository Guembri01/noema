import { describe, expect, it } from "vitest";
import {
  ROLE_LABELS,
  WORKSPACE_ACTIONS,
  WORKSPACE_PERMISSIONS,
  WORKSPACE_ROLES,
  WorkspaceRoleError,
  assertCan,
  assignableRoles,
  canWorkspace,
  capabilitiesFor,
  compareRoles,
  describeRole,
  roleHierarchy,
  validateRoleChange,
} from "./workspace-roles";
import type { WorkspaceAction, WorkspaceRole } from "./workspace-roles";

/**
 * Workspace role enforcement matrix — the pure decision table behind §8
 * ("Workspace roles / Owner / Admin").
 *
 * Red-first: `src/lib/workspace-roles.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 *
 * Everything here is synchronous and side-effect free — no DB, routes, React or
 * clock — and every unknown role or action fails closed (deny), never throws
 * except through the explicit `assertCan` guard.
 */

const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member", "guest"];
const ACTIONS: readonly WorkspaceAction[] = [
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
];

/** The same actions, alphabetically sorted — what `capabilitiesFor` returns. */
const SORTED_ACTIONS: readonly WorkspaceAction[] = [...ACTIONS].sort() as WorkspaceAction[];

describe("WORKSPACE_ROLES", () => {
  it("lists the four roles most privileged first", () => {
    expect(WORKSPACE_ROLES).toEqual(["owner", "admin", "member", "guest"]);
  });

  it("lists each role exactly once", () => {
    expect(new Set(WORKSPACE_ROLES).size).toBe(WORKSPACE_ROLES.length);
  });
});

describe("WORKSPACE_ACTIONS", () => {
  it("declares every action once in the documented order", () => {
    expect(WORKSPACE_ACTIONS).toEqual(ACTIONS);
    expect(new Set(WORKSPACE_ACTIONS).size).toBe(WORKSPACE_ACTIONS.length);
  });
});

describe("ROLE_LABELS", () => {
  it("has a distinct, non-empty label for every role", () => {
    const labels = ROLES.map((role) => ROLE_LABELS[role]);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("covers exactly the known roles", () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...ROLES].sort());
  });
});

describe("WORKSPACE_PERMISSIONS", () => {
  it("has an entry for every action", () => {
    for (const action of ACTIONS) expect(WORKSPACE_PERMISSIONS[action]).toBeDefined();
    expect(Object.keys(WORKSPACE_PERMISSIONS).sort()).toEqual([...ACTIONS].sort());
  });

  it("grants each action to a non-empty prefix of the hierarchy", () => {
    for (const action of ACTIONS) {
      const granted = WORKSPACE_PERMISSIONS[action];
      expect(granted.length).toBeGreaterThan(0);
      expect(granted).toEqual(WORKSPACE_ROLES.slice(0, granted.length));
    }
  });

  it("grants the owner every action", () => {
    for (const action of ACTIONS) {
      expect(WORKSPACE_PERMISSIONS[action]).toContain("owner");
    }
  });

  it("grants a guest no management or content action", () => {
    for (const action of ACTIONS) {
      expect(WORKSPACE_PERMISSIONS[action]).not.toContain("guest");
    }
  });

  it("reserves delete and ownership transfer for the owner", () => {
    expect(WORKSPACE_PERMISSIONS.deleteWorkspace).toEqual(["owner"]);
    expect(WORKSPACE_PERMISSIONS.transferOwnership).toEqual(["owner"]);
  });

  it("agrees with canWorkspace for every role/action pair", () => {
    // The matrix itself is the source of truth: `canWorkspace` must agree with it.
    for (const action of ACTIONS) {
      for (const role of WORKSPACE_ROLES) {
        expect(canWorkspace(role, action)).toBe(WORKSPACE_PERMISSIONS[action].includes(role));
      }
    }
  });
});

describe("canWorkspace", () => {
  it("lets the owner perform every action", () => {
    for (const action of ACTIONS) expect(canWorkspace("owner", action)).toBe(true);
  });

  it("lets an admin run the workspace but not delete it or transfer ownership", () => {
    for (const action of ACTIONS) {
      const expected = action !== "deleteWorkspace" && action !== "transferOwnership";
      expect(canWorkspace("admin", action)).toBe(expected);
    }
  });

  it("lets a member only create pages", () => {
    for (const action of ACTIONS) {
      expect(canWorkspace("member", action)).toBe(action === "createPage");
    }
  });

  it("denies a guest every action", () => {
    for (const action of ACTIONS) expect(canWorkspace("guest", action)).toBe(false);
  });

  it("inherits: anything a lower role may do, every higher role may do too", () => {
    for (let i = 1; i < WORKSPACE_ROLES.length; i += 1) {
      const higher = WORKSPACE_ROLES[i - 1];
      const lower = WORKSPACE_ROLES[i];
      for (const action of ACTIONS) {
        if (canWorkspace(lower, action)) expect(canWorkspace(higher, action)).toBe(true);
      }
    }
  });

  it("fails closed for unknown, forged or missing roles", () => {
    for (const role of ["root", "OWNER", "", " owner", null, undefined, 42]) {
      expect(canWorkspace(role, "createPage")).toBe(false);
    }
  });

  it("fails closed for unknown, forged or missing actions", () => {
    for (const action of ["launchMissiles", "", "createPage ", null, undefined, 7]) {
      expect(canWorkspace("owner", action)).toBe(false);
    }
  });
});

describe("capabilitiesFor", () => {
  it("returns every action for the owner, sorted", () => {
    expect(capabilitiesFor("owner")).toEqual([...SORTED_ACTIONS]);
  });

  it("returns the admin set without the owner-only actions, sorted", () => {
    expect(capabilitiesFor("admin")).toEqual(
      SORTED_ACTIONS.filter((a) => a !== "deleteWorkspace" && a !== "transferOwnership"),
    );
  });

  it("returns just createPage for a member", () => {
    expect(capabilitiesFor("member")).toEqual(["createPage"]);
  });

  it("returns nothing for a guest or an unknown role", () => {
    expect(capabilitiesFor("guest")).toEqual([]);
    for (const role of ["superadmin", "", null, undefined, 0]) {
      expect(capabilitiesFor(role)).toEqual([]);
    }
  });

  it("always returns an array in ascending order", () => {
    for (const role of WORKSPACE_ROLES) {
      const list = capabilitiesFor(role);
      expect(list).toEqual([...list].sort());
    }
  });

  it("returns a fresh array callers can mutate without corrupting the matrix", () => {
    const first = capabilitiesFor("member");
    first.push("deleteWorkspace");
    expect(capabilitiesFor("member")).toEqual(["createPage"]);
  });
});

describe("assertCan", () => {
  it("does not throw when the role holds the action", () => {
    expect(() => assertCan("owner", "deleteWorkspace")).not.toThrow();
    expect(() => assertCan("member", "createPage")).not.toThrow();
  });

  it("throws a forbidden WorkspaceRoleError carrying the role and action", () => {
    try {
      assertCan("member", "deleteWorkspace");
      throw new Error("expected assertCan to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceRoleError);
      const typed = error as WorkspaceRoleError;
      expect(typed.code).toBe("forbidden");
      expect(typed.role).toBe("member");
      expect(typed.action).toBe("deleteWorkspace");
    }
  });

  it("throws an unknown_role error for a forged role", () => {
    try {
      assertCan("root", "createPage");
      throw new Error("expected assertCan to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceRoleError);
      expect((error as WorkspaceRoleError).code).toBe("unknown_role");
    }
  });

  it("throws an unknown_action error for a forged action", () => {
    try {
      assertCan("owner", "launchMissiles");
      throw new Error("expected assertCan to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceRoleError);
      expect((error as WorkspaceRoleError).code).toBe("unknown_action");
    }
  });
});

describe("assignableRoles", () => {
  it("lets an owner grant any role strictly below it", () => {
    expect(assignableRoles("owner")).toEqual(["admin", "member", "guest"]);
  });

  it("stops an admin from granting owner or admin", () => {
    expect(assignableRoles("admin")).toEqual(["member", "guest"]);
    expect(assignableRoles("admin")).not.toContain("owner");
    expect(assignableRoles("admin")).not.toContain("admin");
  });

  it("grants a member or guest nothing (they cannot change roles)", () => {
    expect(assignableRoles("member")).toEqual([]);
    expect(assignableRoles("guest")).toEqual([]);
  });

  it("fails closed to an empty list for unknown actors", () => {
    for (const role of ["root", "", null, undefined, 9]) {
      expect(assignableRoles(role)).toEqual([]);
    }
  });

  it("never offers a role at or above the actor's own rank", () => {
    for (const actor of WORKSPACE_ROLES) {
      for (const granted of assignableRoles(actor)) {
        expect(compareRoles(actor, granted)).toBeLessThan(0);
      }
    }
  });
});

describe("roleHierarchy and compareRoles", () => {
  it("exposes the hierarchy most privileged first", () => {
    expect(roleHierarchy).toEqual(["owner", "admin", "member", "guest"]);
  });

  it("ranks a more privileged role before a less privileged one", () => {
    expect(compareRoles("owner", "admin")).toBeLessThan(0);
    expect(compareRoles("admin", "owner")).toBeGreaterThan(0);
    expect(compareRoles("member", "guest")).toBeLessThan(0);
    expect(compareRoles("guest", "guest")).toBe(0);
  });

  it("orders every adjacent pair strictly", () => {
    for (let i = 0; i < roleHierarchy.length - 1; i += 1) {
      expect(compareRoles(roleHierarchy[i], roleHierarchy[i + 1])).toBeLessThan(0);
    }
  });

  it("sorts unknown roles below every known role, never above one", () => {
    for (const known of WORKSPACE_ROLES) {
      expect(compareRoles("root", known)).toBeGreaterThan(0);
      expect(compareRoles(known, "root")).toBeLessThan(0);
    }
    expect(compareRoles("root", "ghost")).toBe(0);
  });
});

describe("describeRole", () => {
  it("describes every known role with a distinct, non-empty sentence", () => {
    const descriptions = ROLES.map((role) => describeRole(role));
    for (const description of descriptions) {
      expect(description.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("fails closed to a neutral label for unknown roles", () => {
    for (const role of ["root", "", null, undefined, 3]) {
      expect(describeRole(role)).toBe("Unknown role");
    }
  });
});

/** Collect the stable rejection codes from a role-change check. */
function codes(input: Parameters<typeof validateRoleChange>[0]): string[] {
  return validateRoleChange(input).errors.map((issue) => issue.code);
}

describe("validateRoleChange", () => {
  it("accepts an admin promoting a member to guest", () => {
    const result = validateRoleChange({
      actorRole: "admin",
      targetRole: "member",
      newRole: "guest",
      members: [{ role: "owner" }, { role: "admin" }, { role: "member" }],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts an owner promoting a member to admin", () => {
    expect(
      validateRoleChange({
        actorRole: "owner",
        targetRole: "member",
        newRole: "admin",
        members: [{ role: "owner" }, { role: "member" }],
      }).ok,
    ).toBe(true);
  });

  it("refuses an admin escalating a member to admin or owner", () => {
    const base = { actorRole: "admin", targetRole: "member", members: [{ role: "owner" }] } as const;
    expect(codes({ ...base, newRole: "admin" })).toContain("role_not_assignable");
    expect(codes({ ...base, newRole: "owner" })).toContain("role_not_assignable");
  });

  it("treats a no-op role change as always acceptable", () => {
    expect(
      validateRoleChange({ actorRole: "owner", targetRole: "owner", newRole: "owner" }).ok,
    ).toBe(true);
  });

  it("protects the last owner from demotion by another owner", () => {
    expect(
      codes({
        actorRole: "owner",
        targetRole: "owner",
        newRole: "admin",
        members: [{ role: "owner" }, { role: "member" }],
      }),
    ).toContain("last_owner");
  });

  it("allows demoting an owner when another owner remains", () => {
    expect(
      validateRoleChange({
        actorRole: "owner",
        targetRole: "owner",
        newRole: "admin",
        members: [{ role: "owner" }, { role: "owner" }],
      }).ok,
    ).toBe(true);
  });

  it("fails closed when the owner list is missing", () => {
    expect(
      codes({ actorRole: "owner", targetRole: "owner", newRole: "member" }),
    ).toContain("last_owner");
  });

  it("refuses an owner demoting themselves, even with another owner present", () => {
    expect(
      codes({
        actorRole: "owner",
        targetRole: "owner",
        newRole: "admin",
        members: [{ role: "owner" }, { role: "owner" }],
        self: true,
      }),
    ).toContain("self_demotion");
  });

  it("reports both last_owner and self_demotion for a sole owner stepping down", () => {
    const next = codes({
      actorRole: "owner",
      targetRole: "owner",
      newRole: "guest",
      members: [{ role: "owner" }],
      self: true,
    });
    expect(next).toContain("last_owner");
    expect(next).toContain("self_demotion");
  });

  it("allows an admin to demote themselves to member", () => {
    expect(
      validateRoleChange({
        actorRole: "admin",
        targetRole: "admin",
        newRole: "member",
        members: [{ role: "owner" }, { role: "admin" }],
        self: true,
      }).ok,
    ).toBe(true);
  });

  it("refuses a member or guest acting at all", () => {
    expect(codes({ actorRole: "member", targetRole: "guest", newRole: "member" })).toContain(
      "actor_cannot_change_roles",
    );
    expect(codes({ actorRole: "guest", targetRole: "member", newRole: "guest" })).toContain(
      "actor_cannot_change_roles",
    );
  });

  it("rejects unknown actors, target roles and new roles", () => {
    expect(codes({ actorRole: "root", targetRole: "member", newRole: "guest" })).toContain(
      "unknown_actor",
    );
    expect(
      codes({ actorRole: "owner", targetRole: "root", newRole: "guest", members: [{ role: "owner" }] }),
    ).toContain("unknown_target_role");
    expect(codes({ actorRole: "owner", targetRole: "member", newRole: "root" })).toContain(
      "unknown_new_role",
    );
  });

  it("keeps ok true exactly when no errors were collected", () => {
    const results = [
      validateRoleChange({ actorRole: "owner", targetRole: "member", newRole: "guest" }),
      validateRoleChange({ actorRole: "member", targetRole: "member", newRole: "guest" }),
      validateRoleChange({ actorRole: "admin", targetRole: "member", newRole: "admin" }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(result.errors.length === 0);
    }
  });
});

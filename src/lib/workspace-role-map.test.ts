import { describe, expect, it } from "vitest";
import {
  MEMBERS_ACTIONS,
  PERSISTED_WORKSPACE_ROLES,
  canMembersAction,
  isPersistedWorkspaceRole,
  membersCapabilities,
  roleChangeMessage,
  toEngineRole,
  toPersistedRole,
  validatePersistedRoleChange,
} from "./workspace-role-map";
import type { PersistedWorkspaceRole } from "./workspace-role-map";
import { assignableRoles, capabilitiesFor } from "./workspace-roles";
import type { WorkspaceAction, WorkspaceRole } from "./workspace-roles";

/**
 * The persisted-enum ↔ engine-role mapping behind the members UI.
 *
 * Every assertion runs against the real `@/lib/workspace-roles` engine — the
 * mapping may translate inputs, but it never invents decisions.
 */

const PERSISTED: readonly PersistedWorkspaceRole[] = ["OWNER", "ADMIN", "MEMBER", "GUEST"];
const ENGINE: readonly WorkspaceRole[] = ["owner", "admin", "member", "guest"];

/** A roster that holds exactly one owner. */
const ONE_OWNER: readonly { role: string }[] = [
  { role: "OWNER" },
  { role: "ADMIN" },
  { role: "MEMBER" },
  { role: "GUEST" },
];

/** The error codes a persisted-role change produces. */
function codes(input: Parameters<typeof validatePersistedRoleChange>[0]): string[] {
  return validatePersistedRoleChange(input).errors.map((issue) => issue.code);
}

describe("PERSISTED_WORKSPACE_ROLES", () => {
  it("lists the four prisma enum values most privileged first", () => {
    expect(PERSISTED_WORKSPACE_ROLES).toEqual(["OWNER", "ADMIN", "MEMBER", "GUEST"]);
  });

  it("lists each value exactly once", () => {
    expect(new Set(PERSISTED_WORKSPACE_ROLES).size).toBe(PERSISTED_WORKSPACE_ROLES.length);
  });
});

describe("isPersistedWorkspaceRole", () => {
  it("accepts every enum value", () => {
    for (const role of PERSISTED) expect(isPersistedWorkspaceRole(role)).toBe(true);
  });

  it("rejects non-enum values", () => {
    for (const value of ["owner", "root", "", " ADMIN", null, undefined, 1, {}]) {
      expect(isPersistedWorkspaceRole(value)).toBe(false);
    }
  });
});

describe("toEngineRole", () => {
  it("maps each persisted role to its engine spelling", () => {
    expect(toEngineRole("OWNER")).toBe("owner");
    expect(toEngineRole("ADMIN")).toBe("admin");
    expect(toEngineRole("MEMBER")).toBe("member");
    expect(toEngineRole("GUEST")).toBe("guest");
  });

  it("fails closed to null for anything unknown", () => {
    for (const value of ["owner", "root", "", null, undefined, 3, ["ADMIN"]]) {
      expect(toEngineRole(value)).toBeNull();
    }
  });
});

describe("toPersistedRole", () => {
  it("maps engine spellings and enum values (trimmed, case-insensitive)", () => {
    expect(toPersistedRole("owner")).toBe("OWNER");
    expect(toPersistedRole(" ADMIN ")).toBe("ADMIN");
    expect(toPersistedRole("member")).toBe("MEMBER");
    expect(toPersistedRole("GUEST")).toBe("GUEST");
  });

  it("fails closed to null for anything unknown", () => {
    for (const value of ["root", "", "   ", null, undefined, 7, {}]) {
      expect(toPersistedRole(value)).toBeNull();
    }
  });

  it("round-trips every persisted role", () => {
    for (const role of PERSISTED) expect(toPersistedRole(toEngineRole(role))).toBe(role);
  });
});

describe("membersCapabilities", () => {
  it("grants the owner every member power and every assignable role", () => {
    const caps = membersCapabilities("OWNER");
    expect(caps.role).toBe("owner");
    expect(caps.persistedRole).toBe("OWNER");
    expect(caps.actions).toEqual(capabilitiesFor("owner"));
    expect(caps.canInvite).toBe(true);
    expect(caps.canRemove).toBe(true);
    expect(caps.canChangeRole).toBe(true);
    expect(caps.canTransferOwnership).toBe(true);
    expect(caps.canManageMembers).toBe(true);
    expect(caps.assignable).toEqual(["ADMIN", "MEMBER", "GUEST"]);
  });

  it("lets an admin manage members but never transfer ownership or grant admin", () => {
    const caps = membersCapabilities("ADMIN");
    expect(caps.actions).toEqual(capabilitiesFor("admin"));
    expect(caps.canInvite).toBe(true);
    expect(caps.canRemove).toBe(true);
    expect(caps.canChangeRole).toBe(true);
    expect(caps.canTransferOwnership).toBe(false);
    expect(caps.canManageMembers).toBe(true);
    expect(caps.assignable).toEqual(["MEMBER", "GUEST"]);
  });

  it.each(["MEMBER", "GUEST"] as const)("gives %s no member powers", (role) => {
    const caps = membersCapabilities(role);
    expect(caps.actions).toEqual(capabilitiesFor(role.toLowerCase() as WorkspaceRole));
    expect(caps.canInvite).toBe(false);
    expect(caps.canRemove).toBe(false);
    expect(caps.canChangeRole).toBe(false);
    expect(caps.canTransferOwnership).toBe(false);
    expect(caps.canManageMembers).toBe(false);
    expect(caps.assignable).toEqual([]);
  });

  it("fails closed for an unknown persisted role", () => {
    const caps = membersCapabilities("SUPERUSER");
    expect(caps.role).toBeNull();
    expect(caps.persistedRole).toBeNull();
    expect(caps.actions).toEqual([]);
    expect(caps.canManageMembers).toBe(false);
    expect(caps.assignable).toEqual([]);
  });

  it("agrees with the engine's assignableRoles for every role", () => {
    for (const role of PERSISTED) {
      const engine = toEngineRole(role) as WorkspaceRole;
      const expected = assignableRoles(engine).map((granted) =>
        granted.toUpperCase(),
      ) as PersistedWorkspaceRole[];
      expect(membersCapabilities(role).assignable).toEqual(expected);
    }
  });
});

describe("canMembersAction", () => {
  it("exposes exactly the four members actions", () => {
    expect(MEMBERS_ACTIONS).toEqual([
      "inviteMember",
      "removeMember",
      "changeRole",
      "transferOwnership",
    ]);
  });

  it("gates each action from the engine matrix", () => {
    expect(canMembersAction("OWNER", "transferOwnership")).toBe(true);
    expect(canMembersAction("ADMIN", "transferOwnership")).toBe(false);
    expect(canMembersAction("ADMIN", "changeRole")).toBe(true);
    expect(canMembersAction("MEMBER", "inviteMember")).toBe(false);
    expect(canMembersAction("GUEST", "removeMember")).toBe(false);
    expect(canMembersAction("nope", "changeRole")).toBe(false);
  });
});

describe("validatePersistedRoleChange", () => {
  it("lets the owner grant admin, member and guest", () => {
    for (const newRole of ["ADMIN", "MEMBER", "GUEST"] as const) {
      const result = validatePersistedRoleChange({
        actorRole: "OWNER",
        targetRole: "MEMBER",
        newRole,
        members: ONE_OWNER,
      });
      expect(result).toEqual({ ok: true, errors: [] });
    }
  });

  it("lets an admin grant member and guest", () => {
    for (const newRole of ["MEMBER", "GUEST"] as const) {
      expect(
        validatePersistedRoleChange({
          actorRole: "ADMIN",
          targetRole: "GUEST",
          newRole,
          members: ONE_OWNER,
        }).ok,
      ).toBe(true);
    }
  });

  it("refuses an admin promoting anyone to admin (peer escalation)", () => {
    expect(
      codes({ actorRole: "ADMIN", targetRole: "MEMBER", newRole: "ADMIN", members: ONE_OWNER }),
    ).toEqual(["role_not_assignable"]);
  });

  it("refuses demoting the last owner", () => {
    expect(
      codes({ actorRole: "OWNER", targetRole: "OWNER", newRole: "MEMBER", members: ONE_OWNER }),
    ).toEqual(["last_owner"]);
  });

  it("refuses an owner demoting themselves", () => {
    expect(
      codes({
        actorRole: "OWNER",
        targetRole: "OWNER",
        newRole: "ADMIN",
        members: ONE_OWNER,
        self: true,
      }),
    ).toEqual(["last_owner", "self_demotion"]);
  });

  it("accepts a no-op change", () => {
    expect(
      validatePersistedRoleChange({
        actorRole: "ADMIN",
        targetRole: "MEMBER",
        newRole: "MEMBER",
        members: ONE_OWNER,
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("fails closed on unknown roles", () => {
    expect(codes({ actorRole: "ROOT", targetRole: "MEMBER", newRole: "GUEST" })).toEqual([
      "unknown_actor",
    ]);
    expect(codes({ actorRole: "OWNER", targetRole: "MEMBER", newRole: "BOGUS" })).toEqual([
      "unknown_new_role",
    ]);
    expect(codes({ actorRole: "OWNER", targetRole: "GHOST", newRole: "MEMBER" })).toEqual([
      "unknown_target_role",
    ]);
  });

  it("treats an omitted roster as a single owner (fail closed)", () => {
    expect(
      codes({ actorRole: "OWNER", targetRole: "OWNER", newRole: "MEMBER" }),
    ).toContain("last_owner");
  });
});

describe("roleChangeMessage", () => {
  it("returns a non-empty message for every stable engine code", () => {
    const cases = [
      ["unknown_actor"],
      ["unknown_target_role"],
      ["unknown_new_role"],
      ["actor_cannot_change_roles"],
      ["role_not_assignable"],
      ["last_owner"],
      ["self_demotion"],
    ] as const;
    for (const [code] of cases) {
      const message = roleChangeMessage([{ code, message: "" }]);
      expect(typeof message).toBe("string");
      expect(message.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses the first issue and hides the raw engine text", () => {
    const message = roleChangeMessage([
      { code: "last_owner", message: "the workspace must keep at least one owner" },
      { code: "self_demotion", message: "an owner cannot demote themselves; transfer ownership instead" },
    ]);
    expect(message).toBe("Transfer ownership before changing the owner's role.");
  });

  it("falls back for an empty issue list", () => {
    expect(roleChangeMessage([])).toBe("That change is not allowed.");
  });
});

describe("mapping consistency", () => {
  it("keeps every engine action reachable after translation", () => {
    for (const role of PERSISTED) {
      const caps = membersCapabilities(role);
      const expected: WorkspaceAction[] = capabilitiesFor(toEngineRole(role) as WorkspaceRole);
      expect(caps.actions).toEqual(expected);
      // `canManageMembers` folds three actions; it must be true exactly when the
      // engine grants at least one of them.
      const granted = MEMBERS_ACTIONS.some((action) =>
        canMembersAction(role, action),
      );
      expect(caps.canManageMembers).toBe(
        canMembersAction(role, "inviteMember") ||
          canMembersAction(role, "removeMember") ||
          canMembersAction(role, "changeRole"),
      );
      expect(granted).toBe(caps.canManageMembers || caps.canTransferOwnership);
    }
  });

  it("keeps engine and persisted role lists aligned", () => {
    expect(PERSISTED.map((role) => toEngineRole(role))).toEqual([...ENGINE]);
    expect(ENGINE.map((role) => toPersistedRole(role))).toEqual([...PERSISTED]);
  });
});

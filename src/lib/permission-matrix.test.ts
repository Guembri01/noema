import { describe, expect, it } from "vitest";
import {
  ACTION_ORDER,
  ROLE_HIERARCHY,
  allowedActions,
  can,
  describeRole,
} from "./permission-matrix";
import type { PermissionAction, PermissionRole } from "./permission-matrix";

/**
 * Workspace permission matrix — role → action grants for a workspace.
 *
 * Red-first: `src/lib/permission-matrix.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 *
 * This is the pure decision table: the four workspace roles (`owner`, `admin`,
 * `member`, `guest`) against the seven workspace-scoped actions, with the
 * inheritance chain `owner ⊃ admin ⊃ member ⊃ guest`. Everything is a
 * synchronous, side-effect-free lookup — no DB, routes, React or clock — and
 * every unknown role or action fails closed (deny), never throws.
 */

const ROLES: readonly PermissionRole[] = ["owner", "admin", "member", "guest"];
const ACTIONS: readonly PermissionAction[] = [
  "read",
  "comment",
  "edit",
  "share",
  "manageMembers",
  "manageBilling",
  "deleteWorkspace",
];

describe("ROLE_HIERARCHY", () => {
  it("orders roles owner > admin > member > guest", () => {
    expect(ROLE_HIERARCHY).toEqual(["owner", "admin", "member", "guest"]);
  });

  it("lists each role exactly once", () => {
    expect(new Set(ROLE_HIERARCHY).size).toBe(ROLE_HIERARCHY.length);
  });

  it("ranks owner above admin above member above guest", () => {
    expect(ROLE_HIERARCHY.indexOf("owner")).toBeLessThan(ROLE_HIERARCHY.indexOf("admin"));
    expect(ROLE_HIERARCHY.indexOf("admin")).toBeLessThan(ROLE_HIERARCHY.indexOf("member"));
    expect(ROLE_HIERARCHY.indexOf("member")).toBeLessThan(ROLE_HIERARCHY.indexOf("guest"));
  });
});

describe("ACTION_ORDER", () => {
  it("declares every action once in the documented order", () => {
    expect(ACTION_ORDER).toEqual(ACTIONS);
    expect(new Set(ACTION_ORDER).size).toBe(ACTION_ORDER.length);
  });
});

describe("can", () => {
  it("lets the owner perform every action", () => {
    for (const action of ACTIONS) expect(can("owner", action)).toBe(true);
  });

  it("lets an admin manage members and billing but not delete the workspace", () => {
    expect(can("admin", "manageMembers")).toBe(true);
    expect(can("admin", "manageBilling")).toBe(true);
    expect(can("admin", "deleteWorkspace")).toBe(false);
  });

  it("lets a member edit and share but not manage members, billing or delete", () => {
    expect(can("member", "edit")).toBe(true);
    expect(can("member", "share")).toBe(true);
    expect(can("member", "manageMembers")).toBe(false);
    expect(can("member", "manageBilling")).toBe(false);
    expect(can("member", "deleteWorkspace")).toBe(false);
  });

  it("restricts a guest to read and comment", () => {
    expect(can("guest", "read")).toBe(true);
    expect(can("guest", "comment")).toBe(true);
    expect(can("guest", "edit")).toBe(false);
    expect(can("guest", "share")).toBe(false);
    expect(can("guest", "deleteWorkspace")).toBe(false);
  });

  it("inherits: every lower role only grants a subset of the role above it", () => {
    for (let i = 1; i < ROLES.length; i += 1) {
      const higher = allowedActions(ROLES[i - 1]);
      for (const action of allowedActions(ROLES[i])) expect(higher).toContain(action);
    }
  });

  it("fails closed for unknown, forged or missing roles", () => {
    for (const role of ["root", "OWNER", "", " owner", null, undefined, 42]) {
      expect(can(role, "read")).toBe(false);
    }
  });

  it("fails closed for unknown, forged or missing actions", () => {
    for (const action of ["launchMissiles", "", "Read", null, undefined, 7]) {
      expect(can("owner", action)).toBe(false);
    }
  });
});

describe("allowedActions", () => {
  it("returns every action for the owner, in declared order", () => {
    expect(allowedActions("owner")).toEqual([...ACTION_ORDER]);
  });

  it("returns the admin, member and guest sets in declared order", () => {
    expect(allowedActions("admin")).toEqual([
      "read",
      "comment",
      "edit",
      "share",
      "manageMembers",
      "manageBilling",
    ]);
    expect(allowedActions("member")).toEqual(["read", "comment", "edit", "share"]);
    expect(allowedActions("guest")).toEqual(["read", "comment"]);
  });

  it("fails closed to an empty list for unknown roles", () => {
    for (const role of ["owner ", "superadmin", null, undefined, 0]) {
      expect(allowedActions(role)).toEqual([]);
    }
  });

  it("returns a fresh array callers can mutate without corrupting the matrix", () => {
    const first = allowedActions("member");
    first.push("deleteWorkspace");
    expect(allowedActions("member")).toEqual(["read", "comment", "edit", "share"]);
  });
});

describe("describeRole", () => {
  it("gives every known role a distinct, non-empty label", () => {
    const labels = ROLES.map((role) => describeRole(role));
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("fails closed to a neutral label for unknown roles", () => {
    for (const role of ["root", "", null, undefined, 3]) {
      expect(describeRole(role)).toBe("Unknown role");
    }
  });
});

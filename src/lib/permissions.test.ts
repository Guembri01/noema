import { describe, expect, it } from "vitest";
import { WorkspaceRole } from "@prisma/client";
import {
  canDeleteWorkspace,
  canEditContent,
  canManageMembers,
  canPerformWorkspaceAction,
  type WorkspaceAction,
} from "./permissions";

/**
 * B19 red-first authorization matrix.
 *
 * The rule under test is fail-closed: only roles explicitly granted an action
 * may perform it. A member must be denied every owner action, a guest must be
 * denied every workspace action, and revoked access (no membership at all)
 * must be denied everything.
 */

const ALL_ACTIONS: WorkspaceAction[] = [
  "viewMemberDirectory",
  "manageMembers",
  "manageSettings",
  "editContent",
  "sharePage",
  "deleteWorkspace",
  "transferOwnership",
];

const role = (value: string) => value as WorkspaceRole;

describe("canPerformWorkspaceAction — member denied owner actions", () => {
  it("denies a member the owner-only actions", () => {
    expect(canPerformWorkspaceAction("MEMBER", "deleteWorkspace")).toBe(false);
    expect(canPerformWorkspaceAction("MEMBER", "transferOwnership")).toBe(false);
  });

  it("denies a member every admin action", () => {
    expect(canPerformWorkspaceAction("MEMBER", "manageMembers")).toBe(false);
    expect(canPerformWorkspaceAction("MEMBER", "manageSettings")).toBe(false);
  });

  it("denies an admin the owner-only actions (transfer and delete stay owner-only)", () => {
    expect(canPerformWorkspaceAction("ADMIN", "transferOwnership")).toBe(false);
    expect(canPerformWorkspaceAction("ADMIN", "deleteWorkspace")).toBe(false);
  });
});

describe("canPerformWorkspaceAction — guest denied workspace actions", () => {
  it("denies a guest every workspace-level action", () => {
    expect(canPerformWorkspaceAction("GUEST", "manageMembers")).toBe(false);
    expect(canPerformWorkspaceAction("GUEST", "manageSettings")).toBe(false);
    expect(canPerformWorkspaceAction("GUEST", "viewMemberDirectory")).toBe(false);
    expect(canPerformWorkspaceAction("GUEST", "deleteWorkspace")).toBe(false);
    expect(canPerformWorkspaceAction("GUEST", "transferOwnership")).toBe(false);
  });

  it("denies a guest content and sharing actions (external collaborators are read-only)", () => {
    expect(canPerformWorkspaceAction("GUEST", "editContent")).toBe(false);
    expect(canPerformWorkspaceAction("GUEST", "sharePage")).toBe(false);
  });
});

describe("canPerformWorkspaceAction — revoked access denied", () => {
  it("denies every action when there is no membership", () => {
    for (const action of ALL_ACTIONS) {
      expect(canPerformWorkspaceAction(null, action)).toBe(false);
      expect(canPerformWorkspaceAction(undefined, action)).toBe(false);
    }
  });
});

describe("canPerformWorkspaceAction — fail closed", () => {
  it("denies an unknown or forged role", () => {
    const forged = role("SUPERADMIN");
    for (const action of ALL_ACTIONS) {
      expect(canPerformWorkspaceAction(forged, action)).toBe(false);
    }
    expect(canPerformWorkspaceAction(role(""), "editContent")).toBe(false);
  });

  it("denies an unknown action even for the owner", () => {
    expect(canPerformWorkspaceAction("OWNER", role("nukeEverything") as unknown as WorkspaceAction)).toBe(
      false,
    );
  });
});

describe("canPerformWorkspaceAction — granted paths", () => {
  it("grants the owner every workspace action", () => {
    for (const action of ALL_ACTIONS) {
      expect(canPerformWorkspaceAction("OWNER", action)).toBe(true);
    }
  });

  it("grants an admin member management and settings but never ownership actions", () => {
    expect(canPerformWorkspaceAction("ADMIN", "manageMembers")).toBe(true);
    expect(canPerformWorkspaceAction("ADMIN", "manageSettings")).toBe(true);
    expect(canPerformWorkspaceAction("ADMIN", "viewMemberDirectory")).toBe(true);
    expect(canPerformWorkspaceAction("ADMIN", "editContent")).toBe(true);
    expect(canPerformWorkspaceAction("ADMIN", "sharePage")).toBe(true);
  });

  it("grants a member content, sharing and the member directory — nothing more", () => {
    expect(canPerformWorkspaceAction("MEMBER", "editContent")).toBe(true);
    expect(canPerformWorkspaceAction("MEMBER", "sharePage")).toBe(true);
    expect(canPerformWorkspaceAction("MEMBER", "viewMemberDirectory")).toBe(true);
    expect(ALL_ACTIONS.filter((action) => canPerformWorkspaceAction("MEMBER", action))).toEqual([
      "viewMemberDirectory",
      "editContent",
      "sharePage",
    ]);
  });
});

describe("legacy helpers stay consistent with the matrix", () => {
  it("canEditContent agrees with the editContent action", () => {
    for (const value of ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const) {
      expect(canEditContent(value)).toBe(canPerformWorkspaceAction(value, "editContent"));
    }
  });

  it("canManageMembers agrees with the manageMembers action", () => {
    for (const value of ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const) {
      expect(canManageMembers(value)).toBe(canPerformWorkspaceAction(value, "manageMembers"));
    }
  });

  it("canDeleteWorkspace agrees with the deleteWorkspace action", () => {
    for (const value of ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const) {
      expect(canDeleteWorkspace(value)).toBe(canPerformWorkspaceAction(value, "deleteWorkspace"));
    }
  });
});

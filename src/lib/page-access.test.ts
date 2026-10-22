import { describe, expect, it } from "vitest";
import { WorkspaceRole } from "@prisma/client";
import {
  ASSIGNABLE_GUEST_LEVELS,
  ASSIGNABLE_PAGE_LEVELS,
  pageCapabilities,
  pageCapabilitiesFromRelation,
  pagePermissionLevel,
} from "./page-access";

/**
 * The page-level access matrix. The rule is a restriction, never a grant:
 * owner/admin stay immune, a member without a row keeps the role's access, a
 * READ row only allows reading, COMMENT adds comments, and a guest never gets
 * an edit right (guest editing is not implemented).
 */
describe("pageCapabilities", () => {
  it("keeps owner and admin immune from page restrictions", () => {
    for (const role of [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) {
      expect(pageCapabilities(role, "READ")).toEqual({
        read: true,
        comment: true,
        edit: true,
        share: true,
      });
    }
  });

  it("leaves an unrestricted member with full page access", () => {
    expect(pageCapabilities("MEMBER", null)).toEqual({
      read: true,
      comment: true,
      edit: true,
      share: true,
    });
  });

  it("turns a member READ row into read-only access", () => {
    expect(pageCapabilities("MEMBER", "READ")).toEqual({
      read: true,
      comment: false,
      edit: false,
      share: false,
    });
  });

  it("lets a member COMMENT row comment but not edit or share", () => {
    expect(pageCapabilities("MEMBER", "COMMENT")).toEqual({
      read: true,
      comment: true,
      edit: false,
      share: false,
    });
  });

  it.each(["EDIT", "FULL"] as const)("keeps member %s access", (level) => {
    expect(pageCapabilities("MEMBER", level)).toEqual({
      read: true,
      comment: true,
      edit: true,
      share: true,
    });
  });

  it("never gives a guest edit rights, even on a legacy EDIT/FULL row", () => {
    for (const level of ["EDIT", "FULL"] as const) {
      expect(pageCapabilities("GUEST", level)).toEqual({
        read: true,
        comment: true,
        edit: false,
        share: false,
      });
    }
  });

  it("lets a guest with a READ row read but not comment", () => {
    expect(pageCapabilities("GUEST", "READ")).toEqual({
      read: true,
      comment: false,
      edit: false,
      share: false,
    });
  });

  it("denies an unknown or missing role", () => {
    expect(pageCapabilities(null, "FULL").edit).toBe(false);
    expect(pageCapabilities("SOMETHING" as WorkspaceRole, "FULL").read).toBe(false);
  });

  it("reads the first explicit relation row", () => {
    expect(pagePermissionLevel([{ level: "COMMENT" }])).toBe("COMMENT");
    expect(pagePermissionLevel([])).toBeNull();
    expect(pagePermissionLevel(undefined)).toBeNull();
  });

  it("computes capabilities from a Prisma relation select", () => {
    expect(pageCapabilitiesFromRelation("MEMBER", [{ level: "READ" }]).edit).toBe(false);
    expect(pageCapabilitiesFromRelation("ADMIN", [{ level: "READ" }]).edit).toBe(true);
  });

  it("does not assign guest editing levels", () => {
    expect(ASSIGNABLE_GUEST_LEVELS).toEqual(["READ", "COMMENT"]);
    expect(ASSIGNABLE_PAGE_LEVELS).toContain("EDIT");
  });
});

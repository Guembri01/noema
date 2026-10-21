import { describe, expect, it } from "vitest";
import { assignableInviteRoleOptions } from "./email-settings";

/**
 * B15 (round 2) — the settings invitation picker must not offer a role the
 * server would refuse. The role matrix is the same one the members screen and
 * the server action use; the design-system Select renders the filtered list.
 */
describe("the settings invitation picker", () => {
  it("offers an admin only the roles an admin may grant", () => {
    expect(assignableInviteRoleOptions("en", "ADMIN").map((option) => option.value)).toEqual([
      "GUEST",
      "MEMBER",
    ]);
  });

  it("still offers the owner every role", () => {
    expect(assignableInviteRoleOptions("en", "OWNER").map((option) => option.value)).toEqual([
      "GUEST",
      "MEMBER",
      "ADMIN",
    ]);
  });

  it("fails closed for an unknown role — no role is offered at all", () => {
    expect(assignableInviteRoleOptions("en", "SUPERUSER")).toEqual([]);
  });
});

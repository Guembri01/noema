import { describe, expect, it } from "vitest";
import { parseScimGroup, parseScimGroupPatch, scimGroupResource } from "./groups";

describe("SCIM group helpers", () => {
  it("parses displayName and member ids", () => {
    expect(
      parseScimGroup({
        displayName: "Engineering",
        members: [{ value: "u1" }, { value: "u2" }],
      }),
    ).toEqual({ displayName: "Engineering", userIds: ["u1", "u2"] });
    expect(parseScimGroup({ name: "Design" })).toEqual({ displayName: "Design", userIds: [] });
    expect(parseScimGroup({})).toBeNull();
  });

  it("parses add/remove/replace operations and path filters", () => {
    expect(
      parseScimGroupPatch({
        Operations: [
          { op: "add", path: "members", value: [{ value: "u1" }] },
          { op: "remove", path: 'members[value eq "u2"]' },
          { op: "replace", path: "members", value: [] },
        ],
      }),
    ).toEqual([
      { op: "add", userIds: ["u1"] },
      { op: "remove", userIds: ["u2"] },
      { op: "replace", userIds: [] },
    ]);
    expect(parseScimGroupPatch({ Operations: [] })).toBeNull();
    expect(
      parseScimGroupPatch({ Operations: [{ op: "replace", path: "displayName", value: "X" }] }),
    ).toBeNull();
  });

  it("builds the group resource", () => {
    expect(
      scimGroupResource({ id: "g1", displayName: "Eng", members: [{ id: "u1", email: "a@b.com" }] }),
    ).toMatchObject({
      id: "g1",
      displayName: "Eng",
      members: [{ value: "u1", display: "a@b.com" }],
    });
  });
});

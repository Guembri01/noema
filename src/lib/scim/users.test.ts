import { describe, expect, it } from "vitest";
import {
  hashScimToken,
  parseScimPatch,
  parseScimUser,
  scimList,
  scimUserResource,
} from "./users";

describe("SCIM user helpers", () => {
  it("reads userName/emails/name and defaults active", () => {
    expect(
      parseScimUser({
        userName: " Alice@Example.com ",
        name: { givenName: "Alice", familyName: "Example" },
      }),
    ).toEqual({ email: "alice@example.com", name: "Alice Example", active: true });
    expect(
      parseScimUser({ emails: [{ value: "bob@example.com", primary: true }] }),
    ).toEqual({ email: "bob@example.com", name: "bob", active: true });
    expect(parseScimUser({ userName: "not-an-email" })).toBeNull();
    expect(parseScimUser(null)).toBeNull();
  });

  it("reads only the active attribute from PATCH operations", () => {
    expect(
      parseScimPatch({
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    ).toEqual({ active: false });
    expect(
      parseScimPatch({
        Operations: [{ op: "replace", path: "displayName", value: "X" }],
      }),
    ).toBeNull();
    expect(parseScimPatch({ Operations: [] })).toBeNull();
  });

  it("builds the SCIM resource and list envelope", () => {
    expect(
      scimUserResource({ id: "u1", email: "a@b.com", name: "A" }),
    ).toMatchObject({
      id: "u1",
      userName: "a@b.com",
      active: true,
      meta: { resourceType: "User" },
    });
    expect(scimList([{ id: "u1" }], 5, 1)).toMatchObject({
      totalResults: 5,
      startIndex: 1,
      itemsPerPage: 1,
    });
  });

  it("hashes a token deterministically and never returns the plaintext", async () => {
    const hash = await hashScimToken("a-valid-token-0123456789abcdef");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashScimToken("a-valid-token-0123456789abcdef")).toBe(hash);
    expect(hash).not.toContain("a-valid-token");
  });
});

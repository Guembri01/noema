import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B04 — the bearer token resolver must hand the granted scopes to the caller.
 *
 * `authenticateApiRequest` used to return only `{ userId }` and did not even
 * select the `scopes` column, so no REST route could enforce the grant the
 * settings UI stores. The resolver now returns the stored scope list together
 * with the user id, and reads the column in the same query that verifies the
 * token — so a route never has to re-resolve the token on its own.
 */

const db = vi.hoisted(() => ({
  apiTokenFindUnique: vi.fn(),
  apiTokenUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: db.apiTokenFindUnique, update: db.apiTokenUpdate },
  },
}));

import { apiTokenMatches, authenticateApiRequest, hashApiToken } from "./api-auth";

const TOKEN = "noema_api_auth_test_token";
const TOKEN_HASH = hashApiToken(TOKEN);

const bearer = (token: string | null = TOKEN) =>
  new Request("http://localhost/api/v1/pages", {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.apiTokenUpdate.mockResolvedValue({ id: "token-1" });
});

describe("apiTokenMatches", () => {
  it("refuses a digest that is not a string or is empty", () => {
    // A missing or malformed digest can never match — and the comparison must
    // not throw either: `Buffer.from` throws on a value that is not a string,
    // and a route that throws answers 500 instead of 401.
    expect(apiTokenMatches("noema_token", "")).toBe(false);
    expect(apiTokenMatches("noema_token", undefined as unknown as string)).toBe(false);
    expect(apiTokenMatches("noema_token", null as unknown as string)).toBe(false);
    expect(apiTokenMatches("noema_token", 42 as unknown as string)).toBe(false);
    // The well-formed digest still matches.
    expect(apiTokenMatches("noema_token", hashApiToken("noema_token"))).toBe(true);
  });
});

describe("authenticateApiRequest", () => {
  it("returns the user id and the granted scopes", async () => {
    db.apiTokenFindUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: TOKEN_HASH,
      scopes: ["read:pages", "write:pages"],
    });

    await expect(authenticateApiRequest(bearer())).resolves.toEqual({
      userId: "user-1",
      scopes: ["read:pages", "write:pages"],
    });
  });

  it("reads the scopes column in the token query", async () => {
    db.apiTokenFindUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: TOKEN_HASH,
      scopes: [],
    });

    await authenticateApiRequest(bearer());

    expect(db.apiTokenFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: TOKEN_HASH },
        select: expect.objectContaining({ scopes: true }),
      }),
    );
  });

  it("returns the empty grant for a scope-less token (the route decides)", async () => {
    db.apiTokenFindUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: TOKEN_HASH,
      scopes: [],
    });

    await expect(authenticateApiRequest(bearer())).resolves.toEqual({
      userId: "user-1",
      scopes: [],
    });
  });

  it("returns null without a bearer header", async () => {
    await expect(authenticateApiRequest(bearer(null))).resolves.toBeNull();
    expect(db.apiTokenFindUnique).not.toHaveBeenCalled();
  });

  it("returns null for an unknown token", async () => {
    db.apiTokenFindUnique.mockResolvedValue(null);

    await expect(authenticateApiRequest(bearer())).resolves.toBeNull();
  });

  it("returns null when the stored hash does not match the presented token", async () => {
    db.apiTokenFindUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      tokenHash: hashApiToken("noema_other_token"),
      scopes: ["read:pages"],
    });

    await expect(authenticateApiRequest(bearer())).resolves.toBeNull();
  });
});

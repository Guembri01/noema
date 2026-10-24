import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ authenticateScim: vi.fn() }));
const db = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  memberCreate: vi.fn(),
  memberDelete: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
}));

vi.mock("@/server/scim/auth", () => auth);
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: {
      findMany: db.memberFindMany,
      findUnique: db.memberFindUnique,
      create: db.memberCreate,
      delete: db.memberDelete,
    },
    user: { findUnique: db.userFindUnique, create: db.userCreate },
  },
}));

import { GET as listUsers, POST as createUser } from "./Users/route";
import { DELETE, GET as getUser, PATCH } from "./Users/[id]/route";

const CONTEXT = { connectionId: "conn-1", workspaceId: "ws-1" };
const USER = { id: "u1", email: "alice@example.com", name: "Alice" };

beforeEach(() => {
  vi.clearAllMocks();
  auth.authenticateScim.mockResolvedValue(CONTEXT);
  db.memberFindMany.mockResolvedValue([{ user: USER }]);
  db.memberFindUnique.mockResolvedValue({ role: "MEMBER", user: USER });
  db.memberCreate.mockResolvedValue({ id: "m1" });
  db.memberDelete.mockResolvedValue({ id: "m1" });
  db.userFindUnique.mockResolvedValue(null);
  db.userCreate.mockResolvedValue(USER);
});

function request(url: string, init?: RequestInit) {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: { authorization: "Bearer a-valid-token-0123456789abcdef", "content-type": "application/scim+json", ...init?.headers },
  });
}

describe("SCIM Users", () => {
  it("lists workspace members with SCIM pagination and refuses a missing token", async () => {
    const response = await listUsers(request("/api/scim/v2/Users?startIndex=1&count=50"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [{ userName: "alice@example.com", active: true }],
    });

    auth.authenticateScim.mockResolvedValue(null);
    const denied = await listUsers(request("/api/scim/v2/Users"));
    expect(denied.status).toBe(401);
  });

  it("creates a user + membership, and refuses a duplicate member", async () => {
    const response = await createUser(
      request("/api/scim/v2/Users", {
        method: "POST",
        body: JSON.stringify({
          userName: "new@example.com",
          name: { formatted: "New User" },
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(db.userCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "new@example.com",
        name: "New User",
        emailVerified: true,
        passwordHash: expect.stringMatching(/^sso:/),
      }),
      select: { id: true, email: true, name: true },
    });
    expect(db.memberCreate).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1", userId: "u1", role: "MEMBER" },
    });

    db.memberCreate.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));
    const duplicate = await createUser(
      request("/api/scim/v2/Users", {
        method: "POST",
        body: JSON.stringify({ userName: "alice@example.com" }),
      }),
    );
    expect(duplicate.status).toBe(409);
  });

  it("gets a user, deactivates a member and refuses to deactivate the owner", async () => {
    const get = await getUser(request("/api/scim/v2/Users/u1"), {
      params: Promise.resolve({ id: "u1" }),
    });
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ id: "u1", userName: USER.email });

    const patch = await PATCH(
      request("/api/scim/v2/Users/u1", {
        method: "PATCH",
        body: JSON.stringify({
          Operations: [{ op: "replace", path: "active", value: false }],
        }),
      }),
      { params: Promise.resolve({ id: "u1" }) },
    );
    expect(patch.status).toBe(204);
    expect(db.memberDelete).toHaveBeenCalled();

    db.memberFindUnique.mockResolvedValue({ role: "OWNER", user: USER });
    const owner = await DELETE(request("/api/scim/v2/Users/u1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "u1" }),
    });
    expect(owner.status).toBe(409);
  });

  it("rejects an unsupported PATCH and a missing member", async () => {
    const bad = await PATCH(
      request("/api/scim/v2/Users/u1", {
        method: "PATCH",
        body: JSON.stringify({ Operations: [{ op: "replace", path: "displayName", value: "X" }] }),
      }),
      { params: Promise.resolve({ id: "u1" }) },
    );
    expect(bad.status).toBe(400);

    db.memberFindUnique.mockResolvedValue(null);
    const missing = await getUser(request("/api/scim/v2/Users/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
  });
});

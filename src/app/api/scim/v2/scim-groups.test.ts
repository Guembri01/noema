import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ authenticateScim: vi.fn() }));
const db = vi.hoisted(() => ({
  teamspaceFindMany: vi.fn(),
  teamspaceFindFirst: vi.fn(),
  teamspaceCreate: vi.fn(),
  teamspaceDelete: vi.fn(),
  memberCreateMany: vi.fn(),
  memberDeleteMany: vi.fn(),
  workspaceMemberFindMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/server/scim/auth", () => auth);
vi.mock("@/lib/db", () => ({
  prisma: {
    teamspace: {
      findMany: db.teamspaceFindMany,
      findFirst: db.teamspaceFindFirst,
      create: db.teamspaceCreate,
      delete: db.teamspaceDelete,
    },
    teamspaceMember: {
      createMany: db.memberCreateMany,
      deleteMany: db.memberDeleteMany,
    },
    workspaceMember: { findMany: db.workspaceMemberFindMany },
    $transaction: db.transaction,
  },
}));

import { GET as listGroups, POST as createGroup } from "./Groups/route";
import { DELETE, GET as getGroup, PATCH } from "./Groups/[id]/route";

const CONTEXT = { connectionId: "conn-1", workspaceId: "ws-1" };
const GROUP = {
  id: "g1",
  name: "Engineering",
  members: [{ user: { id: "u1", email: "alice@example.com" } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.authenticateScim.mockResolvedValue(CONTEXT);
  db.teamspaceFindMany.mockResolvedValue([GROUP]);
  db.teamspaceFindFirst.mockResolvedValue(GROUP);
  db.teamspaceCreate.mockResolvedValue(GROUP);
  db.teamspaceDelete.mockResolvedValue({ id: "g1" });
  db.memberCreateMany.mockResolvedValue({ count: 1 });
  db.memberDeleteMany.mockResolvedValue({ count: 1 });
  db.workspaceMemberFindMany.mockResolvedValue([{ userId: "u1" }]);
  db.transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

function request(url: string, init?: RequestInit) {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      authorization: "Bearer a-valid-token-0123456789abcdef",
      "content-type": "application/scim+json",
      ...init?.headers,
    },
  });
}

describe("SCIM Groups", () => {
  it("lists teamspaces as groups and creates one", async () => {
    const list = await listGroups(request("/api/scim/v2/Groups"));
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      totalResults: 1,
      Resources: [{ displayName: "Engineering", members: [{ value: "u1" }] }],
    });

    const created = await createGroup(
      request("/api/scim/v2/Groups", {
        method: "POST",
        body: JSON.stringify({ displayName: "Design", members: [{ value: "u1" }] }),
      }),
    );
    expect(created.status).toBe(201);
    expect(db.teamspaceCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        name: "Design",
        members: { create: [{ userId: "u1", role: "MEMBER" }] },
      },
      select: expect.any(Object),
    });
  });

  it("gets a group and patches member add/remove/replace", async () => {
    const get = await getGroup(request("/api/scim/v2/Groups/g1"), {
      params: Promise.resolve({ id: "g1" }),
    });
    expect(get.status).toBe(200);

    const add = await PATCH(
      request("/api/scim/v2/Groups/g1", {
        method: "PATCH",
        body: JSON.stringify({ Operations: [{ op: "add", path: "members", value: [{ value: "u1" }] }] }),
      }),
      { params: Promise.resolve({ id: "g1" }) },
    );
    expect(add.status).toBe(204);
    expect(db.memberCreateMany).toHaveBeenCalledWith({
      data: [{ teamspaceId: "g1", userId: "u1", role: "MEMBER" }],
      skipDuplicates: true,
    });

    const replace = await PATCH(
      request("/api/scim/v2/Groups/g1", {
        method: "PATCH",
        body: JSON.stringify({ Operations: [{ op: "replace", path: "members", value: [] }] }),
      }),
      { params: Promise.resolve({ id: "g1" }) },
    );
    expect(replace.status).toBe(204);
    expect(db.transaction).toHaveBeenCalled();

    const remove = await PATCH(
      request("/api/scim/v2/Groups/g1", {
        method: "PATCH",
        body: JSON.stringify({ Operations: [{ op: "remove", path: 'members[value eq "u1"]' }] }),
      }),
      { params: Promise.resolve({ id: "g1" }) },
    );
    expect(remove.status).toBe(204);
    expect(db.memberDeleteMany).toHaveBeenCalledWith({
      where: { teamspaceId: "g1", userId: { in: ["u1"] } },
    });
  });

  it("rejects a foreign member and deletes an existing group", async () => {
    db.workspaceMemberFindMany.mockResolvedValue([]);
    const bad = await PATCH(
      request("/api/scim/v2/Groups/g1", {
        method: "PATCH",
        body: JSON.stringify({ Operations: [{ op: "add", path: "members", value: [{ value: "u2" }] }] }),
      }),
      { params: Promise.resolve({ id: "g1" }) },
    );
    expect(bad.status).toBe(400);

    const removed = await DELETE(request("/api/scim/v2/Groups/g1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "g1" }),
    });
    expect(removed.status).toBe(204);
    expect(db.teamspaceDelete).toHaveBeenCalledWith({ where: { id: "g1" } });
  });

  it("requires authentication", async () => {
    auth.authenticateScim.mockResolvedValue(null);
    const response = await listGroups(request("/api/scim/v2/Groups"));
    expect(response.status).toBe(401);
  });
});

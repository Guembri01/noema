import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  connectionFindFirst: vi.fn(),
  teamspaceFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
  memberUpdateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    ssoConnection: { findFirst: db.connectionFindFirst },
    teamspace: { findMany: db.teamspaceFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
    workspaceMember: { updateMany: db.memberUpdateMany },
  },
}));

import { syncScimGroupRoles } from "./roles";

beforeEach(() => {
  vi.clearAllMocks();
  db.connectionFindFirst.mockResolvedValue({
    roleRules: [{ group: "Engineering", role: "ADMIN" }],
  });
  db.teamspaceFindMany.mockResolvedValue([
    { id: "t1", name: "Engineering" },
    { id: "t2", name: "Ops" },
  ]);
  db.teamspaceMemberFindMany.mockResolvedValue([
    { userId: "u1", teamspaceId: "t1" },
    { userId: "u2", teamspaceId: "t2" },
  ]);
  db.memberUpdateMany.mockResolvedValue({ count: 1 });
});

describe("syncScimGroupRoles", () => {
  it("recomputes affected users from their teamspace groups", async () => {
    await syncScimGroupRoles("ws-1", "conn-1", ["u1", "u2", "u3"]);

    expect(db.memberUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "u1", role: { not: "OWNER" } },
      data: { role: "ADMIN" },
    });
    expect(db.memberUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "u2", role: { not: "OWNER" } },
      data: { role: "MEMBER" },
    });
    expect(db.memberUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "u3", role: { not: "OWNER" } },
      data: { role: "MEMBER" },
    });
  });

  it("does nothing without rules or users", async () => {
    db.connectionFindFirst.mockResolvedValue({ roleRules: null });
    await syncScimGroupRoles("ws-1", "conn-1", ["u1"]);
    expect(db.memberUpdateMany).not.toHaveBeenCalled();

    db.connectionFindFirst.mockClear();
    await syncScimGroupRoles("ws-1", "conn-1", []);
    expect(db.connectionFindFirst).not.toHaveBeenCalled();
  });
});

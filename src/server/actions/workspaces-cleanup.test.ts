import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D8 — removing or leaving a workspace must also tear down the member's
 * `TeamspaceMember` rows, not just `WorkspaceMember` and `PagePermission`.
 *
 * `guest-access` reads `teamspaceMember` to drive page visibility, so a stale
 * row keeps a removed/gone member reachable through the teamspace path.
 * Red-first: both actions previously left the rows behind (workspaces.ts
 * had no `prisma.teamspaceMember` site at all).
 */

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  memberDelete: vi.fn(),
  pagePermissionDeleteMany: vi.fn(),
  teamspaceMemberDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique },
    workspaceMember: {
      findUnique: db.memberFindUnique,
      findFirst: db.memberFindFirst,
      delete: db.memberDelete,
    },
    pagePermission: { deleteMany: db.pagePermissionDeleteMany },
    teamspaceMember: { deleteMany: db.teamspaceMemberDeleteMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { leaveWorkspaceAction, removeMemberAction } from "./workspaces";

describe("D8 — workspace teardown cleans TeamspaceMember rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removeMemberAction deletes the target's teamspace memberships", async () => {
    db.workspaceFindUnique.mockResolvedValueOnce({ ownerId: "owner-1" });
    db.memberFindUnique.mockResolvedValueOnce({ role: "ADMIN" });
    db.memberFindFirst.mockResolvedValueOnce({ id: "target-m", role: "MEMBER" });
    db.memberDelete.mockResolvedValueOnce({ id: "target-m" });

    const result = await removeMemberAction("ws-1", "target-user");

    expect(result).toEqual({ ok: true });
    expect(db.teamspaceMemberDeleteMany).toHaveBeenCalledWith({
      where: { userId: "target-user", teamspace: { workspaceId: "ws-1" } },
    });
  });

  it("leaveWorkspaceAction deletes the leaver's own teamspace memberships", async () => {
    db.workspaceFindUnique.mockResolvedValueOnce({ ownerId: "owner-1" });
    db.memberFindFirst.mockResolvedValueOnce({ id: "leaver-m", role: "MEMBER" });
    db.memberDelete.mockResolvedValueOnce({ id: "leaver-m" });

    const result = await leaveWorkspaceAction("ws-1");

    expect(result).toEqual({ ok: true });
    expect(db.teamspaceMemberDeleteMany).toHaveBeenCalledWith({
      where: { userId: "actor-1", teamspace: { workspaceId: "ws-1" } },
    });
  });
});

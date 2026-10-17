import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B37 — removing or leaving a workspace drops the subscriptions, too.
 *
 * The removal paths used to delete the `pagePermission` rows only: the
 * `PageFollow` and `Favorite` rows survived, so a person who was removed from a
 * workspace (or who left it) kept following its pages and kept being told
 * about their edits — the notice carries the page's title.
 *
 * Only the transport edges (prisma, auth, activity, cache) are mocked; the
 * cleanup itself is the action's own code.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  workspaceFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  memberDelete: vi.fn(),
  pagePermissionDeleteMany: vi.fn(),
  pageFollowDeleteMany: vi.fn(),
  favoriteDeleteMany: vi.fn(),
  teamspaceMemberDeleteMany: vi.fn(),
  projectMemberDeleteMany: vi.fn(),
  notificationDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: h.workspaceFindUnique },
    workspaceMember: {
      findFirst: h.memberFindFirst,
      delete: h.memberDelete,
    },
    pagePermission: { deleteMany: h.pagePermissionDeleteMany },
    pageFollow: { deleteMany: h.pageFollowDeleteMany },
    favorite: { deleteMany: h.favoriteDeleteMany },
    // The other membership rows the removal deletes as well (the findings
    // B115 and B116) — the mock has to offer them.
    teamspaceMember: { deleteMany: h.teamspaceMemberDeleteMany },
    projectMember: { deleteMany: h.projectMemberDeleteMany },
    notification: { deleteMany: h.notificationDeleteMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { leaveWorkspaceAction, removeMemberAction } from "./workspaces";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "actor-1" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "OWNER" });
  h.workspaceFindUnique.mockResolvedValue({ ownerId: "owner-1" });
  h.memberFindFirst.mockResolvedValue({ id: "m2", role: "MEMBER" });
});

describe("removeMemberAction — the subscriptions go with the membership", () => {
  it("drops the follow and the favorite rows of the removed member", async () => {
    const result = await removeMemberAction("ws-1", "user-2");

    expect(result).toEqual({ ok: true });
    expect(h.pageFollowDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-2", page: { workspaceId: "ws-1" } },
    });
    expect(h.favoriteDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-2", page: { workspaceId: "ws-1" } },
    });
  });

  it("drops the rows of that workspace only", async () => {
    await removeMemberAction("ws-1", "user-2");

    expect(h.pageFollowDeleteMany.mock.calls[0][0].where.page).toEqual({
      workspaceId: "ws-1",
    });
    expect(h.favoriteDeleteMany.mock.calls[0][0].where.page).toEqual({
      workspaceId: "ws-1",
    });
  });

  it("removes nobody when the actor may not manage members", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await removeMemberAction("ws-1", "user-2");

    expect(result).toEqual({
      error: "You do not have permission to remove members.",
    });
    expect(h.pageFollowDeleteMany).not.toHaveBeenCalled();
    expect(h.favoriteDeleteMany).not.toHaveBeenCalled();
  });
});

describe("leaveWorkspaceAction — the subscriptions go with the membership", () => {
  it("drops the follow and the favorite rows of the leaver", async () => {
    h.requireUser.mockResolvedValue({ id: "user-2" });

    const result = await leaveWorkspaceAction("ws-1");

    expect(result).toEqual({ ok: true });
    expect(h.pageFollowDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-2", page: { workspaceId: "ws-1" } },
    });
    expect(h.favoriteDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-2", page: { workspaceId: "ws-1" } },
    });
  });

  it("keeps the rows when the caller does not belong to the workspace", async () => {
    h.requireUser.mockResolvedValue({ id: "user-2" });
    h.memberFindFirst.mockResolvedValue(null);

    const result = await leaveWorkspaceAction("ws-1");

    expect(result).toEqual({
      error: "You are not a member of this workspace.",
    });
    expect(h.pageFollowDeleteMany).not.toHaveBeenCalled();
    expect(h.favoriteDeleteMany).not.toHaveBeenCalled();
  });
});

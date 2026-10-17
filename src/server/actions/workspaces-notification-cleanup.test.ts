import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B113 — the notification rows go with the membership.
 *
 * The `notification` rows were never deleted: the removal paths dropped the
 * `pagePermission` rows only, so a person who was removed from a workspace (or
 * who left it) kept their notification rows. `getNotifications(userId)`
 * (`src/server/queries.ts:1021`) filters by `userId` alone and the inbox loads
 * every workspace, so the inbox of the workspaces the person **stays** in went
 * on naming the pages and tickets of the workspace they were removed from —
 * the payload carries the workspace id and, for a ticket assignment, the title
 * (`You were assigned “Payroll restructure”`).
 *
 * These tests pin the cleanup: the removal deletes exactly the rows of that
 * member for that workspace, and the legitimate path (a member who stays) is
 * untouched. Only the transport edges (prisma, auth, activity, cache) are
 * mocked; the deletion is the action's own code.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceDelete: vi.fn(),
  memberFindFirst: vi.fn(),
  memberDelete: vi.fn(),
  pagePermissionDeleteMany: vi.fn(),
  notificationDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: {
      findUnique: h.workspaceFindUnique,
      delete: h.workspaceDelete,
    },
    workspaceMember: {
      findFirst: h.memberFindFirst,
      delete: h.memberDelete,
    },
    pagePermission: { deleteMany: h.pagePermissionDeleteMany },
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

import { deleteWorkspaceAction, leaveWorkspaceAction, removeMemberAction } from "./workspaces";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "actor-1" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "OWNER" });
  h.workspaceFindUnique.mockResolvedValue({ ownerId: "owner-1" });
  h.memberFindFirst.mockResolvedValue({ id: "m2", role: "MEMBER" });
});

describe("removeMemberAction — the notification rows go with the membership", () => {
  it("drops the notification rows of the removed member for that workspace", async () => {
    const result = await removeMemberAction("ws-1", "user-2");

    expect(result).toEqual({ ok: true });
    expect(h.notificationDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-2",
        payload: { path: ["workspaceId"], equals: "ws-1" },
      },
    });
  });

  it("drops the rows of that workspace only — the payload carries the workspace id", async () => {
    await removeMemberAction("ws-1", "user-2");

    const [args] = h.notificationDeleteMany.mock.calls[0] as [
      { where: { userId: string; payload: { path: string[]; equals: string } } },
    ];
    expect(args.where.userId).toBe("user-2");
    expect(args.where.payload).toEqual({
      path: ["workspaceId"],
      equals: "ws-1",
    });
  });

  it("removes nobody when the actor may not manage members", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await removeMemberAction("ws-1", "user-2");

    expect(result).toEqual({
      error: "You do not have permission to remove members.",
    });
    expect(h.notificationDeleteMany).not.toHaveBeenCalled();
  });

  it("keeps the rows when the person is not a member of the workspace", async () => {
    h.memberFindFirst.mockResolvedValue(null);

    const result = await removeMemberAction("ws-1", "user-2");

    expect(result).toEqual({
      error: "That person is not a member of this workspace.",
    });
    expect(h.notificationDeleteMany).not.toHaveBeenCalled();
  });
});

describe("leaveWorkspaceAction — the notification rows go with the membership", () => {
  it("drops the notification rows of the leaver for that workspace", async () => {
    h.requireUser.mockResolvedValue({ id: "user-2" });

    const result = await leaveWorkspaceAction("ws-1");

    expect(result).toEqual({ ok: true });
    expect(h.notificationDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-2",
        payload: { path: ["workspaceId"], equals: "ws-1" },
      },
    });
  });

  it("keeps the rows when the caller does not belong to the workspace", async () => {
    h.requireUser.mockResolvedValue({ id: "user-2" });
    h.memberFindFirst.mockResolvedValue(null);

    const result = await leaveWorkspaceAction("ws-1");

    expect(result).toEqual({
      error: "You are not a member of this workspace.",
    });
    expect(h.notificationDeleteMany).not.toHaveBeenCalled();
  });
});

describe("deleteWorkspaceAction — the notification rows go with the workspace", () => {
  it("drops the notification rows of the deleted workspace", async () => {
    h.workspaceFindUnique.mockResolvedValue({ name: "Acme" });

    const result = await deleteWorkspaceAction("ws-1", "Acme");

    expect(result).toEqual({ ok: true });
    expect(h.workspaceDelete).toHaveBeenCalledWith({ where: { id: "ws-1" } });
    // The whole workspace, not one member: every member loses the workspace.
    expect(h.notificationDeleteMany).toHaveBeenCalledWith({
      where: { payload: { path: ["workspaceId"], equals: "ws-1" } },
    });
  });

  it("keeps the rows when the confirmation does not match", async () => {
    h.workspaceFindUnique.mockResolvedValue({ name: "Acme" });

    const result = await deleteWorkspaceAction("ws-1", "Wrong");

    expect(result).toEqual({
      error: "The name you typed does not match this workspace.",
    });
    expect(h.notificationDeleteMany).not.toHaveBeenCalled();
  });
});

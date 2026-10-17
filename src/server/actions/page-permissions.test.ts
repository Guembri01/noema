import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B135 — the revocation of a page permission takes the follow row with it.
 *
 * A guest who follows a page gets a notification with the page's title
 * whenever the page changes. When the access to that page is taken away, the
 * follow row has to go with the permission — otherwise the title keeps
 * reaching the person whose access was revoked. The removal of the
 * *membership* deletes the follow rows for the same reason (B37); this is the
 * same revocation on a smaller scale.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  permissionDeleteMany: vi.fn(),
  followDeleteMany: vi.fn(),
  permissionUpsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    workspaceMember: { findFirst: db.memberFindFirst },
    pagePermission: { deleteMany: db.permissionDeleteMany, upsert: db.permissionUpsert },
    pageFollow: { deleteMany: db.followDeleteMany },
    $transaction: db.transaction,
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "owner-1" }),
}));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: async () => ({ role: "OWNER" }),
  canPerformWorkspaceAction: () => true,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setPagePermissionAction } from "./page-permissions";

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  db.memberFindFirst.mockResolvedValue({ userId: "guest-1" });
  db.permissionDeleteMany.mockResolvedValue({ count: 1 });
  db.followDeleteMany.mockResolvedValue({ count: 1 });
  db.permissionUpsert.mockResolvedValue({});
  // The transaction runs the operations it is given.
  db.transaction.mockImplementation(async (operations: unknown[]) => operations);
});

describe("setPagePermissionAction", () => {
  it("takes the follow row with the revoked permission (B135)", async () => {
    const result = await setPagePermissionAction("page-1", "guest-1", "NONE");

    expect(result).toEqual({ ok: true });
    expect(db.permissionDeleteMany).toHaveBeenCalledWith({
      where: { pageId: "page-1", userId: "guest-1" },
    });
    expect(db.followDeleteMany).toHaveBeenCalledWith({
      where: { pageId: "page-1", userId: "guest-1" },
    });
  });

  it("keeps the follow row when the permission is granted", async () => {
    const result = await setPagePermissionAction("page-1", "guest-1", "READ");

    expect(result).toEqual({ ok: true });
    expect(db.permissionUpsert).toHaveBeenCalled();
    expect(db.followDeleteMany).not.toHaveBeenCalled();
  });
});

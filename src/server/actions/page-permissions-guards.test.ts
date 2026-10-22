import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guard coverage for `setPagePermissionAction`: a member must not widen their
 * own page access, must not touch an owner/admin row, and must not assign a
 * guest an edit level the product does not implement.
 */
const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  permissionUpsert: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    workspaceMember: { findFirst: db.memberFindFirst },
    pagePermission: { upsert: db.permissionUpsert, deleteMany: vi.fn() },
    pageFollow: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (operations: unknown[]) => operations),
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "member-1" })),
}));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canPerformWorkspaceAction: vi.fn(() => true),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setPagePermissionAction } from "./page-permissions";

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue({ workspaceId: "ws-1", permissions: [] });
  db.memberFindFirst.mockResolvedValue({ userId: "member-2", role: "MEMBER" });
  db.permissionUpsert.mockResolvedValue({});
});

describe("setPagePermissionAction guards", () => {
  it("refuses a member changing their own page access", async () => {
    db.memberFindFirst.mockResolvedValue({ userId: "member-1", role: "MEMBER" });

    const result = await setPagePermissionAction("page-1", "member-1", "FULL");

    expect(result).toEqual({ error: "You cannot change your own page access." });
    expect(db.permissionUpsert).not.toHaveBeenCalled();
  });

  it("refuses a member touching an owner or admin row", async () => {
    db.memberFindFirst.mockResolvedValue({ userId: "owner-1", role: "OWNER" });

    const result = await setPagePermissionAction("page-1", "owner-1", "READ");

    expect(result).toEqual({
      error: "The workspace owner and admins always have full access.",
    });
    expect(db.permissionUpsert).not.toHaveBeenCalled();
  });

  it("refuses an EDIT/FULL guest level before writing it", async () => {
    db.memberFindFirst.mockResolvedValue({ userId: "guest-1", role: "GUEST" });

    const result = await setPagePermissionAction("page-1", "guest-1", "FULL");

    expect(result).toEqual({
      error: "Guests can only be given read or comment access.",
    });
    expect(db.permissionUpsert).not.toHaveBeenCalled();
  });

  it("allows a READ guest level", async () => {
    db.memberFindFirst.mockResolvedValue({ userId: "guest-1", role: "GUEST" });

    const result = await setPagePermissionAction("page-1", "guest-1", "READ");

    expect(result).toEqual({ ok: true });
    expect(db.permissionUpsert).toHaveBeenCalled();
  });

  it("refuses a member whose own page row is read-only", async () => {
    db.pageFindUnique.mockResolvedValue({
      workspaceId: "ws-1",
      permissions: [{ level: "READ" }],
    });

    const result = await setPagePermissionAction("page-1", "member-2", "FULL");

    expect(result).toEqual({
      error: "You do not have permission to change sharing on this page.",
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B19 — server-side guard pins for `transferOwnershipAction`.
 *
 * These exercise the REAL authorization chain (action → getWorkspaceAccess →
 * canPerformWorkspaceAction); only the transport edges (prisma, auth, cache)
 * are mocked. A member/admin/guest or a revoked user must never reach the
 * ownership transaction, and ownership never moves to a guest.
 */

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  memberUpdate: vi.fn(),
  memberUpdateMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: {
      findUnique: db.memberFindUnique,
      findFirst: db.memberFindFirst,
      update: db.memberUpdate,
      updateMany: db.memberUpdateMany,
    },
    workspace: {
      findUnique: db.workspaceFindUnique,
      update: vi.fn(),
    },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { logActivity } from "@/lib/activity";
import { transferOwnershipAction } from "./workspaces";

const DENIED = { error: "Only the current owner can transfer this workspace." };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transferOwnershipAction — role guards (real permission chain)", () => {
  it("denies a member", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });
    await expect(transferOwnershipAction("ws-1", "user-2")).resolves.toEqual(DENIED);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("denies an admin", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
    await expect(transferOwnershipAction("ws-1", "user-2")).resolves.toEqual(DENIED);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("denies a guest", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "GUEST" });
    await expect(transferOwnershipAction("ws-1", "user-2")).resolves.toEqual(DENIED);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("denies revoked access (no membership, not the owner)", async () => {
    db.memberFindUnique.mockResolvedValue(null);
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "someone-else" });
    await expect(transferOwnershipAction("ws-1", "user-2")).resolves.toEqual(DENIED);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses to hand ownership to a guest target", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
    db.memberFindFirst.mockResolvedValue({ id: "m2", role: "GUEST" });
    await expect(transferOwnershipAction("ws-1", "guest-2")).resolves.toEqual({
      error: "A guest cannot own this workspace — promote them to a member first.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("transferOwnershipAction — owner path", () => {
  it("transfers atomically and demotes the previous owner to ADMIN", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
    db.memberFindFirst.mockResolvedValue({ id: "m2", role: "MEMBER" });

    await expect(transferOwnershipAction("ws-1", "user-2")).resolves.toEqual({ ok: true });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.memberUpdate).toHaveBeenCalledWith({ where: { id: "m2" }, data: { role: "OWNER" } });
    expect(db.memberUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "actor-1" },
      data: { role: "ADMIN" },
    });
  });

  it("logs the transfer only after the transaction commits", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
    db.memberFindFirst.mockResolvedValue({ id: "m2", role: "MEMBER" });

    await transferOwnershipAction("ws-1", "user-2");

    const logged = vi.mocked(logActivity).mock.invocationCallOrder[0];
    const committed = db.transaction.mock.invocationCallOrder[0];
    expect(logged).toBeGreaterThan(committed);
  });
});

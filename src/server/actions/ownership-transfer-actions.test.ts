import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workspace ownership transfer actions — the server side of the two-party flow
 * in `@/lib/ownership-transfer`. The real state machine runs (start → accept /
 * decline / cancel, lazy expiry); only the transport edges are mocked. Pins the
 * recipient-only accept, the atomic swap and lazy expiry.
 */

const auth = vi.hoisted(() => ({ user: { id: "actor-1" } }));

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  memberUpdate: vi.fn(),
  memberUpdateMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceUpdate: vi.fn(),
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
    workspace: { findUnique: db.workspaceFindUnique, update: db.workspaceUpdate },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => auth.user) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  acceptOwnershipTransferAction,
  cancelOwnershipTransferAction,
  declineOwnershipTransferAction,
  listOwnershipTransfersAction,
  startOwnershipTransferAction,
} from "./workspaces";

/** The workspace row `startTransfer` reads (owner + guest-safe member). */
function workspaceWithMembers(id: string) {
  return {
    id,
    members: [
      { userId: "actor-1", role: "OWNER" },
      { userId: "user-2", role: "MEMBER" },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  auth.user = { id: "actor-1" };
  vi.clearAllMocks();
  db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
  db.workspaceFindUnique.mockImplementation(
    async (args: { where: { id: string }; select?: { members?: unknown } }) =>
      args?.select?.members ? workspaceWithMembers(args.where.id) : { ownerId: "actor-1" },
  );
  db.memberFindFirst.mockResolvedValue({ id: "m2", role: "MEMBER" });
  db.transaction.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startOwnershipTransferAction", () => {
  it("opens one transfer and refuses a second while one is pending", async () => {
    auth.user = { id: "actor-1" };
    const first = await startOwnershipTransferAction({ workspaceId: "ws-1", toUserId: "user-2" });
    expect(first).toMatchObject({ ok: true });

    const second = await startOwnershipTransferAction({ workspaceId: "ws-1", toUserId: "user-2" });
    expect(second).toEqual({ error: "This workspace already has a pending ownership transfer." });
  });

  it("refuses a guest target", async () => {
    db.workspaceFindUnique.mockResolvedValue({
      id: "ws-guest",
      members: [
        { userId: "actor-1", role: "OWNER" },
        { userId: "guest-2", role: "GUEST" },
      ],
    });
    await expect(
      startOwnershipTransferAction({ workspaceId: "ws-guest", toUserId: "guest-2" }),
    ).resolves.toEqual({
      error: "A guest cannot own this workspace — promote them to a member first.",
    });
  });
});

describe("acceptOwnershipTransferAction", () => {
  it("lets only the recipient accept, then swaps ownership atomically", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({ workspaceId: "ws-accept", toUserId: "user-2" });
    if (!("ok" in started)) throw new Error(started.error);

    // The sender is not the recipient.
    await expect(acceptOwnershipTransferAction(started.id)).resolves.toEqual({
      error: "Only the intended recipient can accept this transfer.",
    });
    expect(db.transaction).not.toHaveBeenCalled();

    auth.user = { id: "user-2" };
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "actor-1" });
    await expect(acceptOwnershipTransferAction(started.id)).resolves.toEqual({ ok: true });
    expect(db.memberUpdate).toHaveBeenCalledWith({ where: { id: "m2" }, data: { role: "OWNER" } });
    expect(db.memberUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-accept", userId: "actor-1" },
      data: { role: "ADMIN" },
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("decline / cancel", () => {
  it("lets the recipient decline", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({ workspaceId: "ws-decline", toUserId: "user-2" });
    if (!("ok" in started)) throw new Error(started.error);

    auth.user = { id: "user-2" };
    await expect(declineOwnershipTransferAction(started.id)).resolves.toEqual({ ok: true });
    await expect(listOwnershipTransfersAction("ws-decline")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("lets the sender cancel", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({ workspaceId: "ws-cancel", toUserId: "user-2" });
    if (!("ok" in started)) throw new Error(started.error);

    await expect(cancelOwnershipTransferAction(started.id)).resolves.toEqual({ ok: true });
    const list = await listOwnershipTransfersAction("ws-cancel");
    if (!("ok" in list)) throw new Error(list.error);
    expect(list.transfers.find((row) => row.id === started.id)?.status).toBe("cancelled");
  });
});

describe("lazy expiry", () => {
  it("lapses a request at its boundary and refuses a late accept", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({
      workspaceId: "ws-exp",
      toUserId: "user-2",
      ttlMs: 1000,
    });
    if (!("ok" in started)) throw new Error(started.error);

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
    const list = await listOwnershipTransfersAction("ws-exp");
    if (!("ok" in list)) throw new Error(list.error);
    const row = list.transfers.find((entry) => entry.id === started.id);
    expect(row?.status).toBe("expired");
    expect(row?.pending).toBe(false);

    auth.user = { id: "user-2" };
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "actor-1" });
    await expect(acceptOwnershipTransferAction(started.id)).resolves.toEqual({
      error: "This transfer request has expired.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

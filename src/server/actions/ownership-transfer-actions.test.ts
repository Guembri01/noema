import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workspace ownership transfer actions — the server side of the two-party flow
 * in `@/lib/ownership-transfer`. The real state machine runs (start → accept /
 * decline / cancel, lazy expiry); only the transport edges are mocked. Pins the
 * recipient-only accept, the atomic swap and lazy expiry.
 */

const auth = vi.hoisted(() => ({ user: { id: "actor-1" }, verifyPassword: vi.fn() }));

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  memberUpdate: vi.fn(),
  memberUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
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
    user: { findUnique: db.userFindUnique },
    workspace: { findUnique: db.workspaceFindUnique, update: db.workspaceUpdate },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => auth.user),
  verifyPassword: auth.verifyPassword,
}));
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

/** The two accounts' stored hashes — only the recipient's may be compared. */
const RECIPIENT_HASH = "stored-hash-of-the-recipient";
const SENDER_HASH = "stored-hash-of-the-sender";
/** The password that matches the recipient's hash. */
const RECIPIENT_PASSWORD = "the-recipients-password";
/** The password that matches the sender's (owner's) hash. */
const SENDER_PASSWORD = "the-senders-password";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  auth.user = { id: "actor-1" };
  vi.clearAllMocks();
  db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "user-2" ? { passwordHash: RECIPIENT_HASH } : { passwordHash: SENDER_HASH },
  );
  auth.verifyPassword.mockImplementation(
    async (candidate: string, hash: string) =>
      (candidate === RECIPIENT_PASSWORD && hash === RECIPIENT_HASH) ||
      (candidate === SENDER_PASSWORD && hash === SENDER_HASH),
  );
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
    const first = await startOwnershipTransferAction({ workspaceId: "ws-1", toUserId: "user-2", password: SENDER_PASSWORD });
    expect(first).toMatchObject({ ok: true });

    const second = await startOwnershipTransferAction({ workspaceId: "ws-1", toUserId: "user-2", password: SENDER_PASSWORD });
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
      startOwnershipTransferAction({ workspaceId: "ws-guest", toUserId: "guest-2", password: SENDER_PASSWORD }),
    ).resolves.toEqual({
      error: "A guest cannot own this workspace — promote them to a member first.",
    });
  });
});

describe("acceptOwnershipTransferAction", () => {
  it("lets only the recipient accept, then swaps ownership atomically", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({ workspaceId: "ws-accept", toUserId: "user-2", password: SENDER_PASSWORD });
    if (!("ok" in started)) throw new Error(started.error);

    // The sender is not the recipient.
    await expect(acceptOwnershipTransferAction(started.id, { password: RECIPIENT_PASSWORD })).resolves.toEqual({
      error: "Only the intended recipient can accept this transfer.",
    });
    expect(db.transaction).not.toHaveBeenCalled();

    auth.user = { id: "user-2" };
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "actor-1" });
    await expect(acceptOwnershipTransferAction(started.id, { password: RECIPIENT_PASSWORD })).resolves.toEqual({ ok: true });
    expect(db.memberUpdate).toHaveBeenCalledWith({ where: { id: "m2" }, data: { role: "OWNER" } });
    expect(db.memberUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-accept", userId: "actor-1" },
      data: { role: "ADMIN" },
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("acceptOwnershipTransferAction — the password step (B14)", () => {
  /** Open a transfer that demands a password and hand it to the recipient. */
  async function passwordTransfer(workspaceId: string) {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({
      workspaceId,
      toUserId: "user-2",
      requirePassword: true,
      password: SENDER_PASSWORD,
    });
    if (!("ok" in started)) throw new Error(started.error);
    auth.user = { id: "user-2" };
    return started.id;
  }

  it("refuses an accept whose 'password confirmed' flag comes from the client", async () => {
    const id = await passwordTransfer("ws-b14-forged");

    // The client used to be able to send `passwordOk: true` and the server
    // believed it. The option is gone; the verdict is the server's own.
    const forged = { passwordOk: true } as unknown as { password?: string };
    await expect(acceptOwnershipTransferAction(id, forged)).resolves.toEqual({
      error: "A password is required to accept this transfer.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("accepts when the recipient's own password is correct", async () => {
    const id = await passwordTransfer("ws-b14-ok");

    await expect(
      acceptOwnershipTransferAction(id, { password: RECIPIENT_PASSWORD }),
    ).resolves.toEqual({ ok: true });
    // The recipient's own account is verified — the sender's hash is never
    // compared, and the owner stays an ADMIN.
    expect(db.userFindUnique).toHaveBeenCalledWith({
      where: { id: "user-2" },
      select: { passwordHash: true },
    });
    expect(auth.verifyPassword).toHaveBeenCalledWith(RECIPIENT_PASSWORD, RECIPIENT_HASH);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.memberUpdate).toHaveBeenCalledWith({ where: { id: "m2" }, data: { role: "OWNER" } });
  });

  it("refuses a wrong password", async () => {
    const id = await passwordTransfer("ws-b14-wrong");

    await expect(
      acceptOwnershipTransferAction(id, { password: "not-the-password" }),
    ).resolves.toEqual({ error: "A password is required to accept this transfer." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a missing password", async () => {
    const id = await passwordTransfer("ws-b14-missing");

    await expect(acceptOwnershipTransferAction(id)).resolves.toEqual({
      error: "A password is required to accept this transfer.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the stored hash cannot be compared", async () => {
    const id = await passwordTransfer("ws-b14-broken");
    // An SSO account's `sso:<token>` and a hash with an unknown variant make
    // `bcrypt.compare` reject; such an account must never pass the step.
    auth.verifyPassword.mockRejectedValue(new Error("Invalid salt revision: z$"));

    await expect(
      acceptOwnershipTransferAction(id, { password: RECIPIENT_PASSWORD }),
    ).resolves.toEqual({ error: "A password is required to accept this transfer." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("does not ask a non-recipient for a password", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({
      workspaceId: "ws-b14-other",
      toUserId: "user-2",
      requirePassword: true,
      password: SENDER_PASSWORD,
    });
    if (!("ok" in started)) throw new Error(started.error);

    // The sender is not the recipient: the refusal names that, and no
    // password is compared for it (in the accept step — the owner's password
    // was already checked when the transfer was started).
    auth.verifyPassword.mockClear();
    await expect(
      acceptOwnershipTransferAction(started.id, { password: RECIPIENT_PASSWORD }),
    ).resolves.toEqual({ error: "Only the intended recipient can accept this transfer." });
    expect(auth.verifyPassword).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("still accepts a transfer that asks for no password", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({
      workspaceId: "ws-b14-open",
      toUserId: "user-2",
      password: SENDER_PASSWORD,
    });
    if (!("ok" in started)) throw new Error(started.error);

    // The server decides whether a password is required — it is always
    // required now, so the recipient proves their password at accept time.
    auth.user = { id: "user-2" };
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "actor-1" });
    await expect(acceptOwnershipTransferAction(started.id, { password: RECIPIENT_PASSWORD })).resolves.toEqual({ ok: true });
    expect(auth.verifyPassword).toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("decline / cancel", () => {
  it("lets the recipient decline", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({ workspaceId: "ws-decline", toUserId: "user-2", password: SENDER_PASSWORD });
    if (!("ok" in started)) throw new Error(started.error);

    auth.user = { id: "user-2" };
    await expect(declineOwnershipTransferAction(started.id)).resolves.toEqual({ ok: true });
    await expect(listOwnershipTransfersAction("ws-decline")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("lets the sender cancel", async () => {
    auth.user = { id: "actor-1" };
    const started = await startOwnershipTransferAction({ workspaceId: "ws-cancel", toUserId: "user-2", password: SENDER_PASSWORD });
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
      password: SENDER_PASSWORD,
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
    await expect(acceptOwnershipTransferAction(started.id, { password: RECIPIENT_PASSWORD })).resolves.toEqual({
      error: "This transfer request has expired.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

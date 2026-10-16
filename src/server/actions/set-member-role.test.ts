import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `setMemberRoleAction` — the server side of the members role picker, now driven
 * by the `@/lib/workspace-roles` engine through the persisted-enum bridge.
 *
 * The real authorization chain runs (action → getWorkspaceAccess →
 * canPerformWorkspaceAction → validateRoleChange); only the transport edges
 * (prisma, auth, cache) are mocked. These pin the rule an admin may only grant a
 * role strictly below their own, and that ownership never moves through a role
 * change.
 */

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdate: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: {
      findUnique: db.memberFindUnique,
      findFirst: db.memberFindFirst,
      findMany: db.memberFindMany,
      update: db.memberUpdate,
    },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setMemberRoleAction } from "./workspaces";

/** The workspace the actor owns. */
const OWNER_WS = { ownerId: "actor-1" };
/** A workspace owned by someone else. */
const OTHER_WS = { ownerId: "owner-9" };

/** Roster with a single owner plus the actor and a member. */
const ROSTER = [{ role: "OWNER" }, { role: "ADMIN" }, { role: "MEMBER" }];

beforeEach(() => {
  vi.clearAllMocks();
  db.memberFindFirst.mockResolvedValue({ id: "m2", role: "MEMBER", user: { name: "Bob" } });
  db.memberFindMany.mockResolvedValue(ROSTER);
  db.memberUpdate.mockResolvedValue({});
});

describe("setMemberRoleAction — engine-backed role changes", () => {
  it("lets the owner promote a member to admin", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
    db.workspaceFindUnique.mockResolvedValue(OWNER_WS);

    await expect(setMemberRoleAction("ws-1", "user-2", "ADMIN")).resolves.toEqual({ ok: true });
    expect(db.memberUpdate).toHaveBeenCalledWith({
      where: { id: "m2" },
      data: { role: "ADMIN" },
    });
  });

  it("lets an admin demote a member to guest", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
    db.workspaceFindUnique.mockResolvedValue(OTHER_WS);

    await expect(setMemberRoleAction("ws-1", "user-2", "GUEST")).resolves.toEqual({ ok: true });
    expect(db.memberUpdate).toHaveBeenCalledWith({
      where: { id: "m2" },
      data: { role: "GUEST" },
    });
  });

  it("refuses an admin promoting anyone to admin (peer escalation)", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
    db.workspaceFindUnique.mockResolvedValue(OTHER_WS);

    await expect(setMemberRoleAction("ws-1", "user-2", "ADMIN")).resolves.toEqual({
      error: "You can only assign a role below your own.",
    });
    expect(db.memberUpdate).not.toHaveBeenCalled();
  });

  it("refuses a member changing anyone", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });

    await expect(setMemberRoleAction("ws-1", "user-2", "GUEST")).resolves.toEqual({
      error: "You do not have permission to change roles.",
    });
    expect(db.memberUpdate).not.toHaveBeenCalled();
  });

  it("refuses an unknown role before touching the roster", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "OWNER" });

    await expect(setMemberRoleAction("ws-1", "user-2", "SUPERUSER")).resolves.toEqual({
      error: "That role cannot be assigned here.",
    });
    expect(db.memberFindFirst).not.toHaveBeenCalled();
  });

  it("refuses to re-role the owner — transfer ownership instead", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
    db.memberFindFirst.mockResolvedValue({ id: "m1", role: "OWNER", user: { name: "Owner" } });
    db.workspaceFindUnique.mockResolvedValue(OWNER_WS);

    await expect(setMemberRoleAction("ws-1", "actor-1", "ADMIN")).resolves.toEqual({
      error: "Transfer ownership before changing the owner's role.",
    });
    expect(db.memberUpdate).not.toHaveBeenCalled();
  });

  it("refuses an admin re-roling another admin", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
    db.memberFindFirst.mockResolvedValue({ id: "m3", role: "ADMIN", user: { name: "Peer" } });
    db.workspaceFindUnique.mockResolvedValue(OTHER_WS);

    await expect(setMemberRoleAction("ws-1", "user-3", "MEMBER")).resolves.toEqual({
      error: "Only the owner can change another admin.",
    });
    expect(db.memberUpdate).not.toHaveBeenCalled();
  });

  it("accepts a no-op change without a fuss", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
    db.workspaceFindUnique.mockResolvedValue(OWNER_WS);

    await expect(setMemberRoleAction("ws-1", "user-2", "MEMBER")).resolves.toEqual({ ok: true });
  });
});

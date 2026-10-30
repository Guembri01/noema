import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateInviteToken } from "@/lib/invite-token";

/**
 * P2-T11 — single-use invite consumption is atomic.
 *
 * Redemption used to be read-then-write: resolve saw `acceptedAt: null`, then an
 * *unconditional* `prisma.invite.update` spent the invitation. Two concurrent
 * accepts both passed the read and both wrote, so neither request won the race;
 * consumption was only single-use by luck of interleaving.
 *
 * The accept now claims the invitation with a conditional update
 * (`updateMany({ where: { id, acceptedAt: null } })`) and proceeds to the
 * (idempotent) joins only when `count === 1`. The loser claims nothing and
 * settles to the same idempotent success — membership was granted by the
 * winner's upsert, so re-joining would be a no-op anyway, and the loser path
 * performs no writes of its own.
 *
 * Fail-first: under the pre-fix code both claims returned success and the second
 * accept re-ran every join and revalidation — mocked there as an
 * *unconditional* update that always "writes" (`count`-less, matching
 * `update(...)` semantics): the loser assertions ("performs no joins") in this
 * file fail against that behavior.
 *
 * The mocks serialize concurrency the way a single connection pool does:
 * both racers read the pre-write snapshot (`acceptedAt: null`), then their
 * claims interleave at query granularity — one flips the row, the other matches
 * no row.
 */

const db = vi.hoisted(() => ({
  inviteFindUnique: vi.fn(),
  inviteUpdateMany: vi.fn(),
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  teamspaceInviteFindUnique: vi.fn(),
  teamspaceInviteUpdateMany: vi.fn(),
  workspaceMemberUpsert: vi.fn(),
  projectMemberUpsert: vi.fn(),
  teamspaceMemberUpsert: vi.fn(),
}));

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    invite: { findUnique: db.inviteFindUnique, updateMany: db.inviteUpdateMany },
    workspaceMember: { findUnique: db.memberFindUnique, upsert: db.workspaceMemberUpsert },
    workspace: { findUnique: db.workspaceFindUnique },
    projectMember: { upsert: db.projectMemberUpsert },
    teamspaceInvite: {
      findUnique: db.teamspaceInviteFindUnique,
      updateMany: db.teamspaceInviteUpdateMany,
    },
    teamspaceMember: { upsert: db.teamspaceMemberUpsert },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: cache.revalidatePath }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { acceptWorkspaceInviteAction } from "./email";
import { acceptTeamspaceInviteAction } from "./teamspace-invites";

const MEMBER = { id: "new-user", name: "New Member", email: "new.member@example.test" };

function inviteFixture() {
  return {
    id: "inv-1",
    email: MEMBER.email,
    role: "MEMBER",
    invitedById: "owner-1",
    projectId: null,
    acceptedAt: null as Date | null,
    expiresAt: new Date("2026-03-24T09:00:00.000Z"),
    project: null,
    workspace: { id: "ws-1", name: "Acme", slug: "acme" },
  };
}

function teamspaceFixture() {
  return {
    id: "ts-inv-1",
    teamspaceId: "ts-1",
    email: MEMBER.email,
    role: "ADMIN",
    // The invitation carries its sender: redemption re-checks that the
    // sender still holds a member-management role (resolved as the owner
    // through `ownerId` below), so the re-check passes and the claim —
    // not the re-check — stays the thing under test here.
    invitedById: "owner-1",
    acceptedAt: null,
    expiresAt: new Date("2026-03-24T09:00:00.000Z"),
    teamspace: { name: "Design", workspace: { id: "ws-1", slug: "acme" } },
  };
}

/** The upserts each acceptance path performs on its winner path. */
const workspaceJoins = () => [db.workspaceMemberUpsert, db.projectMemberUpsert];
const teamspaceJoins = () => [db.workspaceMemberUpsert, db.teamspaceMemberUpsert];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T09:00:00.000Z"));
  auth.requireUser.mockResolvedValue(MEMBER);
  // The sender of the invitation: the workspace owner (no membership row
  // and `getWorkspaceAccess` resolves the owner through `ownerId`), so the
  // grant re-check passes and acceptance proceeds.
  db.memberFindUnique.mockResolvedValue(null);
  db.workspaceFindUnique.mockResolvedValue({ ownerId: "owner-1" });
  db.workspaceMemberUpsert.mockResolvedValue({ id: "wm-1" });
  db.projectMemberUpsert.mockResolvedValue({ id: "pm-1" });
  db.teamspaceMemberUpsert.mockResolvedValue({ id: "tm-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("single-use workspace invite consumption", () => {
  /** The pre-write snapshot both racers read from, plus the conditional */
  /** consumption row state the `updateMany` mock flips. */
  function simulateWorkspaceRow() {
    const row = inviteFixture();
    const snapshot = { ...row };
    // The resolver's read: every caller sees the pre-write snapshot —
    // the shared race window. A legacy *sequential* replay of an already-
    // consumed invite is covered separately below.
    db.inviteFindUnique.mockImplementation(async () => ({ ...snapshot }));
    // The conditional update: one winner flips the row, everything after
    // matches nothing.
    db.inviteUpdateMany.mockImplementation(
      async (args: { where: { id: string; acceptedAt: null } } & { data: { acceptedAt: Date } }) => {
        if (args.where.id !== row.id || row.acceptedAt !== null) return { count: 0 };
        Object.assign(row, { acceptedAt: args.data.acceptedAt });
        return { count: 1 };
      },
    );
    return row;
  }

  it("first accept wins: claims the invite and performs the joins", async () => {
    const row = simulateWorkspaceRow();

    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({
      ok: true,
      slug: "acme",
      workspaceName: "Acme",
      role: "MEMBER",
    });
    expect(db.inviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "inv-1", acceptedAt: null },
      data: { acceptedAt: expect.any(Date) },
    });
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect(db.workspaceMemberUpsert).toHaveBeenCalledTimes(1);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });

  it("a second accept that raced past the read loses and re-joins nothing", async () => {
    const row = simulateWorkspaceRow();
    const winner = await acceptWorkspaceInviteAction(generateInviteToken());
    expect(winner).toEqual({
      ok: true,
      slug: "acme",
      workspaceName: "Acme",
      role: "MEMBER",
    });
    const winnerUpsets = db.workspaceMemberUpsert.mock.calls.length;

    const loser = await acceptWorkspaceInviteAction(generateInviteToken());

    // The claim resolved (read passed the race window), but the conditional
    // update matched nothing — the winner spent the row first.
    expect(db.inviteUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "inv-1", acceptedAt: null } }),
    );
    // Settles to the same idempotent success (membership granted by the
    // winner), without re-joining.
    expect(loser).toEqual({
      ok: true,
      slug: "acme",
      workspaceName: "Acme",
      role: "MEMBER",
    });
    expect(db.workspaceMemberUpsert).toHaveBeenCalledTimes(winnerUpsets);
    expect(db.projectMemberUpsert).not.toHaveBeenCalled();
    expect(row.acceptedAt).not.toBeNull();
  });

  it("redemption of the already-consumed row stays refused for replayed calls", async () => {
    // An invitation consumed *before* the resolve (not merely shared past it):
    // the legacy already-accepted branch is unchanged.
    const row = inviteFixture();
    (row as { acceptedAt: Date | null }).acceptedAt = new Date(
      "2026-03-10T08:00:00.000Z",
    );
    db.inviteFindUnique.mockResolvedValue(row);

    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: "That invitation has already been used." });
    for (const join of workspaceJoins()) expect(join).not.toHaveBeenCalled();
    expect(db.inviteUpdateMany).not.toHaveBeenCalled();
  });
});

describe("single-use teamspace invite consumption", () => {
  function simulateTeamspaceRow() {
    const row = teamspaceFixture();
    const snapshot = { ...row };
    db.teamspaceInviteFindUnique.mockImplementation(async () => ({ ...snapshot }));
    db.teamspaceInviteUpdateMany.mockImplementation(
      async (args: {
        where: { id: string; acceptedAt: null };
        data: { acceptedAt: Date; acceptedById: string };
      }) => {
        if (args.where.id !== row.id || row.acceptedAt !== null) return { count: 0 };
        Object.assign(row, { acceptedAt: args.data.acceptedAt });
        return { count: 1 };
      },
    );
    return row;
  }

  it("first accept wins: claims the invite and performs the joins", async () => {
    const row = simulateTeamspaceRow();

    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ ok: true, slug: "acme", teamspaceName: "Design" });
    expect(db.teamspaceInviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "ts-inv-1", acceptedAt: null },
      data: { acceptedAt: expect.any(Date), acceptedById: MEMBER.id },
    });
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect(db.teamspaceMemberUpsert).toHaveBeenCalledTimes(1);
    expect(db.workspaceMemberUpsert).toHaveBeenCalledTimes(1);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });

  it("a second accept that raced past the read loses and re-joins nothing", async () => {
    const row = simulateTeamspaceRow();
    await acceptTeamspaceInviteAction(generateInviteToken());
    const winnerWorkspaceUpserts = db.workspaceMemberUpsert.mock.calls.length;
    const winnerTeamspaceUpserts = db.teamspaceMemberUpsert.mock.calls.length;

    const loser = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(db.teamspaceInviteUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: "ts-inv-1", acceptedAt: null } }),
    );
    expect(loser).toEqual({ ok: true, slug: "acme", teamspaceName: "Design" });
    expect(db.workspaceMemberUpsert).toHaveBeenCalledTimes(winnerWorkspaceUpserts);
    expect(db.teamspaceMemberUpsert).toHaveBeenCalledTimes(winnerTeamspaceUpserts);
    expect(row.acceptedAt).not.toBeNull();
  });

  it("an already-consumed teamspace invite is refused for replayed calls", async () => {
    const row: { acceptedAt: Date | null } = teamspaceFixture();
    row.acceptedAt = new Date("2026-03-10T08:00:00.000Z");
    db.teamspaceInviteFindUnique.mockResolvedValue(row);

    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: "That invitation has already been used." });
    for (const join of teamspaceJoins()) expect(join).not.toHaveBeenCalled();
    expect(db.teamspaceInviteUpdateMany).not.toHaveBeenCalled();
  });
});

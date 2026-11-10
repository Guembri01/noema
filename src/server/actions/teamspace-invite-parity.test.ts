import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateInviteToken } from "@/lib/invite-token";

/**
 * P3-T05 — teamspace invite redemption parity.
 *
 * Workspace invitations redeem through `canRedeem` (fail-closed expiry: the
 * expiry instant itself counts as expired) and re-check the grant at
 * redemption — the role an invitation carries must still be one its sender
 * may hand out *now*, so an invite minted by a later-demoted or removed user
 * grants nothing. The teamspace path used to hand-roll both: a fail-**open**
 * `<` expiry comparison (alive at exactly `now === expiresAt`) and no sender
 * re-check at all (an admin-minted `ADMIN` invite still granted ADMIN after
 * its sender was demoted to member).
 *
 * Both halves now match the workspace path: expiry/already-used go through
 * the same `canRedeem` decision (same precedence, same boundary, same error
 * copy), and the sender's grant is re-checked against the same threshold
 * minting asked of the actor — `canManageMembers` (`authorizeTeamspace`),
 * resolved through `getWorkspaceAccess`. `invitedById` is non-nullable for
 * teamspace invites, so there is always a sender to ask about; refusal uses
 * the workspace path's copy verbatim.
 *
 * The re-check sits inside the shared resolver, *before* the atomic claim
 * (`updateMany({ where: { acceptedAt: null } })`): a refusal never spends a
 * claim attempt, and the preview refuses exactly what the acceptance refuses.
 * The claim's winner/loser semantics from P2-T11 are untouched — see
 * `invite-consumption.test.ts`, which now runs with the re-check live.
 *
 * Fail-first notes:
 * - the exact-expiry test fails against the pre-fix `<` comparison (the
 *   invitation was still redeemable at `now === expiresAt`);
 * - every sender-refusal test fails against the pre-fix code, which granted
 *   memberships with no re-check at all (the write assertions are what fail).
 *
 * The real chain runs here (resolveTeamspaceInvite → getWorkspaceAccess →
 * canManageMembers); only the database edge, the session and the cache are
 * mocked.
 */

const db = vi.hoisted(() => ({
  teamspaceInviteFindUnique: vi.fn(),
  teamspaceInviteUpdateMany: vi.fn(),
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceMemberUpsert: vi.fn(),
  teamspaceMemberUpsert: vi.fn(),
}));

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    teamspaceInvite: {
      findUnique: db.teamspaceInviteFindUnique,
      updateMany: db.teamspaceInviteUpdateMany,
    },
    workspaceMember: { findUnique: db.memberFindUnique, upsert: db.workspaceMemberUpsert },
    workspace: { findUnique: db.workspaceFindUnique },
    teamspaceMember: { upsert: db.teamspaceMemberUpsert },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: cache.revalidatePath }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { acceptTeamspaceInviteAction, previewTeamspaceInviteAction } from "./teamspace-invites";

const MEMBER = { id: "new-user", name: "New Member", email: "new.member@example.test" };

const REFUSED =
  "This invitation can no longer be redeemed. Please ask the workspace owner for a new invitation.";
const EXPIRED = "That invitation has expired.";

const EXPIRES_AT = new Date("2026-03-24T09:00:00.000Z");

function teamspaceFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ts-inv-1",
    teamspaceId: "ts-1",
    email: MEMBER.email,
    role: "ADMIN",
    invitedById: "sender-1",
    acceptedAt: null,
    expiresAt: EXPIRES_AT,
    teamspace: { name: "Design", workspace: { id: "ws-1", slug: "acme" } },
    ...overrides,
  };
}

/** Every write (and the revalidation) the acceptance path can make. */
const writes = () => [
  db.teamspaceInviteUpdateMany,
  db.workspaceMemberUpsert,
  db.teamspaceMemberUpsert,
  cache.revalidatePath,
];

beforeEach(() => {
  vi.clearAllMocks();
  // Pin the clock: the fixtures below are dated against the release window,
  // and expiry is a real comparison against now.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T09:00:00.000Z"));
  auth.requireUser.mockResolvedValue(MEMBER);
  // The mock honours nothing about the select; the fixture row's shape is
  // what the resolver reads, exactly as `invite-accept.test.ts` does.
  db.teamspaceInviteFindUnique.mockResolvedValue(teamspaceFixture());
  db.teamspaceInviteUpdateMany.mockResolvedValue({ count: 1 });
  // The sender still holds the role that minted the invitation: an admin.
  db.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
  db.workspaceFindUnique.mockResolvedValue({ ownerId: "owner-1" });
  db.workspaceMemberUpsert.mockResolvedValue({ id: "wm-1" });
  db.teamspaceMemberUpsert.mockResolvedValue({ id: "tm-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("expiry parity with the workspace path", () => {
  it("refuses an invitation at exactly its expiry instant — the boundary fails closed", async () => {
    vi.setSystemTime(new Date(EXPIRES_AT.getTime()));

    const preview = await previewTeamspaceInviteAction(generateInviteToken());
    const accept = await acceptTeamspaceInviteAction(generateInviteToken());

    // Fail-first: the pre-fix hand-rolled `expiresAt < now` kept the
    // invitation redeemable at this exact instant.
    expect(preview).toEqual({ error: EXPIRED });
    expect(accept).toEqual({ error: EXPIRED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses an invitation one millisecond past expiry", async () => {
    vi.setSystemTime(new Date(EXPIRES_AT.getTime() + 1));

    const accept = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(accept).toEqual({ error: EXPIRED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("still redeems an invitation one millisecond before expiry", async () => {
    vi.setSystemTime(new Date(EXPIRES_AT.getTime() - 1));

    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ ok: true, slug: "acme", teamspaceName: "Design" });
    expect(db.teamspaceInviteUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("redeeming a teamspace invitation — the grant is checked again", () => {
  it("refuses an invitation whose sender has since been demoted", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });

    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses an invitation whose sender has left the workspace", async () => {
    db.memberFindUnique.mockResolvedValue(null);
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "someone-else" });

    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses an invitation whose sender is only a guest", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "GUEST" });

    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses in the preview exactly what the acceptance refuses", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });

    const preview = await previewTeamspaceInviteAction(generateInviteToken());

    expect(preview).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses before the claim — a rejected redemption never spends the claim", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });

    await acceptTeamspaceInviteAction(generateInviteToken());

    // The cheap rejection sits inside the shared resolver, ahead of the
    // atomic claim, so a refused redemption makes no claim attempt at all.
    expect(db.teamspaceInviteUpdateMany).not.toHaveBeenCalled();
  });

  it("lets an invitation whose sender still manages members redeem", async () => {
    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ ok: true, slug: "acme", teamspaceName: "Design" });
    // The claim-first consumption semantics are intact (P2-T11): the join
    // only follows a claim that matched the unspent row.
    expect(db.teamspaceInviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "ts-inv-1", acceptedAt: null },
      data: { acceptedAt: expect.any(Date), acceptedById: MEMBER.id },
    });
    expect(db.workspaceMemberUpsert).toHaveBeenCalledTimes(1);
    expect(db.teamspaceMemberUpsert).toHaveBeenCalledWith({
      where: { teamspaceId_userId: { teamspaceId: "ts-1", userId: MEMBER.id } },
      create: { teamspaceId: "ts-1", userId: MEMBER.id, role: "ADMIN" },
      update: {},
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });

  it("lets an invitation whose sender is the (row-less) owner redeem", async () => {
    // The sender has no membership row; `getWorkspaceAccess` still resolves
    // them as the owner through the workspace's `ownerId`.
    db.memberFindUnique.mockResolvedValue(null);
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "sender-1" });

    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ ok: true, slug: "acme", teamspaceName: "Design" });
    expect(db.teamspaceMemberUpsert).toHaveBeenCalledTimes(1);
  });
});

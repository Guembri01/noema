import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateInviteToken } from "@/lib/invite-token";

/**
 * The read/write split of invitation redemption.
 *
 * The invite pages are GETs that anyone (and anything) can fetch — mail scanners,
 * chat-app link previews, a browser's prefetch — so the read must be inert and
 * only the POST the page's form makes may spend the invite. These tests pin both
 * halves: `preview*` never writes and still refuses exactly what the accept
 * refuses, `accept*` performs the writes and (now that it only ever runs from a
 * POST) may legally revalidate.
 *
 * Only the database edge, auth, `next/cache` and `next/headers` are mocked; the
 * token digesting, expiry/reuse decision and address check run for real.
 */

const db = vi.hoisted(() => ({
  inviteFindUnique: vi.fn(),
  inviteUpdateMany: vi.fn(),
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceMemberUpsert: vi.fn(),
  projectMemberUpsert: vi.fn(),
  teamspaceInviteFindUnique: vi.fn(),
  teamspaceInviteUpdateMany: vi.fn(),
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

import { acceptWorkspaceInviteAction, previewWorkspaceInviteAction } from "./email";
import {
  acceptTeamspaceInviteAction,
  previewTeamspaceInviteAction,
} from "./teamspace-invites";

const MEMBER = { id: "new-user", name: "New Member", email: "new.member@example.test" };

function inviteFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "inv-1",
    email: MEMBER.email,
    role: "MEMBER",
    invitedById: "owner-1",
    projectId: null,
    acceptedAt: null,
    expiresAt: new Date("2026-03-24T09:00:00.000Z"),
    project: null,
    workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    ...overrides,
  };
}

function teamspaceFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ts-inv-1",
    teamspaceId: "ts-1",
    email: MEMBER.email,
    role: "ADMIN",
    // The invitation carries its sender: redemption re-checks that the
    // sender still holds a member-management role. The mocked sender
    // resolves as the workspace owner (`ownerId` below), so the re-check
    // passes by default.
    invitedById: "owner-1",
    acceptedAt: null,
    expiresAt: new Date("2026-03-24T09:00:00.000Z"),
    teamspace: { name: "Design", workspace: { id: "ws-1", slug: "acme" } },
    ...overrides,
  };
}

/** Every write the two acceptance paths can make. */
const writes = () => [
  db.inviteUpdateMany,
  db.workspaceMemberUpsert,
  db.projectMemberUpsert,
  db.teamspaceInviteUpdateMany,
  db.teamspaceMemberUpsert,
];

beforeEach(() => {
  vi.clearAllMocks();
  // Pin the clock: the fixtures below are dated against the release window, and
  // expiry is decided by a real comparison against now.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T09:00:00.000Z"));
  auth.requireUser.mockResolvedValue(MEMBER);
  db.inviteFindUnique.mockResolvedValue(inviteFixture());
  db.inviteUpdateMany.mockResolvedValue({ count: 1 });
  // The sender of the invitation: the workspace owner (no membership row).
  db.memberFindUnique.mockResolvedValue(null);
  db.workspaceFindUnique.mockResolvedValue({ ownerId: "owner-1" });
  db.workspaceMemberUpsert.mockResolvedValue({ id: "wm-1" });
  db.projectMemberUpsert.mockResolvedValue({ id: "pm-1" });
  db.teamspaceInviteFindUnique.mockResolvedValue(teamspaceFixture());
  db.teamspaceInviteUpdateMany.mockResolvedValue({ count: 1 });
  db.teamspaceMemberUpsert.mockResolvedValue({ id: "tm-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("previewing a workspace invitation", () => {
  it("describes the invitation without writing anything", async () => {
    const preview = await previewWorkspaceInviteAction(generateInviteToken());

    expect(preview).toEqual({
      ok: true,
      workspaceName: "Acme",
      workspaceSlug: "acme",
      role: "MEMBER",
      projectName: null,
    });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(db.inviteFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { token: expect.stringMatching(/^[0-9a-f]{64}$/) } }),
    );
  });

  it("stays redeemable however often the link is opened", async () => {
    const token = generateInviteToken();

    const first = await previewWorkspaceInviteAction(token);
    const second = await previewWorkspaceInviteAction(token);

    expect(first).toEqual(second);
    // The essence of the fix: a preview (which is what a GET renders, and what a
    // scanner or prefetch triggers) leaves `acceptedAt` alone.
    expect(db.inviteUpdateMany).not.toHaveBeenCalled();
  });

  it("names the project a client invitation is scoped to", async () => {
    db.inviteFindUnique.mockResolvedValue(
      inviteFixture({ role: "GUEST", projectId: "p-1", project: { name: "Website" } }),
    );

    const preview = await previewWorkspaceInviteAction(generateInviteToken());

    expect(preview).toEqual({
      ok: true,
      workspaceName: "Acme",
      workspaceSlug: "acme",
      role: "GUEST",
      projectName: "Website",
    });
  });

  it.each([
    [
      "an expired invitation",
      { expiresAt: new Date("2026-03-09T09:00:00.000Z") },
      "That invitation has expired.",
    ],
    [
      "an invitation that was already used",
      { acceptedAt: new Date("2026-03-10T08:00:00.000Z") },
      "That invitation has already been used.",
    ],
    [
      "an invitation addressed to someone else",
      { email: "someone.else@example.test" },
      "This invitation is for someone.else@example.test. Sign in with that address.",
    ],
  ])("refuses %s, the same way the accept does", async (_label, overrides, error) => {
    db.inviteFindUnique.mockResolvedValue(inviteFixture(overrides));

    const preview = await previewWorkspaceInviteAction(generateInviteToken());
    const accept = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(preview).toEqual({ error });
    expect(accept).toEqual({ error });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses a token that is not a minted value, before any lookup", async () => {
    const preview = await previewWorkspaceInviteAction("not a token!");

    expect(preview).toEqual({ error: "That invitation link is not valid." });
    expect(db.inviteFindUnique).not.toHaveBeenCalled();
  });
});

describe("accepting a workspace invitation", () => {
  it("writes the membership, spends the invite and revalidates", async () => {
    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({
      ok: true,
      slug: "acme",
      workspaceName: "Acme",
      role: "MEMBER",
    });
    expect(db.workspaceMemberUpsert).toHaveBeenCalledTimes(1);
    expect(db.inviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "inv-1", acceptedAt: null },
      data: { acceptedAt: expect.any(Date) },
    });
    // Only legal because acceptance is a POST: the invite page used to accept
    // during render, where Next throws on `revalidatePath` *after* the write.
    expect(cache.revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });

  it("also grants the client view access to the scoped project", async () => {
    db.inviteFindUnique.mockResolvedValue(
      inviteFixture({ role: "GUEST", projectId: "p-1", project: { name: "Website" } }),
    );

    await acceptWorkspaceInviteAction(generateInviteToken());

    expect(db.projectMemberUpsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: "p-1", userId: MEMBER.id } },
      create: { projectId: "p-1", userId: MEMBER.id, role: "CLIENT" },
      update: {},
    });
  });
});

describe("teamspace invitations", () => {
  it("previews without writing", async () => {
    const preview = await previewTeamspaceInviteAction(generateInviteToken());

    expect(preview).toEqual({ ok: true, teamspaceName: "Design", workspaceSlug: "acme", role: "ADMIN" });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses what the accept refuses, without writing", async () => {
    db.teamspaceInviteFindUnique.mockResolvedValue(
      teamspaceFixture({ acceptedAt: new Date("2026-03-10T08:00:00.000Z") }),
    );

    const preview = await previewTeamspaceInviteAction(generateInviteToken());

    expect(preview).toEqual({ error: "That invitation has already been used." });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("accepts on the POST and revalidates", async () => {
    const result = await acceptTeamspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ ok: true, slug: "acme", teamspaceName: "Design" });
    // Joining a teamspace implies workspace membership.
    expect(db.workspaceMemberUpsert).toHaveBeenCalledTimes(1);
    expect(db.teamspaceMemberUpsert).toHaveBeenCalledTimes(1);
    expect(db.teamspaceInviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "ts-inv-1", acceptedAt: null },
      data: { acceptedAt: expect.any(Date), acceptedById: MEMBER.id },
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The external-guest plan gate is load-bearing: `sendWorkspaceInviteAction`
 * reads the workspace's guest seats and refuses a *new* guest invite once the
 * plan's ceiling is reached. The real authorization chain
 * (authorizeAdmin → getWorkspaceAccess → canManageMembers) and the real gate
 * (`evaluateGuestInviteGate` → `withinLimit`) run here; only the database edge
 * is mocked, and only the two reads the deny path performs.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: h.memberFindUnique },
    workspace: { findUnique: h.workspaceFindUnique },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { sendWorkspaceInviteAction } from "./email";

const ORIGINAL_PLAN = process.env.WORKSPACE_PLAN;

/** The `_count` shape `sendWorkspaceInviteAction` now selects from the workspace. */
function workspaceWithGuests(guests: number, pendingInvites = 0) {
  return {
    name: "Acme",
    slug: "acme",
    ownerId: "owner-1",
    owner: { email: "owner@example.test" },
    _count: { members: guests, invites: pendingInvites },
  };
}

describe("sendWorkspaceInviteAction external-guest plan gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requireUser.mockResolvedValue({ id: "admin-1", name: "Admin", email: "admin@example.test" });
    h.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
    delete process.env.WORKSPACE_PLAN;
  });

  afterEach(() => {
    if (ORIGINAL_PLAN === undefined) delete process.env.WORKSPACE_PLAN;
    else process.env.WORKSPACE_PLAN = ORIGINAL_PLAN;
  });

  it("denies a new guest once the free plan's cap is reached", async () => {
    h.workspaceFindUnique.mockResolvedValue(workspaceWithGuests(5));
    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "client@example.test",
      role: "GUEST",
    });

    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toContain("Free plan");
      expect(res.error).toContain("5 external guests");
    }
  });

  it("counts pending guest invites toward the cap", async () => {
    // 3 accepted guests + 2 still-pending invites = the free ceiling of 5.
    h.workspaceFindUnique.mockResolvedValue(workspaceWithGuests(3, 2));
    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "client@example.test",
      role: "GUEST",
    });
    expect("error" in res).toBe(true);
  });

  it("does not gate member invites", async () => {
    // A guest-ceiling workspace, but the invite is for a MEMBER: the gate is
    // skipped, so the action proceeds past it to the (unmocked) invite write
    // and throws — a typed `{ error }` would mean the gate wrongly denied.
    h.workspaceFindUnique.mockResolvedValue(workspaceWithGuests(50));
    await expect(
      sendWorkspaceInviteAction({ workspaceId: "ws-1", email: "mate@example.test" }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("honours the WORKSPACE_PLAN environment field", async () => {
    process.env.WORKSPACE_PLAN = "enterprise"; // unlimited guests
    h.workspaceFindUnique.mockResolvedValue(workspaceWithGuests(10_000));
    await expect(
      sendWorkspaceInviteAction({ workspaceId: "ws-1", email: "c@example.test", role: "GUEST" }),
    ).rejects.toBeInstanceOf(Error);
  });
});

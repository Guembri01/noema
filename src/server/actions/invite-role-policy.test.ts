import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B15 — the role an *invitation* carries is a grant, so it must go through the
 * same policy as a role change.
 *
 * The role matrix grants an actor only the roles strictly below their own
 * (`assignableRoles` / `canGrantRole` in `@/lib/workspace-roles`): an admin may
 * hand out member/guest, only the owner may grant the admin role. The
 * invitation path used to check the role against a hard-coded list instead, so
 * an admin could invite a colleague as ADMIN and the invitee became a workspace
 * admin.
 *
 * The real authorization chain runs here (authorizeAdmin → getWorkspaceAccess →
 * canManageMembers → the grant policy); only the database edge, the session,
 * the cache and the SMTP transport are mocked.
 */

const h = vi.hoisted(() => {
  const transport = { sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() };
  return {
    transport,
    createTransport: vi.fn(() => transport),
    requireUser: vi.fn(),
    memberFindUnique: vi.fn(),
    workspaceFindUnique: vi.fn(),
    inviteDeleteMany: vi.fn(),
    inviteCreate: vi.fn(),
    emailConfigFindUnique: vi.fn(),
    emailDeliveryCreate: vi.fn(),
  };
});

vi.mock("nodemailer", () => ({ default: { createTransport: h.createTransport } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: h.memberFindUnique },
    workspace: { findUnique: h.workspaceFindUnique },
    invite: { deleteMany: h.inviteDeleteMany, create: h.inviteCreate },
    emailConfig: { findUnique: h.emailConfigFindUnique },
    emailDelivery: { create: h.emailDeliveryCreate },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { sendWorkspaceInviteAction } from "./email";

/** The workspace the invite targets (the shape the action selects). */
const WORKSPACE = {
  name: "Acme",
  slug: "acme",
  ownerId: "owner-1",
  owner: { email: "owner@example.test" },
  _count: { members: 0, invites: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "actor-1", name: "Actor", email: "actor@example.test" });
  h.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
  h.workspaceFindUnique.mockResolvedValue(WORKSPACE);
  h.inviteDeleteMany.mockResolvedValue({ count: 0 });
  h.inviteCreate.mockResolvedValue({ id: "inv-1" });
  h.emailConfigFindUnique.mockResolvedValue(null);
  h.emailDeliveryCreate.mockResolvedValue({ id: "ed-1" });
});

describe("sendWorkspaceInviteAction — who may grant which role", () => {
  it("refuses an admin inviting another admin (peer escalation)", async () => {
    h.memberFindUnique.mockResolvedValue({ role: "ADMIN" });

    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "colleague@example.test",
      role: "ADMIN",
    });

    expect(res).toEqual({ error: "Only the workspace owner can invite an admin." });
    expect(h.inviteCreate).not.toHaveBeenCalled();
  });

  it("lets the owner invite an admin", async () => {
    h.memberFindUnique.mockResolvedValue({ role: "OWNER" });

    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "colleague@example.test",
      role: "ADMIN",
    });

    expect("error" in res).toBe(false);
    expect(h.inviteCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ADMIN" }) }),
    );
  });

  it("lets an admin invite a member", async () => {
    h.memberFindUnique.mockResolvedValue({ role: "ADMIN" });

    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "mate@example.test",
      role: "MEMBER",
    });

    expect("error" in res).toBe(false);
    expect(h.inviteCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "MEMBER" }) }),
    );
  });

  it("never grants the owner role, whoever asks", async () => {
    h.memberFindUnique.mockResolvedValue({ role: "OWNER" });

    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "mate@example.test",
      role: "OWNER",
    });

    expect(res).toEqual({ error: "Unknown role." });
    expect(h.inviteCreate).not.toHaveBeenCalled();
  });

  it("refuses an unknown role before writing anything", async () => {
    h.memberFindUnique.mockResolvedValue({ role: "OWNER" });

    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "mate@example.test",
      role: "SUPERUSER" as never,
    });

    expect(res).toEqual({ error: "Unknown role." });
    expect(h.inviteCreate).not.toHaveBeenCalled();
  });

  it("refuses a member inviting anybody at all", async () => {
    h.memberFindUnique.mockResolvedValue({ role: "MEMBER" });

    const res = await sendWorkspaceInviteAction({
      workspaceId: "ws-1",
      email: "mate@example.test",
      role: "MEMBER",
    });

    expect(res).toEqual({ error: "Only workspace admins can manage email and invitations." });
    expect(h.inviteCreate).not.toHaveBeenCalled();
  });
});

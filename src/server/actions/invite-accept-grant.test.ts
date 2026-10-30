import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B15 (round 2) — the role an invitation carries is a grant, so it is checked
 * again when the invitation is redeemed.
 *
 * The B15 fix stopped an *admin* from minting an admin invitation, but an
 * invitation minted before that fix still carried `role: "ADMIN"` and the
 * redemption path granted it unchanged — the same escalation, for up to 14
 * more days. Redemption now asks the matrix the same question, asked of the
 * *sender* of the invitation: the role it carries must still be a role its
 * sender may hand out now. So an invitation an admin minted is refused (an
 * admin may not grant the admin role), one whose sender has since been
 * demoted or removed is refused, and one that names no sender at all cannot be
 * checked and is refused as well — fail closed, before any write.
 *
 * The real chain runs here (resolveWorkspaceInvite → getWorkspaceAccess →
 * canGrantRole); only the database edge, the session and the cache are mocked.
 */

const h = vi.hoisted(() => ({
  inviteFindUnique: vi.fn(),
  inviteUpdateMany: vi.fn(),
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  workspaceMemberUpsert: vi.fn(),
  projectMemberUpsert: vi.fn(),
  requireUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    invite: { findUnique: h.inviteFindUnique, updateMany: h.inviteUpdateMany },
    workspaceMember: { findUnique: h.memberFindUnique, upsert: h.workspaceMemberUpsert },
    workspace: { findUnique: h.workspaceFindUnique },
    projectMember: { upsert: h.projectMemberUpsert },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { acceptWorkspaceInviteAction, previewWorkspaceInviteAction } from "./email";
import { generateInviteToken } from "@/lib/invite-token";

const INVITEE = { id: "invitee-1", name: "Invitee", email: "invitee@example.test" };

const REFUSED =
  "This invitation can no longer be redeemed. Please ask the workspace owner for a new invitation.";

function inviteFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    email: INVITEE.email,
    role: "ADMIN",
    invitedById: "sender-1",
    projectId: null,
    acceptedAt: null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    project: null,
    workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    ...overrides,
  };
}

/** Every write the acceptance path can make. */
const writes = () => [
  h.workspaceMemberUpsert,
  h.projectMemberUpsert,
  h.inviteUpdateMany,
  h.revalidatePath,
];

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(INVITEE);
  // The mock honours the query's `select`: the redemption reads the
  // invitation's **sender**, so a query that stops asking for it must fail
  // the test rather than pass on a fixture that always carries it.
  h.inviteFindUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
    const row = inviteFixture();
    const select = args?.select;
    if (!select) return row;
    const picked: Record<string, unknown> = {};
    for (const [key, wanted] of Object.entries(select)) {
      if (wanted) picked[key] = (row as Record<string, unknown>)[key];
    }
    return picked;
  });
  h.inviteUpdateMany.mockResolvedValue({ count: 1 });
  // The sender's access: a member row with the admin role.
  h.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
  h.workspaceFindUnique.mockResolvedValue({ ownerId: "owner-1" });
  h.workspaceMemberUpsert.mockResolvedValue({ id: "wm-1" });
  h.projectMemberUpsert.mockResolvedValue({ id: "pm-1" });
});

describe("redeeming an invitation — the grant is checked again", () => {
  it("refuses an admin invitation an admin minted (the pre-fix exploit)", async () => {
    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses an invitation whose sender has since been demoted", async () => {
    h.memberFindUnique.mockResolvedValue({ role: "MEMBER" });

    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses an invitation whose sender has left the workspace", async () => {
    h.memberFindUnique.mockResolvedValue(null);
    h.workspaceFindUnique.mockResolvedValue({ ownerId: "owner-1" });

    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("refuses an invitation that names no sender at all", async () => {
    h.inviteFindUnique.mockResolvedValue(inviteFixture({ invitedById: null }));

    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("lets an owner-minted admin invitation redeem", async () => {
    // The owner has no membership row; `getWorkspaceAccess` still resolves them
    // as the owner through the workspace's `ownerId`.
    h.memberFindUnique.mockResolvedValue(null);
    h.workspaceFindUnique.mockResolvedValue({ ownerId: "sender-1" });

    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ ok: true, slug: "acme", workspaceName: "Acme", role: "ADMIN" });
    expect(h.workspaceMemberUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ role: "ADMIN" }) }),
    );
  });

  it("lets an admin-minted member invitation redeem", async () => {
    h.inviteFindUnique.mockResolvedValue(inviteFixture({ role: "MEMBER" }));

    const result = await acceptWorkspaceInviteAction(generateInviteToken());

    expect(result).toEqual({ ok: true, slug: "acme", workspaceName: "Acme", role: "MEMBER" });
    expect(h.workspaceMemberUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ role: "MEMBER" }) }),
    );
  });

  it("refuses in the preview exactly what the acceptance refuses", async () => {
    const preview = await previewWorkspaceInviteAction(generateInviteToken());

    expect(preview).toEqual({ error: REFUSED });
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });
});

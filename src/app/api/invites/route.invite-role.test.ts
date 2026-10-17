import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B15 — `POST /api/invites` must not be a way around the role matrix.
 *
 * The route is only a transport: it authenticates the caller, translates the
 * body and hands the invite to `sendWorkspaceInviteAction`, which applies the
 * same grant policy as a role change — only the workspace owner may grant the
 * admin role. The real action chain runs here (authorizeAdmin →
 * getWorkspaceAccess → the grant policy); only the database edge, the session,
 * the rate limiter, the cache and the SMTP transport are mocked.
 *
 * (Its own file: the listing test of the same route mocks the access lookup
 * and the invite actions themselves for a different set of cases, and two
 * `vi.mock` blocks for one module cannot live in one file.)
 */

const h = vi.hoisted(() => {
  const transport = { sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() };
  return {
    transport,
    createTransport: vi.fn(() => transport),
    getCurrentUser: vi.fn(),
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
vi.mock("@/lib/auth", () => ({
  getCurrentUser: h.getCurrentUser,
  requireUser: h.requireUser,
}));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { POST } from "./route";

/** The workspace the invite targets (the shape the action selects). */
const WORKSPACE = {
  name: "Acme",
  slug: "acme",
  ownerId: "owner-1",
  owner: { email: "owner@example.test" },
  _count: { members: 0, invites: 0 },
};

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.getCurrentUser.mockResolvedValue({ id: "actor-1" });
  h.requireUser.mockResolvedValue({ id: "actor-1", name: "Actor", email: "actor@example.test" });
  h.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
  h.workspaceFindUnique.mockResolvedValue(WORKSPACE);
  h.inviteDeleteMany.mockResolvedValue({ count: 0 });
  h.inviteCreate.mockResolvedValue({ id: "inv-1" });
  h.emailConfigFindUnique.mockResolvedValue(null);
  h.emailDeliveryCreate.mockResolvedValue({ id: "ed-1" });
});

describe("POST /api/invites — the role an invitation carries", () => {
  it("refuses an admin inviting another admin", async () => {
    const response = await post({
      target: "workspace",
      workspaceId: "ws-1",
      email: "colleague@example.test",
      role: "ADMIN",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Only the workspace owner can invite an admin." });
    expect(h.inviteCreate).not.toHaveBeenCalled();
  });

  it("lets the owner invite an admin", async () => {
    h.memberFindUnique.mockResolvedValue({ role: "OWNER" });

    const response = await post({
      target: "workspace",
      workspaceId: "ws-1",
      email: "colleague@example.test",
      role: "ADMIN",
    });

    expect(response.status).toBe(200);
    expect(h.inviteCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ADMIN" }) }),
    );
  });

  it("lets an admin invite a member", async () => {
    const response = await post({
      target: "workspace",
      workspaceId: "ws-1",
      email: "mate@example.test",
      role: "MEMBER",
    });

    expect(response.status).toBe(200);
    expect(h.inviteCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "MEMBER" }) }),
    );
  });

  it.each(["OWNER", "ROOT", "admin", "superuser"])(
    "refuses the unknown role %s instead of downgrading it to member",
    async (role) => {
      const response = await post({
        target: "workspace",
        workspaceId: "ws-1",
        email: "mate@example.test",
        role,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Unknown role." });
      expect(h.inviteCreate).not.toHaveBeenCalled();
      expect(h.inviteDeleteMany).not.toHaveBeenCalled();
    },
  );
});

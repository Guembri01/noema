import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B86 — `GET /api/invites` must enforce the role its own doc comment promises
 * ("admins only").
 *
 * The handler used to check workspace *membership* only, so a GUEST — and a
 * plain MEMBER — were answered `200` with an empty delivery list: the call
 * reached `listEmailDeliveries`, whose own role gate read no rows and
 * returned `[]`, where the contract said "admins only" and expected `403`.
 * The route now asks the role matrix before it lists anything.
 *
 * Only the transport edges are mocked (session, rate limiter, the access
 * lookup, the invite actions). The role predicate — `canMembersAction` →
 * `canWorkspace` → `WORKSPACE_PERMISSIONS` — runs for real, so the test pins
 * the matrix and not a hand-written role comparison.
 */

const edge = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  listEmailDeliveries: vi.fn(),
  sendWorkspaceInviteAction: vi.fn(),
  inviteTeamspaceMemberAction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
vi.mock("@/lib/permissions", () => ({ getWorkspaceAccess: edge.getWorkspaceAccess }));
vi.mock("@/server/actions/email", () => ({
  listEmailDeliveries: edge.listEmailDeliveries,
  sendWorkspaceInviteAction: edge.sendWorkspaceInviteAction,
}));
vi.mock("@/server/actions/teamspace-invites", () => ({
  inviteTeamspaceMemberAction: edge.inviteTeamspaceMemberAction,
}));

import { GET } from "./route";

const DELIVERIES = [
  {
    id: "d-1",
    to: "colleague@example.test",
    subject: "Ada invited you to Acme",
    kind: "workspace-invite",
    status: "sent",
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const read = (workspaceId = "ws-1") =>
  GET(new Request(`http://localhost/api/invites?workspaceId=${workspaceId}`));

beforeEach(() => {
  vi.clearAllMocks();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  edge.listEmailDeliveries.mockResolvedValue(DELIVERIES);
});

describe("GET /api/invites — the listing is admin-only", () => {
  it("refuses a guest and never lists the deliveries", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });

    const res = await read();

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(edge.listEmailDeliveries).not.toHaveBeenCalled();
  });

  it("refuses a plain member too", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const res = await read();

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(edge.listEmailDeliveries).not.toHaveBeenCalled();
  });

  it("refuses a role the matrix does not know", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "SUPERUSER" });

    const res = await read();

    expect(res.status).toBe(403);
    expect(edge.listEmailDeliveries).not.toHaveBeenCalled();
  });

  it("serves an admin the deliveries", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });

    const res = await read();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deliveries: DELIVERIES });
    expect(edge.listEmailDeliveries).toHaveBeenCalledWith("ws-1", 25);
  });

  it("serves the owner the deliveries", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "OWNER" });

    const res = await read();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deliveries: DELIVERIES });
    expect(edge.listEmailDeliveries).toHaveBeenCalledWith("ws-1", 25);
  });

  it("answers 404 for a non-member and never lists the deliveries", async () => {
    edge.getWorkspaceAccess.mockResolvedValue(null);

    const res = await read();

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Workspace not found" });
    expect(edge.listEmailDeliveries).not.toHaveBeenCalled();
  });
});

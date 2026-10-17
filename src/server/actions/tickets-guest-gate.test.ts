import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the ticket reads are role-gated, not page-scoped.
 *
 * `GET /api/tickets` refuses a `GUEST` with a 403, but the same rows were
 * still served by the server actions the tracker UI calls: the "Load more"
 * pagination and the drawer's activity trail. A gate that only lives on the
 * route is bypassable with one server-action call, so the actions ask the same
 * question the route asks.
 *
 * The real role predicate (`canEditContent`) runs here; only the transport
 * edges (prisma, auth, the queries module) are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getTicketsPage: vi.fn(),
  getTicketDetail: vi.fn(),
  ticketFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { ticket: { findUnique: h.ticketFindUnique } },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("@/server/queries", () => ({
  getTicketsPage: h.getTicketsPage,
  getTicketDetail: h.getTicketDetail,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getTicketActivityAction, loadMoreTicketsAction } from "./tickets";

/** One workspace ticket, as `getTicketsPage` returns it. */
const TICKET = {
  id: "t1",
  key: "WS-1",
  title: "Offsite budget",
  description: null,
  type: "task",
  status: "todo",
  priority: "medium",
  estimate: null,
  estimateUnit: "hours",
  startDate: null,
  dueDate: null,
  parentId: null,
  cycleId: null,
  project: null,
  milestone: null,
  assignee: null,
  labels: [],
  _count: { children: 0, comments: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1" });
  // A guest: an external collaborator with access to a few shared pages.
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.getTicketsPage.mockResolvedValue({ tickets: [], nextCursor: null });
  h.getTicketDetail.mockResolvedValue({ activity: [] });
  h.ticketFindUnique.mockResolvedValue({ workspaceId: "ws1" });
});

describe("loadMoreTicketsAction", () => {
  it("refuses a guest and lists nothing", async () => {
    const result = await loadMoreTicketsAction({ workspaceId: "ws1", cursor: "c1" });

    expect(result).toEqual({ error: "You do not have permission to read tickets." });
    expect(h.getTicketsPage).not.toHaveBeenCalled();
  });

  it("still serves a full member", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    h.getTicketsPage.mockResolvedValue({ tickets: [TICKET], nextCursor: null });

    const result = await loadMoreTicketsAction({ workspaceId: "ws1", cursor: "c1" });

    expect(result).toMatchObject({ ok: true, nextCursor: null });
    expect(h.getTicketsPage).toHaveBeenCalledTimes(1);
    expect("tickets" in result && result.tickets[0]).toMatchObject({
      id: "t1",
      title: "Offsite budget",
    });
  });

  it("reports a workspace the caller is not a member of", async () => {
    h.getWorkspaceAccess.mockResolvedValue(null);

    const result = await loadMoreTicketsAction({ workspaceId: "ws1", cursor: "c1" });

    expect(result).toEqual({ error: "Workspace not found." });
    expect(h.getTicketsPage).not.toHaveBeenCalled();
  });
});

describe("getTicketActivityAction", () => {
  it("refuses a guest and reads no trail", async () => {
    const result = await getTicketActivityAction("t1");

    expect(result).toEqual({ error: "You do not have permission to read tickets." });
    expect(h.getTicketDetail).not.toHaveBeenCalled();
  });

  it("still serves a full member", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    h.getTicketDetail.mockResolvedValue({
      activity: [{ id: "a1", kind: "created", detail: null, createdAt: new Date(), actor: null }],
    });

    const result = await getTicketActivityAction("t1");

    expect(result).toMatchObject({ ok: true });
    // The detail is read in the ticket's own workspace, so its relations are
    // filtered by it as well.
    expect(h.getTicketDetail).toHaveBeenCalledWith("t1", "ws1");
  });
});

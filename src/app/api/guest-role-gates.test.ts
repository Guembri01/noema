import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the workspace-wide read APIs must not serve a `GUEST`.
 *
 * Tickets, discussions and calendar events are **not** page-scoped: there is
 * no page id to filter them by, so the guest scope cannot narrow them. The
 * routes therefore need a role check of their own — a `GUEST` is an external
 * collaborator with access to a few shared pages and may not read the
 * workspace's tracker, discussions or calendar at all.
 *
 * The transport edges are mocked; the role predicate (`canEditContent`) and
 * the response shaping run for real.
 */

const edge = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getTicketsCursorPage: vi.fn(),
  getLabels: vi.fn(),
  getChatThreadsWithMessages: vi.fn(),
  getCalendarFeeds: vi.fn(),
  getUpcomingEvents: vi.fn(),
  calendarEventFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: edge.getWorkspaceAccess };
});
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
vi.mock("@/server/queries", () => ({
  getLabels: edge.getLabels,
  getTicketsCursorPage: edge.getTicketsCursorPage,
  getChatThreadsWithMessages: edge.getChatThreadsWithMessages,
  getCalendarFeeds: edge.getCalendarFeeds,
  getUpcomingEvents: edge.getUpcomingEvents,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    calendarEvent: {
      findMany: edge.calendarEventFindMany,
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));
vi.mock("@/server/actions/tickets", () => ({
  addTicketCommentAction: vi.fn(),
  archiveTicketAction: vi.fn(),
  bulkArchiveTicketsAction: vi.fn(),
  bulkDeleteTicketsAction: vi.fn(),
  bulkUpdateTicketsAction: vi.fn(),
  createLabelAction: vi.fn(),
  createTicketAction: vi.fn(),
  deleteLabelAction: vi.fn(),
  deleteTicketAction: vi.fn(),
  linkTicketsAction: vi.fn(),
  moveTicketAction: vi.fn(),
  ticketFromPageAction: vi.fn(),
  toggleTicketLabelAction: vi.fn(),
  unlinkTicketAction: vi.fn(),
  updateLabelAction: vi.fn(),
  updateTicketAction: vi.fn(),
}));
vi.mock("@/server/actions/chat", () => ({
  createChatThreadAction: vi.fn(),
  deleteChatThreadAction: vi.fn(),
  postChatMessageAction: vi.fn(),
  renameChatThreadAction: vi.fn(),
}));
vi.mock("@/server/actions/calendar", () => ({
  connectCalendarFeedAction: vi.fn(),
  createMeetingNoteAction: vi.fn(),
  disconnectCalendarFeedAction: vi.fn(),
  refreshCalendarFeedsAction: vi.fn(),
}));

import { GET as listTickets } from "./tickets/route";
import { GET as listThreads } from "./chat/route";
import { GET as listCalendar, POST as postCalendar } from "./calendar/route";

const request = (path: string, body?: Record<string, unknown>) =>
  new Request(`http://localhost${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  edge.getTicketsCursorPage.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
  edge.getLabels.mockResolvedValue([]);
  edge.getChatThreadsWithMessages.mockResolvedValue([]);
  edge.getCalendarFeeds.mockResolvedValue([]);
  edge.getUpcomingEvents.mockResolvedValue([]);
  edge.calendarEventFindMany.mockResolvedValue([]);
});

describe("GET /api/tickets", () => {
  it("refuses a guest and lists nothing", async () => {
    const response = await listTickets(request("/api/tickets?workspaceId=ws-1"));

    expect(response.status).toBe(403);
    expect(edge.getTicketsCursorPage).not.toHaveBeenCalled();
  });

  it("still serves a full member", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const response = await listTickets(request("/api/tickets?workspaceId=ws-1"));

    expect(response.status).toBe(200);
    expect(edge.getTicketsCursorPage).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/chat", () => {
  it("refuses a guest and lists nothing", async () => {
    const response = await listThreads(request("/api/chat?workspaceId=ws-1"));

    expect(response.status).toBe(403);
    expect(edge.getChatThreadsWithMessages).not.toHaveBeenCalled();
  });

  it("still serves a full member", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const response = await listThreads(request("/api/chat?workspaceId=ws-1"));

    expect(response.status).toBe(200);
    expect(edge.getChatThreadsWithMessages).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/calendar", () => {
  it("refuses a guest and lists nothing", async () => {
    const response = await listCalendar(request("/api/calendar?workspaceId=ws-1"));

    expect(response.status).toBe(403);
    expect(edge.getUpcomingEvents).not.toHaveBeenCalled();
  });

  it("still serves a full member", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const response = await listCalendar(request("/api/calendar?workspaceId=ws-1"));

    expect(response.status).toBe(200);
    expect(edge.getUpcomingEvents).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/calendar — sync", () => {
  it("refuses a guest: the sync plan echoes every local event", async () => {
    const response = await postCalendar(
      request("/api/calendar", { action: "sync", workspaceId: "ws-1" }),
    );

    expect(response.status).toBe(403);
    expect(edge.calendarEventFindMany).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B54 — the workspace shell's datasets, scoped for the viewer.
 *
 * The shell is a client component tree, so every dataset it is handed travels
 * to the browser in the RSC payload. `getWorkspaceShellDatasets` is the one
 * place that decides what the shell may see:
 *
 *  - a guest (a role that may not edit content) gets empty sets and a zero
 *    ticket count, and the queries behind them never run;
 *  - the teamspaces are the exception: they follow the viewer's *teamspace
 *    scope* (the teamspaces the guest's own pages live in), because the sidebar
 *    draws a page under the section of its teamspace and would drop the branch
 *    of a page that was shared with the guest;
 *  - everybody else gets the workspace's rows, projected onto the shapes the
 *    shell renders — without the private calendar feed URL, which stays on the
 *    server.
 */

const db = vi.hoisted(() => ({
  teamspaceFindMany: vi.fn(),
  chatThreadFindMany: vi.fn(),
  calendarEventFindMany: vi.fn(),
  calendarFeedFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  ticketCount: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    teamspace: { findMany: db.teamspaceFindMany },
    chatThread: { findMany: db.chatThreadFindMany },
    calendarEvent: { findMany: db.calendarEventFindMany },
    calendarFeed: { findMany: db.calendarFeedFindMany },
    project: { findMany: db.projectFindMany },
    ticket: { count: db.ticketCount },
  },
}));

import { getWorkspaceShellDatasets } from "./workspace-shell";

const SECRET_BODY = "CONFIDENTIAL-ACQUISITION-BODY";
const SECRET_TOKEN = "SECRET-ICS-TOKEN";
const SECRET_TEAMSPACE = "SECRET-TEAMSPACE-NAME";

const CHAT_THREAD = {
  id: "thread-1",
  title: "Acquisition plan",
  pageId: null,
  page: null,
  messages: [
    {
      id: "message-1",
      body: SECRET_BODY,
      role: "user",
      meta: null,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      user: { name: "Owner", email: "owner@example.test" },
    },
  ],
};

const CALENDAR_FEED = {
  id: "feed-1",
  name: "Personal calendar",
  icsUrl: `https://calendar.example.test/feed.ics?token=${SECRET_TOKEN}`,
  color: "blue",
  _count: { events: 3 },
};

const CALENDAR_EVENT = {
  id: "event-1",
  title: "Sprint review",
  start: new Date("2026-01-03T10:00:00.000Z"),
  end: new Date("2026-01-03T11:00:00.000Z"),
  allDay: false,
  location: null,
  url: null,
  notesPageId: null,
  feed: { name: "Personal calendar", color: "blue" },
};

const PROJECT = {
  id: "project-1",
  name: "Roadmap",
  icon: "📈",
  summary: null,
  description: null,
  status: "ACTIVE",
  color: null,
  startDate: null,
  dueDate: null,
  milestones: [],
  _count: { pages: 0 },
};

/** The teamspace a page of the guest's scope lives in. */
const TEAMSPACE = {
  id: "teamspace-1",
  name: "Engineering",
  icon: "⚙️",
  members: [{ userId: "user-1" }],
};

/** Another teamspace of the workspace — outside the guest's scope. */
const OTHER_TEAMSPACE = {
  id: "teamspace-2",
  name: SECRET_TEAMSPACE,
  icon: null,
  members: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.teamspaceFindMany.mockResolvedValue([TEAMSPACE, OTHER_TEAMSPACE]);
  db.chatThreadFindMany.mockResolvedValue([CHAT_THREAD]);
  db.calendarEventFindMany.mockResolvedValue([CALENDAR_EVENT]);
  db.calendarFeedFindMany.mockResolvedValue([CALENDAR_FEED]);
  db.projectFindMany.mockResolvedValue([PROJECT]);
  db.ticketCount.mockResolvedValue(42);
});

describe("getWorkspaceShellDatasets — a guest", () => {
  it("returns nothing but the teamspaces of their own scope", async () => {
    const datasets = await getWorkspaceShellDatasets({
      workspaceId: "ws1",
      role: "GUEST",
      visibleTeamspaceIds: new Set(["teamspace-1"]),
    });

    expect(datasets).toEqual({
      teamspaces: [{ id: "teamspace-1", name: "Engineering", icon: "⚙️" }],
      chatThreads: [],
      meetingEvents: [],
      calendarFeeds: [],
      projects: [],
      openTickets: 0,
    });
    expect(JSON.stringify(datasets)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(datasets)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(datasets)).not.toContain(SECRET_TEAMSPACE);
  });

  it("fails closed when the guest's teamspace scope is missing", async () => {
    const datasets = await getWorkspaceShellDatasets({
      workspaceId: "ws1",
      role: "GUEST",
      visibleTeamspaceIds: null,
    });

    expect(datasets.teamspaces).toEqual([]);
    expect(JSON.stringify(datasets)).not.toContain(SECRET_TEAMSPACE);
  });

  it("queries the teamspaces with the guest's scope", async () => {
    await getWorkspaceShellDatasets({
      workspaceId: "ws1",
      role: "GUEST",
      visibleTeamspaceIds: new Set(["teamspace-1"]),
    });

    const [args] = db.teamspaceFindMany.mock.calls[0] as [
      { where: { id?: { in: string[] } } },
    ];
    expect(args.where.id).toEqual({ in: ["teamspace-1"] });
  });

  it("does not query the datasets it may not show", async () => {
    await getWorkspaceShellDatasets({
      workspaceId: "ws1",
      role: "GUEST",
      visibleTeamspaceIds: new Set(["teamspace-1"]),
    });

    expect(db.chatThreadFindMany).not.toHaveBeenCalled();
    expect(db.calendarFeedFindMany).not.toHaveBeenCalled();
    expect(db.calendarEventFindMany).not.toHaveBeenCalled();
    expect(db.projectFindMany).not.toHaveBeenCalled();
    expect(db.ticketCount).not.toHaveBeenCalled();
  });
});

describe("getWorkspaceShellDatasets — a member", () => {
  it("returns the workspace's rows", async () => {
    const datasets = await getWorkspaceShellDatasets({
      workspaceId: "ws1",
      role: "MEMBER",
      visibleTeamspaceIds: null,
    });

    expect(datasets.teamspaces).toEqual([
      { id: "teamspace-1", name: "Engineering", icon: "⚙️" },
      { id: "teamspace-2", name: SECRET_TEAMSPACE, icon: null },
    ]);
    expect(datasets.projects).toEqual([{ id: "project-1", name: "Roadmap", icon: "📈" }]);
    expect(datasets.openTickets).toBe(42);
    expect(datasets.chatThreads).toHaveLength(1);
    expect(datasets.chatThreads[0].messages[0].body).toBe(SECRET_BODY);
    expect(datasets.meetingEvents).toHaveLength(1);
  });

  it("keeps the private calendar feed URL off the payload", async () => {
    const datasets = await getWorkspaceShellDatasets({
      workspaceId: "ws1",
      role: "MEMBER",
      visibleTeamspaceIds: null,
    });

    expect(datasets.calendarFeeds).toEqual([
      { id: "feed-1", name: "Personal calendar", color: "blue", _count: { events: 3 } },
    ]);
    expect(datasets.calendarFeeds[0]).not.toHaveProperty("icsUrl");
    expect(JSON.stringify(datasets)).not.toContain(SECRET_TOKEN);

    // The URL is not even read out of the database for this listing.
    const [args] = db.calendarFeedFindMany.mock.calls[0] as [{ select: Record<string, boolean> }];
    expect(args.select).not.toHaveProperty("icsUrl");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * B54 — the workspace shell must not carry the workspace's private rows into
 * the RSC payload of a guest.
 *
 * The layout renders the workspace shell, a **client** component tree: every
 * prop it hands over travels to the browser in the flight payload. It used to
 * hand over the chat log (with its message bodies), the calendar feeds
 * (including the private `icsUrl`, the address of a personal calendar that
 * often carries a secret token in its path), the open-ticket count, the project
 * list and the teamspace names — without ever asking the viewer's role, so a
 * guest received all of them.
 *
 * These tests render the layout exactly as the router does and read the props
 * that reach the client boundary: that object *is* the payload. A guest must
 * find none of the private rows in it, and a member must still find them (the
 * shell has to keep working) — with the feed URL left on the server.
 *
 * The teamspaces are the one row that is *scoped* rather than withheld: a
 * guest may see the name of a teamspace their own page hangs under (the
 * sidebar draws a page under the section of its teamspace and drops a root
 * whose teamspace is not listed — with an empty list the page that was shared
 * with the guest disappeared from the tree). The workspace's other teamspaces
 * stay out of the payload.
 */

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  workspaceFindMany: vi.fn(),
  workspaceMemberFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
  favoriteFindMany: vi.fn(),
  notificationCount: vi.fn(),
  chatThreadFindMany: vi.fn(),
  calendarEventFindMany: vi.fn(),
  calendarFeedFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  ticketCount: vi.fn(),
}));

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique, findMany: db.workspaceFindMany },
    workspaceMember: { findUnique: db.workspaceMemberFindUnique },
    page: { findMany: db.pageFindMany },
    pagePermission: { findMany: db.pagePermissionFindMany },
    teamspace: { findMany: db.teamspaceFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
    favorite: { findMany: db.favoriteFindMany },
    notification: { count: db.notificationCount },
    chatThread: { findMany: db.chatThreadFindMany },
    calendarEvent: { findMany: db.calendarEventFindMany },
    calendarFeed: { findMany: db.calendarFeedFindMany },
    project: { findMany: db.projectFindMany },
    ticket: { count: db.ticketCount },
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));

// The AI configuration is not part of this finding; the layout only reads the
// model name out of it.
vi.mock("@/lib/ai-provider", () => ({ resolveAiConfig: vi.fn(async () => null) }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  usePathname: () => "/w/acme",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children }: { href: string; children?: ReactNode }) =>
      h("a", { href }, children ?? null),
  };
});

vi.mock("@/components/ui/tooltip", async () => {
  const { createElement: h } = await import("react");
  return {
    TooltipProvider: ({ children }: { children?: ReactNode }) => h("div", null, children ?? null),
    Tooltip: ({ children }: { children?: ReactNode }) => h("div", null, children ?? null),
  };
});

// The client boundary is stubbed: the props it is handed *are* the payload, so
// the stub keeps the test off the whole client tree. The sidebar tree itself is
// rendered for real further down — it is what the payload is for.
vi.mock("@/components/workspace-shell", () => ({
  WorkspaceShell: () => null,
}));

import WorkspaceLayout from "./layout";
import { PageTree } from "@/components/sidebar/page-tree";
import type { PageTreeNode } from "@/server/queries";

/** The viewer the layout resolves. */
const GUEST = {
  id: "user-guest",
  email: "guest@example.test",
  name: "Guest",
  avatarUrl: null,
  theme: "light",
  locale: "en",
};

const WORKSPACE = {
  id: "ws1",
  name: "Acme",
  slug: "acme",
  icon: null,
  ownerId: "user-owner",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/* The secrets a guest must never receive. */
const SECRET_BODY = "CONFIDENTIAL-ACQUISITION-BODY";
const SECRET_TOKEN = "SECRET-ICS-TOKEN";
const SECRET_PROJECT = "SECRET-PROJECT-NAME";
const SECRET_TEAMSPACE = "SECRET-TEAMSPACE-NAME";
const SECRET_EVENT = "SECRET-EVENT-TITLE";

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
  title: SECRET_EVENT,
  start: new Date("2026-01-03T10:00:00.000Z"),
  end: new Date("2026-01-03T11:00:00.000Z"),
  allDay: false,
  location: "Room 2",
  url: null,
  notesPageId: null,
  feed: { name: "Personal calendar", color: "blue" },
};

const PROJECT = {
  id: "project-1",
  name: SECRET_PROJECT,
  icon: null,
  summary: null,
  description: null,
  status: "ACTIVE",
  color: null,
  startDate: null,
  dueDate: null,
  milestones: [],
  _count: { pages: 0 },
};

/** The teamspace the guest's shared page hangs under — the guest may see it. */
const TEAMSPACE = {
  id: "teamspace-1",
  name: "Marketing",
  icon: "📣",
  members: [],
};

/** Another teamspace of the workspace — the guest has no business seeing it. */
const OTHER_TEAMSPACE = {
  id: "teamspace-2",
  name: SECRET_TEAMSPACE,
  icon: null,
  members: [],
};

/**
 * The tree of the workspace: a teamspace root and the page that was shared
 * with the guest underneath it.
 */
const TREE_ROWS: PageTreeNode[] = [
  {
    id: "ts-root",
    parentId: null,
    teamspaceId: "teamspace-1",
    title: "Marketing hub",
    icon: null,
    type: "PAGE",
    position: 0,
    isFavorite: false,
  },
  {
    id: "shared-page",
    parentId: "ts-root",
    teamspaceId: "teamspace-1",
    title: "Shared with the guest",
    icon: null,
    type: "PAGE",
    position: 0,
    isFavorite: false,
  },
];

/** The props the layout hands to the client shell. */
type ShellProps = {
  chatThreads: { id: string; messages: { body: string }[] }[];
  meetingEvents: { id: string; title: string }[];
  calendarFeeds: { id: string; name: string; color: string; _count: { events: number } }[];
  projects: { id: string; name: string; icon: string | null }[];
  teamspaces: { id: string; name: string; icon: string | null }[];
  openTickets: number;
  tree: PageTreeNode[];
};

/** Render the layout and read back the props that reach the client. */
async function renderShell(): Promise<ShellProps> {
  const element = await WorkspaceLayout({
    params: Promise.resolve({ slug: "acme" }),
    children: null,
  });
  return (element as { props: unknown }).props as ShellProps;
}

/** Render the sidebar tree the guest receives. */
function renderTree(props: ShellProps): string {
  return renderToStaticMarkup(
    createElement(PageTree, {
      tree: props.tree,
      teamspaces: props.teamspaces,
      projects: [],
      workspace: { id: "ws1", slug: "acme", role: "GUEST" },
      locale: "en",
      expanded: new Set<string>(["ts-root"]),
      setExpanded: () => {},
      pending: false,
      addPage: () => {},
      discuss: () => {},
      startTransition: () => {},
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue(GUEST);
  db.workspaceFindUnique.mockResolvedValue(WORKSPACE);
  db.workspaceFindMany.mockResolvedValue([WORKSPACE]);
  db.workspaceMemberFindUnique.mockResolvedValue({ role: "GUEST" });
  // `page.findMany` serves three callers: the guest scope (its own pages, then
  // the workspace's pages) and the page tree (the only one selecting `title`).
  db.pageFindMany.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
    const select = args?.select ?? {};
    if (select.title) return TREE_ROWS;
    if (select.teamspaceId) {
      return [
        { id: "ts-root", parentId: null, teamspaceId: "teamspace-1" },
        { id: "shared-page", parentId: "ts-root", teamspaceId: "teamspace-1" },
      ];
    }
    return [];
  });
  // The page that was shared with the guest — the guest is not a member of any
  // teamspace, so this grant is the only reason they see anything.
  db.pagePermissionFindMany.mockResolvedValue([{ pageId: "shared-page" }]);
  db.teamspaceMemberFindMany.mockResolvedValue([]);
  db.favoriteFindMany.mockResolvedValue([]);
  db.notificationCount.mockResolvedValue(0);
  db.teamspaceFindMany.mockResolvedValue([TEAMSPACE, OTHER_TEAMSPACE]);
  db.chatThreadFindMany.mockResolvedValue([CHAT_THREAD]);
  db.calendarEventFindMany.mockResolvedValue([CALENDAR_EVENT]);
  db.calendarFeedFindMany.mockResolvedValue([CALENDAR_FEED]);
  db.projectFindMany.mockResolvedValue([PROJECT]);
  db.ticketCount.mockResolvedValue(42);
});

describe("workspace layout — the payload a guest receives", () => {
  it("carries none of the workspace's private rows", async () => {
    const props = await renderShell();

    expect(props.chatThreads).toEqual([]);
    expect(props.calendarFeeds).toEqual([]);
    expect(props.meetingEvents).toEqual([]);
    expect(props.projects).toEqual([]);
    expect(props.openTickets).toBe(0);

    const payload = JSON.stringify(props);
    expect(payload).not.toContain(SECRET_BODY);
    expect(payload).not.toContain(SECRET_TOKEN);
    expect(payload).not.toContain(SECRET_PROJECT);
    expect(payload).not.toContain(SECRET_EVENT);
  });

  it("carries the teamspaces of the guest's own pages — and only those", async () => {
    const props = await renderShell();

    // The teamspace the shared page hangs under is part of the guest's scope:
    // the tree draws a root inside the section of its teamspace.
    expect(props.teamspaces).toEqual([
      { id: "teamspace-1", name: "Marketing", icon: "📣" },
    ]);

    // The workspace's other teamspace is not: its name never travels.
    expect(JSON.stringify(props)).not.toContain(SECRET_TEAMSPACE);
  });

  it("queries the teamspaces with the guest's scope", async () => {
    await renderShell();

    const [args] = db.teamspaceFindMany.mock.calls[0] as [
      { where: { id?: { in: string[] } } },
    ];
    expect(args.where.id).toEqual({ in: ["teamspace-1"] });
  });

  it("does not even query the datasets a guest may not see", async () => {
    await renderShell();

    expect(db.chatThreadFindMany).not.toHaveBeenCalled();
    expect(db.calendarFeedFindMany).not.toHaveBeenCalled();
    expect(db.calendarEventFindMany).not.toHaveBeenCalled();
    expect(db.projectFindMany).not.toHaveBeenCalled();
    expect(db.ticketCount).not.toHaveBeenCalled();
  });

  it("keeps the page that was shared with the guest in the sidebar tree", async () => {
    const props = await renderShell();
    const html = renderTree(props);

    // The teamspace root and the shared page underneath it.
    expect(html).toContain('data-page-id="ts-root"');
    expect(html).toContain('data-page-id="shared-page"');
  });
});

describe("workspace layout — the payload a member receives", () => {
  beforeEach(() => {
    db.workspaceMemberFindUnique.mockResolvedValue({ role: "MEMBER" });
  });

  it("still carries the rows the shell renders", async () => {
    const props = await renderShell();

    expect(props.chatThreads).toHaveLength(1);
    expect(props.chatThreads[0].messages[0].body).toBe(SECRET_BODY);
    expect(props.projects.map((project) => project.name)).toEqual([SECRET_PROJECT]);
    expect(props.meetingEvents.map((event) => event.title)).toEqual([SECRET_EVENT]);
    expect(props.openTickets).toBe(42);
  });

  it("still carries every teamspace of the workspace", async () => {
    const props = await renderShell();

    expect(props.teamspaces.map((teamspace) => teamspace.name)).toEqual([
      "Marketing",
      SECRET_TEAMSPACE,
    ]);
  });

  it("keeps the private calendar feed URL on the server", async () => {
    const props = await renderShell();

    expect(props.calendarFeeds).toEqual([
      { id: "feed-1", name: "Personal calendar", color: "blue", _count: { events: 3 } },
    ]);
    expect(props.calendarFeeds[0]).not.toHaveProperty("icsUrl");
    expect(JSON.stringify(props)).not.toContain(SECRET_TOKEN);

    // The URL is not even read out of the database for this listing.
    const [args] = db.calendarFeedFindMany.mock.calls[0] as [{ select: Record<string, boolean> }];
    expect(args.select).not.toHaveProperty("icsUrl");
  });
});

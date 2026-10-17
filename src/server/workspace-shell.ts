/**
 * The workspace shell's datasets, scoped for the viewer.
 *
 * The workspace layout renders the shell, a **client** component tree: every
 * prop it hands over travels to the browser in the RSC payload. This module is
 * the one place that decides what the shell may see, so a row can only reach
 * the client after it has been scoped for the viewer's role.
 *
 * Two kinds of scoping apply:
 *
 *  - **Page-scoped rows** (the page tree, the favourites) follow the guest
 *    scope of `@/lib/guest-access`: a guest sees the pages that were shared
 *    with them, and nothing else.
 *  - **Workspace-scoped rows** (the chat log, the calendar feeds and their
 *    events, the projects, the open-ticket count) are not shared page by page,
 *    so they follow the role check of `@/lib/permissions`: a guest may not read
 *    them at all and gets empty sets — and none of the queries behind them run.
 *
 * The teamspaces are the one workspace-scoped row with a page-scoped answer: a
 * guest may see the names of the teamspaces their own pages live in (the
 * scope), because the sidebar draws a page under the section of its teamspace
 * and would drop a branch whose teamspace is not listed. The workspace's other
 * teamspace names stay out of the payload.
 *
 * The private calendar feed URL (`icsUrl`) never appears in the payload: it is
 * the address of a personal calendar and often carries a secret token in its
 * path. The server reads the feed itself; the client only ever sees the
 * events that were materialised from it.
 */

import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canEditContent } from "@/lib/permissions";
import {
  getCalendarFeeds,
  getChatThreadsWithMessages,
  getProjects,
  getTeamspaces,
  getUpcomingEvents,
} from "@/server/queries";

/** A teamspace as the shell shows it. */
export type ShellTeamspace = { id: string; name: string; icon: string | null };

/** A project as the shell shows it. */
export type ShellProject = { id: string; name: string; icon: string | null };

/** A calendar subscription as the shell shows it — never the feed URL. */
export type ShellCalendarFeed = {
  id: string;
  name: string;
  color: string;
  _count: { events: number };
};

/** A chat message as the shell shows it. */
export type ShellChatMessage = {
  id: string;
  body: string;
  role?: string;
  createdAt: Date;
  meta?: unknown;
  user: { name: string; email: string } | null;
};

/** A discussion as the shell shows it. */
export type ShellChatThread = {
  id: string;
  title: string;
  pageId: string | null;
  page: { id: string; title: string; icon: string | null } | null;
  messages: ShellChatMessage[];
};

/** An upcoming event as the shell shows it. */
export type ShellMeetingEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  location: string | null;
  url: string | null;
  notesPageId: string | null;
  feed: { name: string; color: string } | null;
};

/** Everything the shell reads from the workspace besides the page tree. */
export type WorkspaceShellDatasets = {
  teamspaces: ShellTeamspace[];
  chatThreads: ShellChatThread[];
  meetingEvents: ShellMeetingEvent[];
  calendarFeeds: ShellCalendarFeed[];
  projects: ShellProject[];
  openTickets: number;
};

/** One discussion row, as the chat query returns it. */
type ChatThreadRow = Awaited<ReturnType<typeof getChatThreadsWithMessages>>[number];

/**
 * Project one discussion row onto the shape the shell renders. The projection
 * is explicit, so a column added to the chat query later cannot slip into the
 * payload by accident.
 */
function toShellThread(thread: ChatThreadRow): ShellChatThread {
  return {
    id: thread.id,
    title: thread.title,
    pageId: thread.pageId,
    page: thread.page
      ? { id: thread.page.id, title: thread.page.title, icon: thread.page.icon }
      : null,
    messages: thread.messages.map((message) => ({
      id: message.id,
      body: message.body,
      role: message.role,
      createdAt: message.createdAt,
      meta: message.meta ?? undefined,
      user: message.user ? { name: message.user.name, email: message.user.email } : null,
    })),
  };
}

/**
 * The workspace shell's datasets for one viewer.
 *
 * A viewer who may not edit content (a guest) gets empty sets and a zero
 * ticket count, and the queries behind them are never run — the workspace's
 * chat log, calendars, projects and tickets are not shared page by page, so
 * there is nothing to narrow them down to. The teamspaces are the exception:
 * they are *page* scoped for a guest (the scope names the teamspaces the
 * guest's own pages live in), and the sidebar needs those names to render the
 * branches the guest may see. Everybody else gets the workspace's rows,
 * projected onto the shapes the shell renders.
 */
export async function getWorkspaceShellDatasets(input: {
  workspaceId: string;
  /** The viewer's effective role in the workspace. */
  role: WorkspaceRole;
  /**
   * The viewer's teamspace scope (see `viewerScopeFor` in `@/lib/guest-access`):
   * the ids of the teamspaces whose names the viewer may see. `null` = every
   * teamspace of the workspace (a member). A guest must always get a set — a
   * missing scope fails closed and yields no teamspace at all.
   */
  visibleTeamspaceIds: Set<string> | null;
}): Promise<WorkspaceShellDatasets> {
  const { workspaceId, role, visibleTeamspaceIds } = input;

  if (!canEditContent(role)) {
    const teamspaces = await getTeamspaces(
      workspaceId,
      visibleTeamspaceIds ?? new Set<string>(),
    );
    return {
      teamspaces: teamspaces.map((teamspace) => ({
        id: teamspace.id,
        name: teamspace.name,
        icon: teamspace.icon,
      })),
      chatThreads: [],
      meetingEvents: [],
      calendarFeeds: [],
      projects: [],
      openTickets: 0,
    };
  }

  const [teamspaces, chatThreads, meetingEvents, calendarFeeds, projects, openTickets] =
    await Promise.all([
      getTeamspaces(workspaceId, visibleTeamspaceIds),
      getChatThreadsWithMessages(workspaceId),
      getUpcomingEvents(workspaceId),
      getCalendarFeeds(workspaceId),
      getProjects(workspaceId),
      prisma.ticket.count({
        where: {
          workspaceId,
          archived: false,
          status: { notIn: ["done", "cancelled"] },
        },
      }),
    ]);

  return {
    teamspaces: teamspaces.map((teamspace) => ({
      id: teamspace.id,
      name: teamspace.name,
      icon: teamspace.icon,
    })),
    chatThreads: chatThreads.map(toShellThread),
    meetingEvents: meetingEvents.map((event) => ({
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      location: event.location,
      url: event.url,
      notesPageId: event.notesPageId,
      feed: event.feed ? { name: event.feed.name, color: event.feed.color } : null,
    })),
    calendarFeeds: calendarFeeds.map((feed) => ({
      id: feed.id,
      name: feed.name,
      color: feed.color,
      _count: { events: feed._count.events },
    })),
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      icon: project.icon,
    })),
    openTickets,
  };
}

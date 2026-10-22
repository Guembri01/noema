/**
 * Notifications, webhook deliveries, chat discussions and calendar feeds.
 *
 * Extracted from src/server/queries.ts; callers keep importing from
 * @/server/queries through the re-export barrel.
 */
import { prisma } from "@/lib/db";

export async function getNotifications(userId: string, take = 50) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function getUnreadNotificationCount(userId: string) {
  return prisma.notification.count({ where: { userId, read: false } });
}

export async function getRecentWebhookDeliveries(workspaceId: string, take = 15) {
  return prisma.webhookDelivery.findMany({
    where: { webhook: { workspaceId } },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      event: true,
      ok: true,
      responseStatus: true,
      attempts: true,
      error: true,
      createdAt: true,
      webhook: { select: { url: true } },
    },
  });
}


// ---------------------------------------------------------------------------
// Chat (workspace discussions)
// ---------------------------------------------------------------------------

export async function getChatThreads(workspaceId: string, take = 50) {
  return prisma.chatThread.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    take,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      createdBy: { select: { id: true, name: true } },
      _count: { select: { messages: true } },
    },
  });
}

export async function getChatThread(threadId: string) {
  return prisma.chatThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      title: true,
      workspaceId: true,
      createdById: true,
      messages: {
        orderBy: { createdAt: "asc" },
        take: 200,
        select: {
          id: true,
          body: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Calendar (ICS subscriptions)
// ---------------------------------------------------------------------------

/**
 * The workspace's subscribed calendars, as a client sees them.
 *
 * The feed URL itself (`icsUrl`) is deliberately *not* selected: it is the
 * private address of a personal calendar and often carries a secret token in
 * its path, so it never leaves the server — the server reads the feed itself
 * (`refreshCalendarFeedsAction`).
 */
export async function getCalendarFeeds(workspaceId: string) {
  return prisma.calendarFeed.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      color: true,
      _count: { select: { events: true } },
    },
  });
}

export async function getUpcomingEvents(workspaceId: string, take = 25) {
  const from = new Date(Date.now() - 12 * 60 * 60 * 1000);
  return prisma.calendarEvent.findMany({
    where: { workspaceId, start: { gte: from } },
    orderBy: { start: "asc" },
    take,
    select: {
      id: true,
      title: true,
      start: true,
      end: true,
      allDay: true,
      location: true,
      url: true,
      notesPageId: true,
      feed: { select: { name: true, color: true } },
    },
  });
}
/** Threads with their recent messages, for the sidebar chat panel. */
export async function getChatThreadsWithMessages(workspaceId: string, take = 20) {
  return prisma.chatThread.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    take,
    select: {
      id: true,
      title: true,
      pageId: true,
      page: { select: { id: true, title: true, icon: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        take: 50,
        select: {
          id: true,
          body: true,
          role: true,
          meta: true,
          createdAt: true,
          user: { select: { name: true, email: true } },
        },
      },
    },
  });
}


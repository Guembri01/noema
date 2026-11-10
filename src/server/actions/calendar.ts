"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { isAllowedFeedUrl, normalizeFeedUrl, parseIcsEvents } from "@/lib/ics";
// H4 SSRF: same guard pattern as the link-preview route
// (src/app/api/link-preview/route.ts:44-46), extended with DNS + redirect
// re-validation - see src/lib/feed-guard.ts.
import { safeFetchFeed } from "@/lib/feed-guard";
import { templateContent } from "@/lib/templates";

export type CalendarResult<T = unknown> = ({ ok: true } & T) | { error: string };

const MAX_FEED_BYTES = 2_000_000;

/**
 * One message for every read failure - blocked private target, network error
 * or non-2xx - so the connector never leaks a status oracle (audit H4).
 */
const FEED_READ_ERROR = "Could not read that calendar feed.";

/** Subscribe to an iCalendar feed and materialise its upcoming events. */
export async function connectCalendarFeedAction(input: {
  workspaceId: string;
  name: string;
  icsUrl: string;
}): Promise<CalendarResult<{ id: string; imported: number }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to connect a calendar." };
  }

  const url = normalizeFeedUrl(input.icsUrl);
  if (!isAllowedFeedUrl(url)) {
    return { error: "Enter a valid http(s) or webcal calendar URL." };
  }

  const response = await safeFetchFeed(url, {
    headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response?.ok) {
    return { error: FEED_READ_ERROR };
  }
  const body = await response.text();
  if (body.length > MAX_FEED_BYTES) {
    return { error: "That calendar feed is too large." };
  }

  const events = parseIcsEvents(body).slice(0, 500);
  if (events.length === 0) {
    return { error: "No events were found in that calendar." };
  }

  const feed = await prisma.calendarFeed.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name.trim().slice(0, 80) || "Calendar",
      icsUrl: url,
    },
    select: { id: true },
  });

  let imported = 0;
  for (const event of events) {
    await prisma.calendarEvent.upsert({
      where: { workspaceId_uid: { workspaceId: input.workspaceId, uid: event.uid } },
      create: {
        workspaceId: input.workspaceId,
        feedId: feed.id,
        uid: event.uid,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        location: event.location,
        url: event.url,
      },
      update: {
        feedId: feed.id,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        location: event.location,
        url: event.url,
      },
    });
    imported += 1;
  }

  revalidatePath("/w", "layout");
  return { ok: true, id: feed.id, imported };
}

/** Re-read every subscribed feed and refresh its events. */
export async function refreshCalendarFeedsAction(
  workspaceId: string,
): Promise<CalendarResult<{ refreshed: number }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to refresh calendars." };
  }
  const feeds = await prisma.calendarFeed.findMany({
    where: { workspaceId },
    select: { id: true, icsUrl: true },
  });

  let refreshed = 0;
  for (const feed of feeds) {
    const response = await safeFetchFeed(feed.icsUrl, {
      headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.5" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response?.ok) continue;
    const events = parseIcsEvents(await response.text()).slice(0, 500);
    for (const event of events) {
      await prisma.calendarEvent.upsert({
        where: { workspaceId_uid: { workspaceId, uid: event.uid } },
        create: {
          workspaceId,
          feedId: feed.id,
          uid: event.uid,
          title: event.title,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          location: event.location,
          url: event.url,
        },
        update: {
          title: event.title,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          location: event.location,
          url: event.url,
        },
      });
      refreshed += 1;
    }
  }

  revalidatePath("/w", "layout");
  return { ok: true, refreshed };
}

/** Remove a calendar subscription (cascades to its events). */
export async function disconnectCalendarFeedAction(
  feedId: string,
): Promise<CalendarResult> {
  const user = await requireUser();
  const feed = await prisma.calendarFeed.findUnique({
    where: { id: feedId },
    select: { workspaceId: true },
  });
  if (!feed) return { error: "Calendar not found." };
  const access = await getWorkspaceAccess(user.id, feed.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to remove this calendar." };
  }
  await prisma.calendarFeed.delete({ where: { id: feedId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Create (or open) the meeting-notes page attached to a calendar event. */
export async function createMeetingNoteAction(
  eventId: string,
): Promise<CalendarResult<{ id: string; slug: string; existing: boolean }>> {
  const user = await requireUser();
  const event = await prisma.calendarEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      notesPageId: true,
      start: true,
    },
  });
  if (!event) return { error: "Event not found." };
  const access = await getWorkspaceAccess(user.id, event.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create a page." };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: event.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  if (event.notesPageId) {
    const existing = await prisma.page.findUnique({
      where: { id: event.notesPageId },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt) {
      return { ok: true, id: existing.id, slug: workspace.slug, existing: true };
    }
  }

  const last = await prisma.page.findFirst({
    where: { workspaceId: event.workspaceId, parentId: null },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const date = event.start.toISOString().slice(0, 10);
  const content = templateContent("meeting");

  // CAS claim (P2-T03): two concurrent accepts of a `notesPageId: null` event
  // must not both materialise a note page. Create the candidate page, then
  // claim the event with ONE conditional updateMany (`where notesPageId:
  // null`) — the claim value IS the new page id, so page-first beats claim-
  // first-with-placeholder. `count === 0` means another call won the race:
  // the loser deletes its just-created page inside the same transaction and
  // reuses the winner's page below.
  const claim = await prisma.$transaction(async (tx) => {
    const page = await tx.page.create({
      data: {
        workspaceId: event.workspaceId,
        title: `${event.title} — ${date}`,
        icon: "📅",
        createdById: user.id,
        position: (last?.position ?? 0) + 1000,
        content: { type: "doc", content } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const cas = await tx.calendarEvent.updateMany({
      where: { id: event.id, notesPageId: null },
      data: { notesPageId: page.id },
    });
    if (cas.count === 0) {
      // Lost the race: undo the loser page before the commit.
      await tx.page.delete({ where: { id: page.id } });
      return null;
    }
    return page.id;
  });

  let id: string;
  let existing: boolean;
  if (claim !== null) {
    id = claim;
    existing = false;
  } else {
    // Reuse the winner's page: the losing updateMany only happens when the
    // event row already pointed elsewhere (or was deleted concurrently).
    const winner = await prisma.calendarEvent.findUnique({
      where: { id: event.id },
      select: { notesPageId: true },
    });
    if (!winner?.notesPageId) return { error: "Event not found." };
    id = winner.notesPageId;
    existing = true;
  }

  revalidatePath("/w", "layout");
  return { ok: true, id, slug: workspace.slug, existing };
}

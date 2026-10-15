import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/api-guard";
import { buildCalendar, type CalendarEventInput } from "@/lib/ics";
import { getCalendarFeeds, getUpcomingEvents } from "@/server/queries";
import {
  connectCalendarFeedAction,
  createMeetingNoteAction,
  disconnectCalendarFeedAction,
  refreshCalendarFeedsAction,
} from "@/server/actions/calendar";

export const runtime = "nodejs";

const CALENDAR_PRODID = "-//Noema//Calendar//EN";

/** Shape of the dated rows returned by {@link getUpcomingEvents}. */
type UpcomingEvent = Awaited<ReturnType<typeof getUpcomingEvents>>[number];

/**
 * Map a stored calendar event onto the RFC 5545 export shape. All-day rows use
 * a bare `YYYY-MM-DD` (UTC calendar date) so the builder emits `VALUE=DATE`;
 * timed rows keep the full ISO 8601 instant and are rendered as UTC.
 */
function toCalendarEvent(event: UpcomingEvent): CalendarEventInput {
  const iso = (value: Date): string =>
    event.allDay ? value.toISOString().slice(0, 10) : value.toISOString();
  return {
    uid: `cal-${event.id}@noema`,
    start: iso(event.start),
    end: event.end ? iso(event.end) : undefined,
    allDay: event.allDay,
    summary: event.title,
    location: event.location ?? undefined,
    url: event.url ?? undefined,
  };
}

/**
 * List calendar subscriptions and upcoming events for a workspace.
 *
 * Pass `?format=ics` to instead download the workspace's dated rows as an
 * `text/calendar` (RFC 5545) document. The feed *import* path is unaffected;
 * export reuses the same auth, rate limit and workspace-access checks.
 */
export async function GET(request: Request) {
  const limited = rateLimit(request, "calendar-read", 120, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const workspaceId = params.get("workspaceId") ?? "";
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  if (params.get("format") === "ics") {
    const events = await getUpcomingEvents(workspaceId);
    const calendar = buildCalendar(events.map(toCalendarEvent), {
      prodId: CALENDAR_PRODID,
      now: new Date(),
    });
    return new NextResponse(calendar, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="calendar.ics"',
      },
    });
  }

  const [feeds, events] = await Promise.all([
    getCalendarFeeds(workspaceId),
    getUpcomingEvents(workspaceId),
  ]);
  return NextResponse.json({ feeds, events });
}

/**
 * Calendar mutations. Body:
 *   { action: "connect",  workspaceId, name, icsUrl }
 *   { action: "refresh",  workspaceId }
 *   { action: "disconnect", feedId }
 *   { action: "notes",    eventId }
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "calendar-write", 30, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    action?: string;
    workspaceId?: string;
    feedId?: string;
    eventId?: string;
    name?: string;
    icsUrl?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  let result: { ok: true } & Record<string, unknown> | { error: string };
  switch (body.action) {
    case "connect":
      result = await connectCalendarFeedAction({
        workspaceId: String(body.workspaceId ?? ""),
        name: String(body.name ?? ""),
        icsUrl: String(body.icsUrl ?? ""),
      });
      break;
    case "refresh":
      result = await refreshCalendarFeedsAction(String(body.workspaceId ?? ""));
      break;
    case "disconnect":
      result = await disconnectCalendarFeedAction(String(body.feedId ?? ""));
      break;
    case "notes":
      result = await createMeetingNoteAction(String(body.eventId ?? ""));
      break;
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

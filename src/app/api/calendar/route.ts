import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/api-guard";
import { getCalendarFeeds, getUpcomingEvents } from "@/server/queries";
import {
  connectCalendarFeedAction,
  createMeetingNoteAction,
  disconnectCalendarFeedAction,
  refreshCalendarFeedsAction,
} from "@/server/actions/calendar";

export const runtime = "nodejs";

/** List calendar subscriptions and upcoming events for a workspace. */
export async function GET(request: Request) {
  const limited = rateLimit(request, "calendar-read", 120, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

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

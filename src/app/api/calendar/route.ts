import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/api-guard";
import { prisma } from "@/lib/db";
import { buildCalendar, type CalendarEventInput } from "@/lib/ics";
import {
  applyPull,
  applyPush,
  computeSyncPlan,
  describeSyncPlan,
  fromIcsEvent,
  nextSyncToken,
  type ExternalEvent,
  type SyncDirection,
  type SyncOp,
} from "@/lib/calendar-sync";
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

/* ---------------------------------------------------------------------- */
/* Two-way sync model (calendar-sync)                                     */
/* ---------------------------------------------------------------------- */

/** A persisted calendar row projected onto the sync engine's event shape. */
function toExternalEvent(row: {
  uid: string;
  title: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  createdAt: Date;
}): ExternalEvent {
  const start = row.start.toISOString();
  const end = (row.end ?? row.start).toISOString();
  // The engine keys change detection on `etag`, so derive a stable content
  // fingerprint; a no-op write keeps the etag (and the plan) identical.
  const etag = [row.title, start, end, row.allDay ? "1" : "0"].join("|");
  return {
    id: row.uid,
    etag,
    updatedAt: row.createdAt.toISOString(),
    summary: row.title,
    start,
    end,
    allDay: row.allDay,
  };
}

/** Coerce a client-supplied direction to the engine's vocabulary. */
function parseDirection(value: unknown): SyncDirection {
  return value === "push" || value === "pull" || value === "both" ? value : "both";
}

/** Read a remote snapshot from ICS markup (VEVENT blocks), skipping garbage. */
function remoteFromIcs(ics: string): ExternalEvent[] {
  const events: ExternalEvent[] = [];
  const blocks = ics.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];
  for (const block of blocks) {
    const parsed = fromIcsEvent(block);
    if (parsed) events.push(parsed);
  }
  return events;
}

/** Shape-check a JSON-supplied remote snapshot into the engine's events. */
function remoteFromJson(value: unknown): ExternalEvent[] {
  if (!Array.isArray(value)) return [];
  const events: ExternalEvent[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") continue;
    if (typeof record.start !== "string" || typeof record.summary !== "string") continue;
    const end = typeof record.end === "string" && record.end !== "" ? record.end : record.start;
    events.push({
      id: record.id,
      etag: typeof record.etag === "string" ? record.etag : `${record.summary}|${record.start}`,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : record.start,
      summary: record.summary,
      start: record.start,
      end,
      allDay: record.allDay === true,
    });
  }
  return events;
}

/** Persist the plan's pull operations onto the workspace's local events. */
async function persistPullOps(workspaceId: string, ops: readonly SyncOp[]): Promise<number> {
  let applied = 0;
  for (const operation of ops) {
    if (operation.op === "delete") {
      await prisma.calendarEvent.deleteMany({ where: { workspaceId, uid: operation.eventId } });
      applied += 1;
      continue;
    }
    const payload = operation.payload;
    if (!payload) continue;
    const start = new Date(payload.start);
    const end = new Date(payload.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    await prisma.calendarEvent.upsert({
      where: { workspaceId_uid: { workspaceId, uid: payload.id } },
      create: {
        workspaceId,
        uid: payload.id,
        title: payload.summary,
        start,
        end,
        allDay: payload.allDay,
      },
      update: { title: payload.summary, start, end, allDay: payload.allDay },
    });
    applied += 1;
  }
  return applied;
}

/**
 * Reconcile the workspace's local events against a caller-supplied remote
 * snapshot (`remoteIcs` or `remote`) through the pure two-way planner. The
 * plan, its summary and the next sync token are always returned; when `apply`
 * is set the pull operations are persisted to `CalendarEvent` (a push has no
 * provider to write back, so the planned push is returned for the caller).
 */
async function handleSync(body: {
  workspaceId?: string;
  direction?: string;
  lastSyncAt?: string;
  remoteIcs?: string;
  remote?: unknown;
  apply?: boolean;
}): Promise<NextResponse> {
  const workspaceId = String(body.workspaceId ?? "");
  if (workspaceId === "") {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  // Calendar events are not page-scoped, so a `GUEST` — an external
  // collaborator with access to a few shared pages — may not read them at all.
  if (!canEditContent(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const direction = parseDirection(body.direction);
  const apply = body.apply === true;

  const rows = await prisma.calendarEvent.findMany({
    where: { workspaceId },
    select: { uid: true, title: true, start: true, end: true, allDay: true, createdAt: true },
    orderBy: { uid: "asc" },
  });
  const local = rows.map(toExternalEvent);

  const remote =
    typeof body.remoteIcs === "string" && body.remoteIcs !== ""
      ? remoteFromIcs(body.remoteIcs)
      : remoteFromJson(body.remote);

  const lastSyncAt =
    typeof body.lastSyncAt === "string" && body.lastSyncAt !== ""
      ? body.lastSyncAt
      : new Date(0).toISOString();

  const plan = computeSyncPlan({
    local,
    remote,
    state: { calendarId: workspaceId, lastSyncAt, direction },
  });

  const appliedPull = apply ? await persistPullOps(workspaceId, plan.pull) : 0;

  return NextResponse.json({
    ok: true,
    direction,
    applied: apply,
    appliedPull,
    summary: describeSyncPlan(plan),
    nextSyncToken: nextSyncToken(plan),
    // The local/remote projections after the plan, so a caller can persist a
    // push on the provider side and see the reconciled local set.
    local: applyPull(local, plan),
    push: applyPush(remote, plan),
    plan,
  });
}

/**
 * List calendar subscriptions and upcoming events for a workspace.
 *
 * Pass `?format=ics` to instead download the workspace's dated rows as an
 * `text/calendar` (RFC 5545) document. The feed *import* path is unaffected;
 * export reuses the same auth, rate limit and workspace-access checks.
 *
 * Calendar events are not page-scoped, so a `GUEST` gets a 403.
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
  // Calendar events are not page-scoped, so a `GUEST` — an external
  // collaborator with access to a few shared pages — may not read them at all.
  if (!canEditContent(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
 *   { action: "sync",     workspaceId, direction?, lastSyncAt?, remoteIcs? | remote?, apply? }
 *
 * The `sync` action drives the two-way model in `@/lib/calendar-sync`: it diffs
 * the workspace's stored events against a remote snapshot (ICS markup or a
 * JSON array of events) and returns the plan, summary and next sync token.
 * With `apply: true` the pull operations are persisted locally.
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
    direction?: string;
    lastSyncAt?: string;
    remoteIcs?: string;
    remote?: unknown;
    apply?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action === "sync") {
    return handleSync(body);
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

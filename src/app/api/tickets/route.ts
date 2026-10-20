import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/api-guard";
import {
  bodyReadError,
  MAX_JSON_BODY_BYTES,
  readJsonBody,
} from "@/lib/body-limit";
import { getLabels, getTicketsCursorPage } from "@/server/queries";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import {
  addTicketCommentAction,
  archiveTicketAction,
  bulkArchiveTicketsAction,
  bulkDeleteTicketsAction,
  bulkUpdateTicketsAction,
  createLabelAction,
  createTicketAction,
  deleteLabelAction,
  deleteTicketAction,
  linkTicketsAction,
  moveTicketAction,
  ticketFromPageAction,
  toggleTicketLabelAction,
  unlinkTicketAction,
  updateLabelAction,
  updateTicketAction,
  type TicketSlaInput,
} from "@/server/actions/tickets";
import type { SlaPolicy } from "@/lib/sla-timer";
import type { WorkingHours } from "@/lib/business-hours";

export const runtime = "nodejs";

/** A finite SLA window in minutes, or `undefined` when the value is unusable. */
function slaMinutes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A validated UTC working calendar, or `undefined` when the value cannot
 * describe business time. The engine tolerates partial configs, but an
 * unusable one silently collapses the deadline to the creation instant, so
 * anything malformed is dropped here and the SLA falls back to wall-clock.
 */
function readWorkingHours(raw: unknown): WorkingHours | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const startMinutes = source.startMinutes;
  const endMinutes = source.endMinutes;
  if (
    typeof startMinutes !== "number" ||
    typeof endMinutes !== "number" ||
    !Number.isInteger(startMinutes) ||
    !Number.isInteger(endMinutes) ||
    startMinutes < 0 ||
    endMinutes > 1440 ||
    startMinutes >= endMinutes
  ) {
    return undefined;
  }
  const days = Array.isArray(source.days)
    ? (source.days as unknown[]).filter(
        (day): day is number =>
          typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6,
      )
    : [];
  if (days.length === 0) return undefined;
  const hours: WorkingHours = { days, startMinutes, endMinutes };
  if (Array.isArray(source.holidays)) {
    hours.holidays = (source.holidays as unknown[]).filter(
      (key): key is string => typeof key === "string",
    );
  }
  return hours;
}

/**
 * The optional `sla` policy from a ticket create/update body as a
 * {@link TicketSlaInput}, or `undefined` when absent or malformed. Per-field
 * degradation mirrors the engine: an unusable optional part (`kind`,
 * `workingHours`) is dropped rather than failing the whole write, and a policy
 * without its two windows is treated as no SLA at all.
 */
function readSla(raw: unknown): TicketSlaInput | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const policySource = source.policy;
  if (!policySource || typeof policySource !== "object" || Array.isArray(policySource)) {
    return undefined;
  }
  const policyRaw = policySource as Record<string, unknown>;
  const responseMinutes = slaMinutes(policyRaw.responseMinutes);
  const resolveMinutes = slaMinutes(policyRaw.resolveMinutes);
  if (responseMinutes === undefined || resolveMinutes === undefined) return undefined;
  const policy: SlaPolicy = { responseMinutes, resolveMinutes };
  const warnAtPercent = slaMinutes(policyRaw.warnAtPercent);
  if (warnAtPercent !== undefined) policy.warnAtPercent = warnAtPercent;

  const sla: TicketSlaInput = { policy };
  const kind = source.kind;
  if (kind === "response" || kind === "resolve") sla.kind = kind;
  const workingHours = readWorkingHours(source.workingHours);
  if (workingHours) sla.workingHours = workingHours;
  return sla;
}

/**
 * List tickets (and their labels) for a workspace.
 *
 * Tickets are not page-scoped, so a `GUEST` — an external collaborator with
 * access to a few shared pages — may not list them at all: the workspace
 * tickets are a full member's view (the server actions enforce the same rule,
 * for the reads and the writes).
 */
export async function GET(request: Request) {
  const limited = rateLimit(request, "tickets-read", 120, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = new URL(request.url).searchParams;
  const workspaceId = searchParams.get("workspaceId") ?? "";
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  if (!canEditContent(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pageSize = searchParams.get("page_size");
  if (pageSize !== null && pageSize.trim() !== "" && !Number.isFinite(Number(pageSize))) {
    return NextResponse.json({ error: "invalid_page_size" }, { status: 400 });
  }
  const limit = clampLimit(pageSize, { min: 1, max: 100, fallback: 50 });
  const cursor = searchParams.get("start_cursor");
  if (cursor !== null && cursor !== "" && decodeCursor(cursor) === null) {
    return NextResponse.json(malformedCursorResult(), { status: 400 });
  }

  const [page, labels] = await Promise.all([
    getTicketsCursorPage(workspaceId, {
      limit,
      cursor,
      includeArchived: searchParams.get("archived") === "true",
    }),
    getLabels(workspaceId),
  ]);
  return NextResponse.json({
    tickets: page.items,
    labels,
    role: access.role,
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
  });
}

/**
 * Ticket mutations. Body: `{ action, … }`
 *   create · update · label · unlabel · relation · unlink · comment · archive ·
 *   delete · bulk · bulkArchive · bulkDelete · move · from-page · label-create ·
 *   label-update · label-delete
 * The same server actions back the UI. `create` and `update` also accept an
 * optional `sla` (`{ policy, kind?, workingHours? }`) that derives `dueDate`
 * server-side; omit it and the body/response behaviour is unchanged.
 *
 * Every action resolves the ticket's workspace itself and refuses a `GUEST`
 * (tickets are not page-scoped), so the transport needs no extra role check.
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "tickets-write", 60, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Invalid JSON body.");
  }

  const str = (key: string) => (body[key] === undefined || body[key] === null ? undefined : String(body[key]));
  const num = (key: string) => (typeof body[key] === "number" ? (body[key] as number) : undefined);
  const list = (key: string) => (Array.isArray(body[key]) ? (body[key] as string[]).map(String) : undefined);

  let result: { ok: true } & Record<string, unknown> | { error: string };
  switch (body.action) {
    case "create":
      result = await createTicketAction({
        workspaceId: String(body.workspaceId ?? ""),
        title: String(body.title ?? ""),
        description: str("description"),
        type: str("type"),
        status: str("status"),
        priority: str("priority"),
        estimate: num("estimate") ?? (body.estimate === null ? null : undefined),
        estimateUnit: str("estimateUnit"),
        startDate: str("startDate") ?? (body.startDate === null ? null : undefined),
        dueDate: str("dueDate") ?? (body.dueDate === null ? null : undefined),
        projectId: str("projectId") ?? (body.projectId === null ? null : undefined),
        milestoneId: str("milestoneId") ?? (body.milestoneId === null ? null : undefined),
        assigneeId: str("assigneeId") ?? (body.assigneeId === null ? null : undefined),
        parentId: str("parentId") ?? (body.parentId === null ? null : undefined),
        labelIds: list("labelIds"),
        sla: readSla(body.sla),
      });
      break;
    case "update":
      result = await updateTicketAction({
        ticketId: String(body.ticketId ?? ""),
        title: str("title"),
        description: str("description"),
        type: str("type"),
        status: str("status"),
        priority: str("priority"),
        estimate: num("estimate") ?? (body.estimate === null ? null : undefined),
        estimateUnit: str("estimateUnit"),
        startDate: str("startDate") ?? (body.startDate === null ? null : undefined),
        dueDate: str("dueDate") ?? (body.dueDate === null ? null : undefined),
        projectId: str("projectId") ?? (body.projectId === null ? null : undefined),
        milestoneId: str("milestoneId") ?? (body.milestoneId === null ? null : undefined),
        assigneeId: str("assigneeId") ?? (body.assigneeId === null ? null : undefined),
        archived: typeof body.archived === "boolean" ? body.archived : undefined,
        sla: readSla(body.sla),
      });
      break;
    case "label":
      result = await toggleTicketLabelAction(String(body.ticketId ?? ""), String(body.labelId ?? ""));
      break;
    case "relation":
      result = await linkTicketsAction({
        fromId: String(body.fromId ?? ""),
        toId: String(body.toId ?? ""),
        type: str("type"),
      });
      break;
    case "unlink":
      result = await unlinkTicketAction(String(body.relationId ?? ""));
      break;
    case "comment":
      result = await addTicketCommentAction(String(body.ticketId ?? ""), String(body.body ?? ""));
      break;
    case "archive":
      result = await archiveTicketAction(
        String(body.ticketId ?? ""),
        body.archived === undefined ? true : Boolean(body.archived),
      );
      break;
    case "bulk":
      result = await bulkUpdateTicketsAction({
        ticketIds: list("ticketIds") ?? [],
        status: str("status"),
        priority: str("priority"),
        assigneeId: str("assigneeId") ?? (body.assigneeId === null ? null : undefined),
        projectId: str("projectId") ?? (body.projectId === null ? null : undefined),
        estimate: num("estimate") ?? (body.estimate === null ? null : undefined),
        estimateUnit: str("estimateUnit"),
        addLabelIds: list("addLabelIds"),
        removeLabelIds: list("removeLabelIds"),
      });
      break;
    case "bulkArchive":
      result = await bulkArchiveTicketsAction({
        ticketIds: list("ticketIds") ?? [],
        archived: body.archived === undefined ? true : Boolean(body.archived),
      });
      break;
    case "bulkDelete":
      result = await bulkDeleteTicketsAction({ ticketIds: list("ticketIds") ?? [] });
      break;
    case "delete":
      result = await deleteTicketAction(String(body.ticketId ?? ""));
      break;
    case "move":
      result = await moveTicketAction({
        ticketId: String(body.ticketId ?? ""),
        status: String(body.status ?? ""),
        beforeId: str("beforeId") ?? null,
      });
      break;
    case "from-page":
      result = await ticketFromPageAction(String(body.pageId ?? ""));
      break;
    case "label-create":
      result = await createLabelAction({
        workspaceId: String(body.workspaceId ?? ""),
        name: String(body.name ?? ""),
        color: str("color"),
        description: str("description"),
      });
      break;
    case "label-update":
      result = await updateLabelAction({
        labelId: String(body.labelId ?? ""),
        name: str("name"),
        color: str("color"),
        description: str("description") ?? (body.description === null ? null : undefined),
      });
      break;
    case "label-delete":
      result = await deleteLabelAction(String(body.labelId ?? ""));
      break;
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

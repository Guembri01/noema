import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/api-guard";
import { getLabels, getTicketsCursorPage } from "@/server/queries";
import { clampLimit, decodeCursor, malformedCursorResult } from "@/lib/cursor-pagination";
import {
  addTicketCommentAction,
  archiveTicketAction,
  bulkUpdateTicketsAction,
  createLabelAction,
  createTicketAction,
  deleteLabelAction,
  linkTicketsAction,
  moveTicketAction,
  ticketFromPageAction,
  toggleTicketLabelAction,
  unlinkTicketAction,
  updateLabelAction,
  updateTicketAction,
} from "@/server/actions/tickets";

export const runtime = "nodejs";

/** List tickets (and their labels) for a workspace. */
export async function GET(request: Request) {
  const limited = rateLimit(request, "tickets-read", 120, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = new URL(request.url).searchParams;
  const workspaceId = searchParams.get("workspaceId") ?? "";
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

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
 *   bulk · move · from-page · label-create · label-update · label-delete
 * The same server actions back the UI.
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "tickets-write", 60, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
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
      });
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

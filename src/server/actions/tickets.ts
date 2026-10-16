"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { parsePageContent } from "@/lib/validation";
import { DESCRIPTION_MAX, descriptionDoc, sanitizeDescription } from "@/lib/description";
import { getTicketDetail, getTicketsPage } from "@/server/queries";
import type { TicketActivityRow } from "@/components/tickets/ticket-drawer";
import { addBusinessHours, type WorkingHours } from "@/lib/business-hours";
import { computeSlaDue, type SlaKind, type SlaPolicy } from "@/lib/sla-timer";
import {
  RELATION_TYPES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  isClosed,
  keyPrefix,
  normalizeLabelInput,
  ticketKey,
  toTrackerTicket,
  type TrackerTicket,
} from "@/lib/tickets";

export type TicketResult<T = unknown> = ({ ok: true } & T) | { error: string };

const STATUS_IDS = TICKET_STATUSES.map((status) => status.id as string);
const PRIORITY_IDS = TICKET_PRIORITIES.map((priority) => priority.id as string);
const TYPE_IDS = TICKET_TYPES.map((type) => type.id as string);
const RELATION_IDS = RELATION_TYPES.map((relation) => relation.id as string);

async function authorizeTicket(ticketId: string) {
  const user = await requireUser();
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      title: true,
      key: true,
      archived: true,
      createdAt: true,
    },
  });
  if (!ticket) return { ok: false as const, error: "Ticket not found." };
  const access = await getWorkspaceAccess(user.id, ticket.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { ok: false as const, error: "You do not have permission to edit tickets." };
  }
  return { ok: true as const, user, ticket };
}

async function logActivity(
  ticketId: string,
  actorId: string,
  kind: string,
  detail?: Record<string, unknown>,
) {
  await prisma.ticketActivity.create({
    data: { ticketId, actorId, kind, detail: (detail ?? undefined) as Prisma.InputJsonValue },
  });
}

// ---------------------------------------------------------------------------
// Labels (workspace level)
// ---------------------------------------------------------------------------

export async function createLabelAction(input: {
  workspaceId: string;
  name: string;
  color?: string;
  description?: string;
}): Promise<TicketResult<{ id: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to manage labels." };
  }
  const normalized = normalizeLabelInput(input);
  if (!normalized.ok) return { error: normalized.error };

  const existing = await prisma.label.findUnique({
    where: { workspaceId_name: { workspaceId: input.workspaceId, name: normalized.name } },
    select: { id: true },
  });
  if (existing) return { error: "That label already exists." };

  const label = await prisma.label.create({
    data: {
      workspaceId: input.workspaceId,
      name: normalized.name,
      color: normalized.color,
      description: normalized.description,
    },
    select: { id: true },
  });
  revalidatePath("/w", "layout");
  return { ok: true, id: label.id };
}

export async function updateLabelAction(input: {
  labelId: string;
  name?: string;
  color?: string;
  description?: string | null;
}): Promise<TicketResult> {
  const user = await requireUser();
  const label = await prisma.label.findUnique({
    where: { id: input.labelId },
    select: { workspaceId: true },
  });
  if (!label) return { error: "Label not found." };
  const access = await getWorkspaceAccess(user.id, label.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to manage labels." };
  }
  await prisma.label.update({
    where: { id: input.labelId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 40) || "Label" } : {}),
      ...(input.color ? { color: input.color.slice(0, 20) } : {}),
      ...(input.description !== undefined
        ? { description: input.description?.trim().slice(0, 200) || null }
        : {}),
    },
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}

export async function deleteLabelAction(labelId: string): Promise<TicketResult> {
  const user = await requireUser();
  const label = await prisma.label.findUnique({
    where: { id: labelId },
    select: { workspaceId: true },
  });
  if (!label) return { error: "Label not found." };
  const access = await getWorkspaceAccess(user.id, label.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "Only workspace admins can delete labels." };
  }
  await prisma.label.delete({ where: { id: labelId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** Wall-clock milliseconds in one hour (`computeSlaDue` ↔ `addBusinessHours`). */
const MS_PER_HOUR = 3_600_000;

/**
 * Optional SLA policy attached to a ticket write. The whole config is opt-in:
 * omit it and every action behaves byte-for-byte as before. When present the
 * server derives `dueDate` itself rather than trusting the caller's value.
 *
 * `computeSlaDue` turns the policy into a wall-clock deadline measured from the
 * ticket's creation instant; supplying `workingHours` then re-measures the same
 * budget on the team's office calendar via `addBusinessHours`, so weekends and
 * holidays stretch — not shrink — the deadline.
 */
export type TicketSlaInput = {
  /** Minute budgets for the response / resolve timers (see `SlaPolicy`). */
  policy: SlaPolicy;
  /** Which deadline lands on `dueDate`. Defaults to `"resolve"`. */
  kind?: SlaKind;
  /** UTC working calendar; when set the deadline skips closed hours. */
  workingHours?: WorkingHours;
};

/**
 * The due instant `sla` implies for a ticket created at `createdAt`, or `null`
 * when there is no policy, the timer is unconfigured, or the result is
 * unparseable — in which case the caller keeps its existing `dueDate` handling.
 */
function slaDueDate(sla: TicketSlaInput | undefined, createdAt: Date): Date | null {
  if (!sla) return null;
  const due = computeSlaDue(createdAt, sla.policy, { kind: sla.kind ?? "resolve" });
  if (!due) return null;
  if (!sla.workingHours) {
    return Number.isFinite(due.dueAt) ? new Date(due.dueAt) : null;
  }
  const stretched = addBusinessHours(createdAt, due.windowMs / MS_PER_HOUR, sla.workingHours);
  return Number.isFinite(stretched.getTime()) ? stretched : null;
}

export async function createTicketAction(input: {
  workspaceId: string;
  title: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  estimate?: number | null;
  estimateUnit?: string;
  startDate?: string | null;
  dueDate?: string | null;
  projectId?: string | null;
  milestoneId?: string | null;
  assigneeId?: string | null;
  parentId?: string | null;
  labelIds?: string[];
  /** Optional SLA policy; when set the server computes `dueDate` from it. */
  sla?: TicketSlaInput;
}): Promise<TicketResult<{ id: string; key: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create tickets." };
  }
  const title = input.title.trim().slice(0, 300);
  if (!title) return { error: "Give the ticket a title." };
  const status = STATUS_IDS.includes(input.status ?? "todo") ? input.status ?? "todo" : "todo";
  const priority = PRIORITY_IDS.includes(input.priority ?? "none") ? input.priority ?? "none" : "none";
  const type = TYPE_IDS.includes(input.type ?? "task") ? input.type ?? "task" : "task";
  const descriptionText = sanitizeDescription(input.description ?? "");

  // The SLA clock starts at creation; when no policy is supplied this is `null`
  // and `dueDate` keeps its existing caller-supplied behaviour.
  const slaDue = slaDueDate(input.sla, new Date());

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { name: true, ticketCounter: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  // Reserve the next number atomically so keys never collide.
  const bumped = await prisma.workspace.update({
    where: { id: input.workspaceId },
    data: { ticketCounter: { increment: 1 } },
    select: { ticketCounter: true },
  });
  const number = bumped.ticketCounter;
  const key = ticketKey(keyPrefix(workspace.name), number);

  const last = await prisma.ticket.findFirst({
    where: { workspaceId: input.workspaceId, status },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const ticket = await prisma.ticket.create({
    data: {
      workspaceId: input.workspaceId,
      number,
      key,
      title,
      description: descriptionText
        ? (descriptionDoc(descriptionText) as Prisma.InputJsonValue)
        : undefined,
      type,
      status,
      priority,
      estimate: typeof input.estimate === "number" && Number.isFinite(input.estimate) ? input.estimate : null,
      estimateUnit: input.estimateUnit ?? "points",
      startDate: input.startDate ? new Date(input.startDate) : null,
      dueDate: slaDue ?? (input.dueDate ? new Date(input.dueDate) : null),
      projectId: input.projectId ?? null,
      milestoneId: input.milestoneId ?? null,
      assigneeId: input.assigneeId ?? null,
      reporterId: user.id,
      parentId: input.parentId ?? null,
      position: (last?.position ?? 0) + 1000,
      ...(input.labelIds && input.labelIds.length > 0
        ? { labels: { create: input.labelIds.map((labelId) => ({ labelId })) } }
        : {}),
    },
    select: { id: true, key: true },
  });

  await logActivity(ticket.id, user.id, "created", { status, priority });
  revalidatePath("/w", "layout");
  return { ok: true, id: ticket.id, key: ticket.key };
}

export async function updateTicketAction(input: {
  ticketId: string;
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  estimate?: number | null;
  estimateUnit?: string;
  startDate?: string | null;
  dueDate?: string | null;
  projectId?: string | null;
  milestoneId?: string | null;
  assigneeId?: string | null;
  archived?: boolean;
  /** Optional SLA policy; when set the server recomputes `dueDate` from it. */
  sla?: TicketSlaInput;
}): Promise<TicketResult> {
  const auth = await authorizeTicket(input.ticketId);
  if (!auth.ok) return { error: auth.error };

  const changes: Record<string, unknown> = {};
  const data: Prisma.TicketUpdateInput = {};

  if (input.title !== undefined && input.title.trim() !== auth.ticket.title) {
    data.title = input.title.trim().slice(0, 300) || auth.ticket.title;
    changes.title = data.title;
  }
  if (input.description !== undefined) {
    const text = sanitizeDescription(input.description, DESCRIPTION_MAX);
    const parsed = parsePageContent(JSON.stringify(descriptionDoc(text)));
    if (parsed.ok) {
      data.description = parsed.doc as Prisma.InputJsonValue;
      changes.description = "updated";
    }
  }
  if (input.status !== undefined && STATUS_IDS.includes(input.status)) {
    if (input.status !== auth.ticket.status) {
      data.status = input.status;
      data.completedAt = isClosed(input.status) ? new Date() : null;
      changes.status = input.status;
    }
  }
  if (input.priority !== undefined && PRIORITY_IDS.includes(input.priority)) {
    data.priority = input.priority;
    changes.priority = input.priority;
  }
  if (input.type !== undefined && TYPE_IDS.includes(input.type)) {
    data.type = input.type;
    changes.type = input.type;
  }
  if (input.estimate !== undefined) {
    data.estimate =
      typeof input.estimate === "number" && Number.isFinite(input.estimate) ? input.estimate : null;
    changes.estimate = data.estimate;
  }
  if (input.estimateUnit !== undefined) data.estimateUnit = input.estimateUnit.slice(0, 12);
  if (input.startDate !== undefined) {
    data.startDate = input.startDate ? new Date(input.startDate) : null;
    changes.startDate = input.startDate;
  }
  if (input.dueDate !== undefined) {
    data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    changes.dueDate = input.dueDate;
  }
  if (input.projectId !== undefined) {
    data.project = input.projectId ? { connect: { id: input.projectId } } : { disconnect: true };
    changes.projectId = input.projectId;
  }
  if (input.milestoneId !== undefined) {
    data.milestone = input.milestoneId ? { connect: { id: input.milestoneId } } : { disconnect: true };
    changes.milestoneId = input.milestoneId;
  }
  if (input.assigneeId !== undefined) {
    data.assignee = input.assigneeId ? { connect: { id: input.assigneeId } } : { disconnect: true };
    changes.assigneeId = input.assigneeId;
  }
  if (input.archived !== undefined) {
    data.archived = input.archived;
    changes.archived = input.archived;
  }
  // An SLA policy owns `dueDate`, so it wins over any explicit value above; the
  // deadline is measured from the ticket's creation instant.
  if (input.sla) {
    const slaDue = slaDueDate(input.sla, auth.ticket.createdAt);
    if (slaDue) {
      data.dueDate = slaDue;
      changes.dueDate = slaDue.toISOString();
    }
  }

  if (Object.keys(data).length === 0) return { ok: true };

  await prisma.ticket.update({ where: { id: input.ticketId }, data });
  await logActivity(input.ticketId, auth.user.id, "updated", changes);
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Next page of tickets for the tracker's "Load more" (keyset pagination). */
export async function loadMoreTicketsAction(input: {
  workspaceId: string;
  cursor: string;
  take?: number;
}): Promise<{ ok: true; tickets: TrackerTicket[]; nextCursor: string | null } | { error: string }> {
  try {
    const user = await requireUser();
    const access = await getWorkspaceAccess(user.id, input.workspaceId);
    if (!access) return { error: "Workspace not found." };
    const page = await getTicketsPage(input.workspaceId, {
      take: input.take,
      cursor: input.cursor,
    });
    return {
      ok: true,
      tickets: page.tickets.map(toTrackerTicket),
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not load more tickets." };
  }
}

/**
 * One ticket's activity trail for the drawer's history section.
 *
 * The drawer opens on the client, so the selected ticket's history is fetched
 * on demand rather than shipped with every list page. Reuses the existing
 * `getTicketDetail` selection — `activity` is already newest-first and capped —
 * and returns exactly the shape the drawer's optional `activity` prop expects,
 * after checking the caller can read the ticket's workspace.
 */
export async function getTicketActivityAction(
  ticketId: string,
): Promise<TicketResult<{ activity: TicketActivityRow[] }>> {
  const user = await requireUser();
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { workspaceId: true },
  });
  if (!ticket) return { error: "Ticket not found." };
  const access = await getWorkspaceAccess(user.id, ticket.workspaceId);
  if (!access) return { error: "You do not have access to this ticket." };

  const detail = await getTicketDetail(ticketId);
  const activity: TicketActivityRow[] = (detail?.activity ?? []).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    detail: entry.detail,
    createdAt: entry.createdAt,
    actor: entry.actor,
  }));
  return { ok: true, activity };
}

/** Attach or detach a workspace label. */
export async function toggleTicketLabelAction(
  ticketId: string,
  labelId: string,
): Promise<TicketResult<{ attached: boolean }>> {
  const auth = await authorizeTicket(ticketId);
  if (!auth.ok) return { error: auth.error };

  const label = await prisma.label.findUnique({
    where: { id: labelId },
    select: { workspaceId: true, name: true },
  });
  if (!label || label.workspaceId !== auth.ticket.workspaceId) {
    return { error: "That label is not in this workspace." };
  }

  const existing = await prisma.ticketLabel.findUnique({
    where: { ticketId_labelId: { ticketId, labelId } },
    select: { id: true },
  });
  if (existing) {
    await prisma.ticketLabel.delete({ where: { id: existing.id } });
    await logActivity(ticketId, auth.user.id, "label_removed", { label: label.name });
    revalidatePath("/w", "layout");
    return { ok: true, attached: false };
  }
  await prisma.ticketLabel.create({ data: { ticketId, labelId } });
  await logActivity(ticketId, auth.user.id, "label_added", { label: label.name });
  revalidatePath("/w", "layout");
  return { ok: true, attached: true };
}

/** Link two tickets (blocks / blocked_by / relates / duplicates). */
export async function linkTicketsAction(input: {
  fromId: string;
  toId: string;
  type?: string;
}): Promise<TicketResult> {
  const auth = await authorizeTicket(input.fromId);
  if (!auth.ok) return { error: auth.error };
  if (input.fromId === input.toId) return { error: "A ticket cannot relate to itself." };
  const type = RELATION_IDS.includes(input.type ?? "relates") ? input.type ?? "relates" : "relates";

  const target = await prisma.ticket.findUnique({
    where: { id: input.toId },
    select: { workspaceId: true, key: true },
  });
  if (!target || target.workspaceId !== auth.ticket.workspaceId) {
    return { error: "That ticket is not in this workspace." };
  }

  await prisma.ticketRelation.upsert({
    where: { fromId_toId_type: { fromId: input.fromId, toId: input.toId, type } },
    create: { fromId: input.fromId, toId: input.toId, type },
    update: {},
  });
  await logActivity(input.fromId, auth.user.id, "relation_added", { type, ticket: target.key });
  revalidatePath("/w", "layout");
  return { ok: true };
}

export async function unlinkTicketAction(relationId: string): Promise<TicketResult> {
  const relation = await prisma.ticketRelation.findUnique({
    where: { id: relationId },
    select: { fromId: true },
  });
  if (!relation) return { error: "Relation not found." };
  const auth = await authorizeTicket(relation.fromId);
  if (!auth.ok) return { error: auth.error };
  await prisma.ticketRelation.delete({ where: { id: relationId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

export async function addTicketCommentAction(
  ticketId: string,
  body: string,
): Promise<TicketResult<{ id: string }>> {
  const auth = await authorizeTicket(ticketId);
  if (!auth.ok) return { error: auth.error };
  const text = body.trim();
  if (!text) return { error: "Write something first." };
  if (text.length > 4000) return { error: "That comment is too long." };

  const comment = await prisma.ticketComment.create({
    data: { ticketId, authorId: auth.user.id, body: text.slice(0, 4000) },
    select: { id: true },
  });
  await logActivity(ticketId, auth.user.id, "commented");
  revalidatePath("/w", "layout");
  return { ok: true, id: comment.id };
}

/**
 * Archive (soft delete) or restore a ticket.
 *
 * Idempotent: a ticket already in the target state is left untouched (no write,
 * no spurious `archived`/`restored` activity row) and still reports success, so
 * a double-click or a retried request cannot corrupt the archive history.
 */
export async function archiveTicketAction(
  ticketId: string,
  archived = true,
): Promise<TicketResult> {
  const auth = await authorizeTicket(ticketId);
  if (!auth.ok) return { error: auth.error };
  if (auth.ticket.archived === archived) return { ok: true };
  await prisma.ticket.update({ where: { id: ticketId }, data: { archived } });
  await logActivity(ticketId, auth.user.id, archived ? "archived" : "restored");
  revalidatePath("/w", "layout");
  return { ok: true };
}

/**
 * Bring an archived ticket back to the board.
 *
 * The un-archive half of {@link archiveTicketAction}, exposed under its own name
 * so restore has an explicit server entry point (and a stable symbol for the
 * archive view). It shares the same permission gate — `authorizeTicket`, i.e.
 * `canEditContent` — and the same idempotence, so restoring a live ticket is a
 * harmless no-op.
 */
export async function restoreTicketAction(ticketId: string): Promise<TicketResult> {
  return archiveTicketAction(ticketId, false);
}

/** Bulk edits from the board/list (status, priority, assignee, project). */
export async function bulkUpdateTicketsAction(input: {
  ticketIds: string[];
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  projectId?: string | null;
}): Promise<TicketResult<{ updated: number }>> {
  if (input.ticketIds.length === 0) return { ok: true, updated: 0 };
  const first = await prisma.ticket.findUnique({
    where: { id: input.ticketIds[0] },
    select: { workspaceId: true },
  });
  if (!first) return { error: "Ticket not found." };
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, first.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to edit tickets." };
  }

  const data: Prisma.TicketUncheckedUpdateManyInput = {};
  if (input.status && STATUS_IDS.includes(input.status)) {
    data.status = input.status;
    data.completedAt = isClosed(input.status) ? new Date() : null;
  }
  if (input.priority && PRIORITY_IDS.includes(input.priority)) data.priority = input.priority;
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
  if (input.projectId !== undefined) data.projectId = input.projectId;
  if (Object.keys(data).length === 0) return { ok: true, updated: 0 };

  const result = await prisma.ticket.updateMany({
    where: { id: { in: input.ticketIds }, workspaceId: first.workspaceId },
    data,
  });
  for (const ticketId of input.ticketIds) {
    await logActivity(ticketId, user.id, "bulk_updated", data as Record<string, unknown>);
  }
  revalidatePath("/w", "layout");
  return { ok: true, updated: result.count };
}

/** Board drag: move to a status column and reorder. */
export async function moveTicketAction(input: {
  ticketId: string;
  status: string;
  beforeId?: string | null;
}): Promise<TicketResult> {
  const auth = await authorizeTicket(input.ticketId);
  if (!auth.ok) return { error: auth.error };
  if (!STATUS_IDS.includes(input.status)) return { error: "Unknown status." };

  let position = 1000;
  if (input.beforeId) {
    const before = await prisma.ticket.findUnique({
      where: { id: input.beforeId },
      select: { position: true },
    });
    if (before) position = before.position - 1;
  } else {
    const last = await prisma.ticket.findFirst({
      where: { workspaceId: auth.ticket.workspaceId, status: input.status },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    position = (last?.position ?? 0) + 1000;
  }

  await prisma.ticket.update({
    where: { id: input.ticketId },
    data: {
      status: input.status,
      position,
      completedAt: isClosed(input.status) ? new Date() : null,
    },
  });
  if (input.status !== auth.ticket.status) {
    await logActivity(input.ticketId, auth.user.id, "status_changed", { to: input.status });
  }
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Create a ticket from an existing page (title + first paragraph). */
export async function ticketFromPageAction(
  pageId: string,
): Promise<TicketResult<{ id: string; key: string }>> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, title: true, content: true, workspaceId: true, projectId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create tickets." };
  }
  const { prosemirrorToText } = await import("@/lib/blocks");
  const created = await createTicketAction({
    workspaceId: page.workspaceId,
    title: page.title || "Untitled page",
    description: prosemirrorToText(page.content).slice(0, 4000),
    projectId: page.projectId,
  });
  return created;
}

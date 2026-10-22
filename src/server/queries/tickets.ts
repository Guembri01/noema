/**
 * Tickets, cycles, labels and the activity/audit feed.
 *
 * Extracted from src/server/queries.ts; callers keep importing from
 * @/server/queries through the re-export barrel.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { paginateSlice, type PaginateResult } from "@/lib/cursor-pagination";
import {
  normalizeAuditEvent,
  paginateAudit,
  SYSTEM_ACTOR_ID,
  type AuditEvent,
} from "@/lib/audit-log";

// ---------------------------------------------------------------------------
// Tickets (issues) & labels
// ---------------------------------------------------------------------------

export async function getLabels(workspaceId: string) {
  return prisma.label.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      color: true,
      description: true,
      _count: { select: { tickets: true } },
    },
  });
}

/**
 * A ticket may only show the name (and the e-mail address) of somebody who
 * belongs to its own workspace: the assignee picker offers exactly the
 * workspace's members, so a member of another workspace must not show up in
 * the tracker. The workspace's owner counts as being in it, even without a
 * membership row — the same rule `getWorkspaceAccess` applies.
 */
const assigneeInWorkspace = (workspaceId: string): Prisma.UserWhereInput => ({
  OR: [
    { memberships: { some: { workspaceId } } },
    { ownedWorkspaces: { some: { id: workspaceId } } },
  ],
});

/**
 * Columns the ticket tracker needs, shared by the list query and its pages.
 *
 * The relations are filtered by the workspace of the ticket: a row that points
 * at another workspace's project, user or parent must not be shown, even when
 * it was written before the write path checked it.
 */
const ticketListSelect = (workspaceId: string) =>
  ({
    id: true,
    key: true,
    number: true,
    title: true,
    description: true,
    type: true,
    status: true,
    priority: true,
    estimate: true,
    estimateUnit: true,
    startDate: true,
    dueDate: true,
    completedAt: true,
    updatedAt: true,
    parentId: true,
    cycleId: true,
    project: { where: { workspaceId }, select: { id: true, name: true, icon: true } },
    milestone: { select: { id: true, name: true } },
    assignee: {
      where: assigneeInWorkspace(workspaceId),
      select: { id: true, name: true, email: true },
    },
    labels: {
      where: { label: { workspaceId } },
      select: { label: { select: { id: true, name: true, color: true } } },
    },
    _count: { select: { children: { where: { workspaceId } }, comments: true } },
  }) as const;

export async function getTickets(
  workspaceId: string,
  filters: { includeArchived?: boolean } = {},
) {
  return prisma.ticket.findMany({
    where: { workspaceId, archived: filters.includeArchived ? undefined : false },
    orderBy: [{ position: "asc" }, { createdAt: "desc" }],
    take: 500,
    select: ticketListSelect(workspaceId),
  });
}

export async function getTicketViews(workspaceId: string) {
  return prisma.ticketView.findMany({
    where: { workspaceId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, config: true },
  });
}

/** Sprints: cycles with their tickets, newest first. */
export async function getCycles(workspaceId: string) {
  return prisma.cycle.findMany({
    where: { workspaceId },
    orderBy: { startDate: "desc" },
    select: {
      id: true,
      name: true,
      goal: true,
      startDate: true,
      endDate: true,
      tickets: {
        select: {
          id: true,
          key: true,
          title: true,
          status: true,
          priority: true,
          type: true,
          estimate: true,
          estimateUnit: true,
          startDate: true,
          dueDate: true,
          completedAt: true,
          updatedAt: true,
          assignee: {
            where: assigneeInWorkspace(workspaceId),
            select: { id: true, name: true },
          },
        },
      },
    },
  });
}

/** Recent workspace activity (audit trail) for the settings view. */
export async function getRecentActivity(workspaceId: string, take = 40) {
  return prisma.activity.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      action: true,
      targetType: true,
      targetId: true,
      meta: true,
      createdAt: true,
      actor: { select: { id: true, name: true, email: true } },
    },
  });
}

/** Internal scan cap for the cursor-paged activity feed (see follow-up: keyset in SQL). */
const ACTIVITY_PAGE_SCAN = 1000;

/**
 * Optional server-side narrowing for {@link getActivityPage}: the same axes the
 * pure `AuditFilter` in `@/lib/audit-log` exposes, pushed into the Prisma query
 * rather than applied to a fetched window.
 *
 * A present-but-empty `actorIds`/`types` matches nothing; an omitted axis is
 * unconstrained; `from`/`to` are inclusive and accept a `Date` or an ISO-8601
 * string. `actorIds` follows `normalizeAuditEvent`, so `SYSTEM_ACTOR_ID` also
 * keeps authorless rows (`actorId: null`).
 */
export type ActivityPageFilters = {
  actorIds?: readonly string[];
  types?: readonly string[];
  from?: Date | string;
  to?: Date | string;
};

/**
 * Translate {@link ActivityPageFilters} into an `Activity` predicate so the
 * narrowing happens in the database: a filtered page fills its
 * `ACTIVITY_PAGE_SCAN` window from matching rows only, instead of trimming a
 * workspace-wide window after the fact (which left filtered pages sparse).
 */
function activityWhere(
  workspaceId: string,
  filters: ActivityPageFilters,
): Prisma.ActivityWhereInput {
  const where: Prisma.ActivityWhereInput = { workspaceId };

  if (filters.actorIds !== undefined) {
    // `actorId` is nullable; the normaliser reports those rows as
    // `SYSTEM_ACTOR_ID`, so a filter naming it must keep `null` rows as well.
    const ids = [...filters.actorIds];
    where.OR = [
      { actorId: { in: ids.filter((id) => id !== SYSTEM_ACTOR_ID) } },
      ...(ids.includes(SYSTEM_ACTOR_ID) ? [{ actorId: null }] : []),
    ];
  }
  if (filters.types !== undefined) {
    where.action = { in: [...filters.types] };
  }
  if (filters.from !== undefined || filters.to !== undefined) {
    where.createdAt = {
      ...(filters.from !== undefined ? { gte: filters.from } : {}),
      ...(filters.to !== undefined ? { lte: filters.to } : {}),
    };
  }

  return where;
}

/**
 * One keyset page of a workspace's activity/audit feed, newest first.
 *
 * Additive companion to {@link getRecentActivity}: the same `Activity` rows, but
 * projected through the pure `@/lib/audit-log` reference implementation and
 * walked with the shared opaque `@/lib/cursor-pagination` dialect, so "Load more"
 * never re-reads the workspace and the boundary row is never repeated or skipped.
 * A row without a `targetId` falls back to its own id and a missing actor to
 * `SYSTEM_ACTOR_ID` (both via `normalizeAuditEvent`), so the feed never silently
 * drops an event. A malformed cursor fails closed (`items: []`, `hasMore: false`).
 *
 * Optional {@link ActivityPageFilters} (`actorIds`/`types`/`from`/`to`) are
 * applied to the Prisma query, so a filtered walk pages over matching rows only
 * instead of over-fetching then discarding — see `activityWhere`.
 */
export async function getActivityPage(
  workspaceId: string,
  options: { limit?: number; cursor?: string | null } & ActivityPageFilters = {},
): Promise<PaginateResult<AuditEvent>> {
  const rows = await prisma.activity.findMany({
    where: activityWhere(workspaceId, options),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ACTIVITY_PAGE_SCAN,
    select: {
      id: true,
      actorId: true,
      action: true,
      targetType: true,
      targetId: true,
      meta: true,
      createdAt: true,
    },
  });

  const events: AuditEvent[] = [];
  for (const row of rows) {
    const event = normalizeAuditEvent({
      id: row.id,
      actorId: row.actorId,
      type: row.action,
      entityId: row.targetId ?? row.id,
      entityType: row.targetType,
      createdAt: row.createdAt,
      meta: row.meta ?? undefined,
    });
    if (event !== null) events.push(event);
  }

  return paginateAudit(events, { limit: options.limit, cursor: options.cursor });
}

/**
 * One page of tickets for the tracker, ordered by board position.
 *
 * Keyset pagination on `id` (stable while tickets move), so "Load more" never
 * re-reads the whole workspace and never skips or repeats a row.
 */
export async function getTicketsPage(
  workspaceId: string,
  options: { take?: number; cursor?: string | null } = {},
) {
  const take = Math.min(Math.max(options.take ?? 100, 1), 200);
  const rows = await prisma.ticket.findMany({
    where: { workspaceId, archived: false },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: ticketListSelect(workspaceId),
  });
  const hasMore = rows.length > take;
  const tickets = hasMore ? rows.slice(0, take) : rows;
  return { tickets, nextCursor: hasMore ? (tickets[tickets.length - 1]?.id ?? null) : null };
}

/** Row shape of `GET /api/tickets`. */
export type ApiTicketRow = Awaited<ReturnType<typeof getTickets>>[number];

/**
 * One keyset page of a workspace's tickets ordered by the documented tuple
 * `(id)`, for the public `GET /api/tickets`. Mirrors `getTickets`'s select and
 * archived filter, but pages on the opaque cursor dialect rather than the
 * tracker's raw-id cursor.
 */
export async function getTicketsCursorPage(
  workspaceId: string,
  options: { limit?: number; cursor?: string | null; includeArchived?: boolean } = {},
): Promise<PaginateResult<ApiTicketRow>> {
  const rows = await prisma.ticket.findMany({
    where: { workspaceId, archived: options.includeArchived ? undefined : false },
    orderBy: [{ id: "asc" }],
    select: ticketListSelect(workspaceId),
  });
  return paginateSlice(rows, {
    limit: options.limit,
    cursor: options.cursor,
    direction: "asc",
    keyOf: (row) => ({ key: row.id, tiebreaker: row.id }),
  });
}

/**
 * One ticket in the tracker's list shape, scoped to its workspace.
 *
 * The tracker pages by board position (`getTicketsPage`), so the *last* page
 * holds the newest tickets - exactly the ones an assignment notice names. A deep
 * link therefore cannot assume the row it points at is on the first page, and
 * this is the single-row lookup that lets the drawer open anyway.
 */
export async function getTicketListRow(workspaceId: string, ticketId: string) {
  return prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId, archived: false },
    select: ticketListSelect(workspaceId),
  });
}

/** Tickets belonging to one project (project page rollup + Gantt). */export async function getProjectTickets(workspaceId: string, projectId: string) {
  return prisma.ticket.findMany({
    where: { workspaceId, projectId, archived: false },
    orderBy: [{ position: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      key: true,
      title: true,
      type: true,
      status: true,
      priority: true,
      estimate: true,
      estimateUnit: true,
      startDate: true,
      dueDate: true,
      assignee: {
        where: assigneeInWorkspace(workspaceId),
        select: { id: true, name: true },
      },
      labels: { select: { label: { select: { id: true, name: true, color: true } } } },
    },
  });
}

/**
 * One ticket in the tracker's detail shape, scoped to its workspace.
 *
 * The relations are filtered by that workspace as well: a project, an assignee
 * or a child ticket of another workspace must not be shown, even when the row
 * points at it (a write from before the write path checked it).
 */
export async function getTicketDetail(ticketId: string, workspaceId: string) {
  return prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId },
    select: {
      id: true,
      key: true,
      number: true,
      title: true,
      description: true,
      type: true,
      status: true,
      priority: true,
      estimate: true,
      estimateUnit: true,
      startDate: true,
      dueDate: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      archived: true,
      workspaceId: true,
      project: { where: { workspaceId }, select: { id: true, name: true, icon: true } },
      milestone: { select: { id: true, name: true, status: true } },
      assignee: {
        where: assigneeInWorkspace(workspaceId),
        select: { id: true, name: true, email: true },
      },
      reporter: { select: { id: true, name: true, email: true } },
      labels: {
        where: { label: { workspaceId } },
        select: { id: true, label: { select: { id: true, name: true, color: true } } },
      },
      children: {
        where: { workspaceId },
        select: { id: true, key: true, title: true, status: true },
      },
      relations: {
        select: {
          id: true,
          type: true,
          to: { select: { id: true, key: true, title: true, status: true } },
        },
      },
      relatedBy: {
        select: {
          id: true,
          type: true,
          from: { select: { id: true, key: true, title: true, status: true } },
        },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        take: 100,
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: { select: { id: true, name: true, email: true } },
        },
      },
      activity: {
        orderBy: { createdAt: "desc" },
        take: 40,
        select: {
          id: true,
          kind: true,
          detail: true,
          createdAt: true,
          actor: { select: { id: true, name: true } },
        },
      },
    },
  });
}

/** Per-project ticket counts and estimate totals (project page + chat tools). */
export async function getProjectTicketSummary(workspaceId: string) {
  const tickets = await prisma.ticket.findMany({
    where: { workspaceId, archived: false },
    select: {
      projectId: true,
      status: true,
      estimate: true,
      estimateUnit: true,
      dueDate: true,
    },
  });
  const summary = new Map<
    string,
    { total: number; open: number; estimate: number; unit: string; overdue: number }
  >();
  const now = Date.now();
  for (const ticket of tickets) {
    const key = ticket.projectId ?? "none";
    const entry =
      summary.get(key) ?? { total: 0, open: 0, estimate: 0, unit: "points", overdue: 0 };
    entry.total += 1;
    if (ticket.status !== "done" && ticket.status !== "cancelled") {
      entry.open += 1;
      if (ticket.estimate !== null) {
        entry.estimate += ticket.estimate;
        entry.unit = ticket.estimateUnit ?? "points";
      }
      if (ticket.dueDate && ticket.dueDate.getTime() < now) entry.overdue += 1;
    }
    summary.set(key, entry);
  }
  return summary;
}
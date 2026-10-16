/**
 * Server-side row source for the audit engine page. Reads the workspace's real
 * `Activity` rows (the model `logActivity` records to) and projects them onto
 * the engine's `ActivityRecord` shape; all filtering/ordering/paging is then
 * done by the pure `@/lib/audit-engine-query` module.
 *
 * The discrete filter axes (actor/action/category/target/date) are pushed into
 * the Prisma query so a filtered feed fills its window with matching rows rather
 * than over-fetching and discarding. The free-text `query` axis stays in memory
 * (the engine re-applies the whole filter), because it spans `meta`/target
 * fields that are not individually indexed.
 *
 * The scan is bounded (like the existing `getActivityPage`), so an audit page is
 * an in-memory engine pass over the newest {@link AUDIT_SCAN_LIMIT} matching
 * rows. Pushing the engine's exact keyset comparison into SQL is the follow-up
 * noted in the page.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AUDIT_ACTIONS, SYSTEM_ACTOR_ID, type AuditEventFilter } from "@/lib/audit-log-engine";
import type { ActivityRecord } from "@/lib/audit-engine-mapping";

/** Newest matching rows scanned for one in-memory engine pass. */
export const AUDIT_SCAN_LIMIT = 2000;

/** Translate the engine's discrete filter axes into an `Activity` predicate. */
export function auditActivityWhere(
  workspaceId: string,
  filter: AuditEventFilter,
): Prisma.ActivityWhereInput {
  const and: Prisma.ActivityWhereInput[] = [];

  if (filter.actorId !== undefined) {
    // `actorId` is nullable and the engine reports authorless rows as the
    // system actor, so naming it must keep `null` rows as well.
    and.push(filter.actorId === SYSTEM_ACTOR_ID ? { actorId: null } : { actorId: filter.actorId });
  }
  if (filter.action !== undefined) {
    and.push({ action: filter.action });
  } else if (filter.category !== undefined) {
    const actions = AUDIT_ACTIONS.filter((entry) => entry.category === filter.category).map(
      (entry) => entry.action,
    );
    // An empty catalogue slice is an explicit "none", matching nothing.
    and.push({ action: { in: actions } });
  }
  if (filter.targetType !== undefined) and.push({ targetType: filter.targetType });

  if (filter.from !== undefined || filter.to !== undefined) {
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (filter.from !== undefined) createdAt.gte = new Date(filter.from);
    if (filter.to !== undefined) createdAt.lte = new Date(filter.to);
    and.push({ createdAt });
  }

  return and.length > 0 ? { workspaceId, AND: and } : { workspaceId };
}

/**
 * The newest matching `Activity` rows for a workspace, newest first. Rows are
 * returned in the raw record shape the mapping module consumes (an absent
 * `meta` is normalised to `null`).
 */
export async function getAuditRecords(
  workspaceId: string,
  filter: AuditEventFilter = {},
): Promise<ActivityRecord[]> {
  const rows = await prisma.activity.findMany({
    where: auditActivityWhere(workspaceId, filter),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: AUDIT_SCAN_LIMIT,
    select: {
      id: true,
      workspaceId: true,
      actorId: true,
      action: true,
      targetType: true,
      targetId: true,
      meta: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({ ...row, meta: row.meta ?? null }));
}

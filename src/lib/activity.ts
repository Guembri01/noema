/**
 * Workspace activity trail.
 *
 * One write per meaningful mutation, so `/w/<slug>` can show "who did what"
 * without a separate audit service. Logging must never break the action it
 * describes, so failures are swallowed deliberately.
 */

import { prisma } from "@/lib/db";

export type ActivityAction =
  | "workspace.created"
  | "workspace.updated"
  | "workspace.deleted"
  | "member.role_changed"
  | "member.removed"
  | "member.left"
  | "member.ownership_transferred"
  | "sso.connection_created"
  | "sso.connection_updated"
  | "sso.connection_deleted"
  | "sso.domain_added"
  | "sso.domain_verified"
  | "sso.domain_deleted"
  | "page.created"
  | "page.archived"
  | "page.restored"
  | "page.deleted"
  | "page.shared"
  | "page.unshared"
  | "ticket.created"
  | "ticket.archived"
  | "label.created"
  | "label.deleted"
  | "cycle.created"
  | "cycle.deleted"
  | "comment.created"
  | "comment.edited"
  | "comment.resolved"
  | "comment.deleted"
  | "row.edited";

export async function logActivity(input: {
  workspaceId: string;
  actorId: string | null;
  action: ActivityAction;
  targetType: "workspace" | "page" | "ticket" | "label" | "comment" | "member";
  targetId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.activity.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        meta: (input.meta ?? undefined) as never,
      },
    });
  } catch {
    // An audit line must never break the mutation it records.
  }
}

"use server";

/**
 * Server half of "Move pages across workspaces" (docs/FEATURE_MATRIX.md
 * §Workspaces row; docs/MISSING_FEATURES.md §8). The plan itself is pure and
 * lives in `@/lib/workspace-move`; this module is the only production importer:
 * it loads the source subtree and both workspaces, runs the pure planner, then
 * writes the remapped pages and queued memberships in a single Prisma
 * transaction.
 *
 * Fail-closed at every step:
 *
 * - the caller must be able to edit the *source* workspace (`canEditContent`);
 * - the destination policy only admits `OWNER`/`ADMIN` (importing content also
 *   queues memberships), and every refusal reason is surfaced verbatim;
 * - the pure planner already drops every reference it cannot remap, so the
 *   write payload can never carry a dangling id into the target;
 * - the plan is re-validated (`validateMove`) immediately before the write.
 *
 * `"use server"` means every export here is an async function (or a type).
 * Pure, non-async helpers stay unexported; the plan→UI mapping and the Prisma
 * write payload are exercised through the exported actions instead.
 */

import { revalidatePath } from "next/cache";
import { PageType, WorkspaceRole } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { logActivity } from "@/lib/activity";
import { pageSearchText } from "@/lib/search";
import {
  checkAccess,
  collisionReport,
  planWorkspaceMove,
  summarizeMove,
  validateMove,
  type AccessCheckResult,
  type CollisionReportEntry,
  type MovePage,
  type MoveSummary,
  type MoveValidation,
  type TargetWorkspacePolicy,
  type WorkspaceMovePlan,
  type WorkspaceMoveWarning,
  type WorkspaceRoleLike,
} from "@/lib/workspace-move";

/**
 * Roles the destination workspace admits for an inbound move. Importing content
 * also queues memberships, so the move is gated to the roles that may manage
 * membership: owner and admin.
 */
const MOVE_IN_ROLES: readonly WorkspaceRoleLike[] = ["OWNER", "ADMIN"];

/** The policy every cross-workspace move is checked against. */
const MOVE_TARGET_POLICY: TargetWorkspacePolicy = {
  allowedRoles: MOVE_IN_ROLES,
  status: "active",
};

/** Plain-string role lookup, so the pure `checkAccess` input stays DB-free. */
const ROLE_LIKE: Record<string, WorkspaceRoleLike> = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
  GUEST: "GUEST",
};

/** Plain-string → Prisma enum, for the `WorkspaceMember` rows we queue. */
const MEMBERSHIP_ROLE: Record<string, WorkspaceRole> = {
  OWNER: WorkspaceRole.OWNER,
  ADMIN: WorkspaceRole.ADMIN,
  MEMBER: WorkspaceRole.MEMBER,
  GUEST: WorkspaceRole.GUEST,
};

/** Input for {@link previewWorkspaceMoveAction}. */
export type MovePreviewInput = {
  sourcePageId: string;
  targetWorkspaceId: string;
};

/** The whole preview a confirm screen renders: plan digest, warnings, refusals. */
export type WorkspaceMovePreview = {
  sourcePageId: string;
  sourcePageTitle: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  targetName: string;
  targetSlug: string;
  summary: MoveSummary;
  warnings: WorkspaceMoveWarning[];
  collisions: CollisionReportEntry[];
  access: AccessCheckResult;
  validation: MoveValidation;
  /**
   * True only when the move may be committed: the role is admitted, the plan is
   * internally consistent and at least one page moves. Collisions are advisory
   * (the schema allows duplicate titles) and never block a move.
   */
  canConfirm: boolean;
};

/** Outcome of {@link previewWorkspaceMoveAction}. */
export type WorkspaceMovePreviewResult =
  | ({ ok: true } & WorkspaceMovePreview)
  | { ok: false; error: string };

/** Input for {@link executeWorkspaceMoveAction}. */
export type MoveExecuteInput = {
  sourcePageId: string;
  targetWorkspaceId: string;
};

/** Outcome of {@link executeWorkspaceMoveAction}. */
export type WorkspaceMoveExecution =
  | {
      ok: true;
      moved: number;
      memberships: number;
      warningCount: number;
      targetName: string;
      targetSlug: string;
      /** New id of the moved root page, or `null` when nothing was written. */
      targetPageId: string | null;
    }
  | { error: string };

/** Everything both actions need, once the source subtree has been reached. */
type PreparedMove = {
  source: { id: string; title: string; workspaceId: string };
  target: { id: string; name: string; slug: string };
  plan: WorkspaceMovePlan;
  summary: MoveSummary;
  validation: MoveValidation;
  collisions: CollisionReportEntry[];
  access: AccessCheckResult;
};

type PrepareResult = { ok: true; prepared: PreparedMove } | { ok: false; error: string };

const PAGE_SELECT = {
  id: true,
  parentId: true,
  title: true,
  icon: true,
  coverUrl: true,
  type: true,
  content: true,
  position: true,
  fullWidth: true,
  smallText: true,
  font: true,
  lineSpacing: true,
  locked: true,
  schemaLocked: true,
  createdById: true,
} as const;

/** Live source pages, projected to what the planner remaps and the writer keeps. */
async function loadSourcePages(workspaceId: string): Promise<MovePage[]> {
  return prisma.page.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: PAGE_SELECT,
  });
}

/** The chosen page plus every descendant, as a flat id list. */
function subtreeIds(pages: readonly MovePage[], rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const page of pages) {
    if (typeof page.parentId !== "string" || page.parentId.length === 0) continue;
    const list = childrenByParent.get(page.parentId) ?? [];
    list.push(page.id);
    childrenByParent.set(page.parentId, list);
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    ids.push(current);
    for (const child of childrenByParent.get(current) ?? []) queue.push(child);
  }
  return ids;
}

function roleLike(role: string | null | undefined): WorkspaceRoleLike | null {
  if (!role) return null;
  return ROLE_LIKE[role] ?? null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Prisma's JSON input is stricter than `unknown`; null/undefined mean "absent". */
function jsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}

/**
 * The exact row the move writes for one planned page. Every id already comes
 * from the planner's id map (so parents and content references are remapped),
 * and a missing author falls back to the acting user — `Page.createdById` is
 * required and `Restrict`-ed, so a dropped author must never reach Prisma.
 */
function toPageCreateData(
  page: MovePage,
  workspaceId: string,
  fallbackAuthorId: string,
): Prisma.PageCreateManyInput {
  const title = typeof page.title === "string" ? page.title : "";
  const content = jsonInput(page.content);
  const createdById =
    typeof page.createdById === "string" && page.createdById.length > 0
      ? page.createdById
      : fallbackAuthorId;

  const data: Prisma.PageCreateManyInput = {
    id: page.id,
    workspaceId,
    // The planner remaps the parent into the moved set (or drops it to `null`),
    // so the parent is either a page that moves along — same target workspace —
    // or nothing. A foreign id is never written (B08).
    parentId: typeof page.parentId === "string" && page.parentId.length > 0 ? page.parentId : null,
    title,
    icon: asNullableString(page.icon),
    coverUrl: asNullableString(page.coverUrl),
    type: page.type === "DATABASE" ? PageType.DATABASE : PageType.PAGE,
    fullWidth: asBoolean(page.fullWidth),
    smallText: asBoolean(page.smallText),
    font: asString(page.font),
    lineSpacing: asString(page.lineSpacing),
    locked: asBoolean(page.locked),
    schemaLocked: asBoolean(page.schemaLocked),
    position: asNumber(page.position),
    createdById,
    searchText: pageSearchText(title, content ?? null),
  };
  if (content !== undefined) data.content = content;
  return data;
}

/**
 * Authorize the move and build its plan. Shared by preview and execute so the
 * confirm screen shows exactly what the write will do.
 */
async function prepareMove(
  userId: string,
  sourcePageId: string,
  targetWorkspaceId: string,
): Promise<PrepareResult> {
  const source = await prisma.page.findUnique({
    where: { id: sourcePageId },
    select: {
      id: true,
      title: true,
      workspaceId: true,
      deletedAt: true,
      permissions: {
        where: { userId },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!source || source.deletedAt) return { ok: false, error: "Page not found." };
  if (source.workspaceId === targetWorkspaceId) {
    return { ok: false, error: "That page is already in this workspace." };
  }

  const target = await prisma.workspace.findUnique({
    where: { id: targetWorkspaceId },
    select: { id: true, name: true, slug: true },
  });
  if (!target) return { ok: false, error: "Destination workspace not found." };

  const sourceAccess = await getWorkspaceAccess(userId, source.workspaceId);
  if (
    !sourceAccess ||
    !canEditContent(sourceAccess.role) ||
    !pageCapabilitiesFromRelation(sourceAccess.role, source.permissions).edit
  ) {
    return { ok: false, error: "You do not have permission to move this page." };
  }
  const targetAccess = await getWorkspaceAccess(userId, targetWorkspaceId);

  const pages = await loadSourcePages(source.workspaceId);
  const ids = subtreeIds(pages, sourcePageId);
  if (ids.length === 0) return { ok: false, error: "Page not found." };

  const [sourceMembers, targetMembers, targetPages] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId: source.workspaceId },
      select: { userId: true },
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: target.id },
      select: { userId: true },
    }),
    prisma.page.findMany({
      where: { workspaceId: target.id, deletedAt: null },
      select: { id: true, title: true },
    }),
  ]);

  const plan = planWorkspaceMove({
    pages,
    subtreeIds: ids,
    fromWorkspaceId: source.workspaceId,
    toWorkspaceId: target.id,
    membersFrom: sourceMembers.map((member) => member.userId),
    membersTo: targetMembers.map((member) => member.userId),
  });
  const summary = summarizeMove(plan);
  const validation = validateMove(plan);
  const collisions = collisionReport(plan.pages, targetPages);
  const access = checkAccess({
    role: roleLike(targetAccess?.role),
    targetWorkspacePolicy: MOVE_TARGET_POLICY,
    pageCount: summary.pageCount,
    incomingMembers: plan.createMemberships,
  });

  return {
    ok: true,
    prepared: {
      source: { id: source.id, title: source.title, workspaceId: source.workspaceId },
      target: { id: target.id, name: target.name, slug: target.slug },
      plan,
      summary,
      validation,
      collisions,
      access,
    },
  };
}

/** Plan the move and return everything the confirm screen must surface. */
export async function previewWorkspaceMoveAction(
  input: MovePreviewInput,
): Promise<WorkspaceMovePreviewResult> {
  const user = await requireUser();
  const sourcePageId = typeof input?.sourcePageId === "string" ? input.sourcePageId : "";
  const targetWorkspaceId =
    typeof input?.targetWorkspaceId === "string" ? input.targetWorkspaceId : "";
  if (!sourcePageId || !targetWorkspaceId) {
    return { ok: false, error: "Pick a source page and a destination workspace." };
  }

  const prepared = await prepareMove(user.id, sourcePageId, targetWorkspaceId);
  if (!prepared.ok) return prepared;
  const { source, target, plan, summary, validation, collisions, access } = prepared.prepared;

  return {
    ok: true,
    sourcePageId,
    sourcePageTitle: source.title,
    sourceWorkspaceId: source.workspaceId,
    targetWorkspaceId: target.id,
    targetName: target.name,
    targetSlug: target.slug,
    summary,
    warnings: plan.warnings,
    collisions,
    access,
    validation,
    canConfirm: access.allowed && validation.ok && summary.pageCount > 0,
  };
}

/**
 * Execute the move: re-plan, re-check access, then write the remapped pages and
 * the queued memberships in one transaction. Every refusal returns a message
 * instead of writing; nothing is written when any check fails.
 */
export async function executeWorkspaceMoveAction(
  input: MoveExecuteInput,
): Promise<WorkspaceMoveExecution> {
  const user = await requireUser();
  const sourcePageId = typeof input?.sourcePageId === "string" ? input.sourcePageId : "";
  const targetWorkspaceId =
    typeof input?.targetWorkspaceId === "string" ? input.targetWorkspaceId : "";
  if (!sourcePageId || !targetWorkspaceId) {
    return { error: "Pick a source page and a destination workspace." };
  }

  const prepared = await prepareMove(user.id, sourcePageId, targetWorkspaceId);
  if (!prepared.ok) return { error: prepared.error };
  const { source, target, plan, summary, validation, access } = prepared.prepared;

  if (!access.allowed) {
    return {
      error:
        access.reasons.join("; ") || "The destination workspace does not allow this move.",
    };
  }
  if (!validation.ok) {
    return { error: `The move plan is not valid: ${validation.errors.join("; ")}` };
  }
  if (summary.pageCount === 0) return { error: "There is nothing to move." };

  const pages = plan.pages.map((page) => toPageCreateData(page, target.id, user.id));
  const memberships = plan.createMemberships.map((membership) => ({
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    role: MEMBERSHIP_ROLE[membership.role] ?? WorkspaceRole.MEMBER,
  }));
  const rootNewId = plan.idMap.get(sourcePageId) ?? null;

  await prisma.$transaction(async (tx) => {
    if (memberships.length > 0) {
      await tx.workspaceMember.createMany({ data: memberships, skipDuplicates: true });
    }
    await tx.page.createMany({ data: pages });
  });

  revalidatePath("/w", "layout");
  await logActivity({
    workspaceId: target.id,
    actorId: user.id,
    action: "page.created",
    targetType: "page",
    targetId: rootNewId,
    meta: {
      movedFrom: source.workspaceId,
      movedPages: pages.length,
      memberships: memberships.length,
      warnings: summary.warningCount,
    },
  });

  return {
    ok: true,
    moved: pages.length,
    memberships: memberships.length,
    warningCount: summary.warningCount,
    targetName: target.name,
    targetSlug: target.slug,
    targetPageId: rootNewId,
  };
}

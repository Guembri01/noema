"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertScopedProject } from "@/lib/page-project";
import { requireUser } from "@/lib/auth";
import {
  canEditContent,
  canManageMembers,
  getWorkspaceAccess,
} from "@/lib/permissions";
import {
  matchesTrigger,
  planAutomation,
  validateAutomation,
  type AutomationEvent,
  type AutomationIssue,
  type AutomationPlan,
  type AutomationRule,
  type AutomationTrigger,
} from "@/lib/automations";
import type { ButtonAction } from "@/lib/row-buttons";
import {
  nextOccurrence,
  materializeTickets,
  parseRule,
  shouldSpawn,
  type RecurrenceRule,
} from "@/lib/recurring-tickets";
import {
  readLabelIds,
  readRecurringAction,
  readRecurringRule,
  serializeRecurringAction,
  serializeRecurringRule,
  recurringScheduleSummary,
  type SerializedRecurrenceRule,
} from "@/lib/recurring-ticket-config";
import { keyPrefix, ticketKey as formatTicketKey } from "@/lib/tickets";
import { checkRateLimit } from "@/lib/rate-limit";
import { opsSecretLimitKey, safeSecretEqual } from "@/lib/ops-guard";

/**
 * Automation rule store + dispatcher (docs/specs/automations.md §13/§20), and
 * the durable rule source behind `POST /api/cron/tickets`.
 *
 * The pure decision engines are `@/lib/automations` (canonical ticket events +
 * ButtonAction plans; `planAutomation`/`matchesTrigger`/`validateAutomation`)
 * and `@/lib/recurring-tickets` (recurrence rules for schedule-driven ticket
 * creation). This module is the reachable server surface over them.
 *
 * Every rule is durable. `Automation.kind` separates the two shapes:
 *  - `"rule"` — a canonical event trigger plus an ordered action list;
 *  - `"recurring_ticket"` — a normalized `RecurrenceRule` plus a single
 *    `create_ticket` template.
 * A schedule is therefore exactly a rule with a cadence, as the spec models it,
 * and the cron route has one durable source instead of a process-local Map.
 */

/** `Automation.kind` for an event automation. */
const RULE_KIND = "rule";
/** `Automation.kind` for a recurring-ticket schedule. */
const RECURRING_KIND = "recurring_ticket";
/** Cap on tickets a single tick materializes per rule (bounds a catch-up). */
const MAX_DRAFTS_PER_RULE = 50;

/** Result shape for the automation actions. */
export type AutomationResult<T = unknown> =
  | ({ ok: true } & T)
  | { error: string; issues?: Pick<AutomationIssue, "path" | "message">[] };

type StoredAutomationRule = AutomationRule & { createdById: string };

/** The durable shape shared by the cron route and the internal materializer. */
export type RecurringTicketSchedule = {
  id: string;
  workspaceId: string;
  templateId: string;
  title: string;
  projectId: string | null;
  priority: string | null;
  labels: string[];
  rule: RecurrenceRule;
  createdById: string;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
};

/** The serializable row the tracker panel renders. */
export type RecurringTicketListItem = {
  id: string;
  templateId: string;
  title: string;
  projectId: string | null;
  priority: string | null;
  labels: string[];
  enabled: boolean;
  /** Human one-liner from the pure engine (`Every 2 weeks on Tue`). */
  summary: string;
  rule: SerializedRecurrenceRule;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

/** The columns both mappers read; keeps Prisma's selection and the cast honest. */
type AutomationRow = {
  id: string;
  workspaceId: string;
  createdById: string;
  name: string;
  kind: string;
  enabled: boolean;
  triggerConfig: Prisma.JsonValue | null;
  action: Prisma.JsonValue | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
};

const RULE_SELECT = {
  id: true,
  workspaceId: true,
  createdById: true,
  name: true,
  kind: true,
  enabled: true,
  triggerConfig: true,
  action: true,
  lastRunAt: true,
  nextRunAt: true,
} as const;

/** Present a stored rule back to the UI without its internal bookkeeping. */
function publicRule(rule: StoredAutomationRule): AutomationRule {
  return {
    id: rule.id,
    workspaceId: rule.workspaceId,
    name: rule.name,
    enabled: rule.enabled,
    trigger: rule.trigger,
    actions: rule.actions,
  };
}

/** Map one durable rule row back onto the pure engine's rule shape. */
function toAutomationRule(row: AutomationRow): StoredAutomationRule | null {
  const issues = validateAutomation({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    trigger: row.triggerConfig,
    actions: row.action,
  });
  if (issues.length > 0) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    trigger: row.triggerConfig as unknown as AutomationTrigger,
    actions: row.action as unknown as ButtonAction[],
    createdById: row.createdById,
  };
}

/** Map one durable schedule row, re-validating both JSON columns. */
function toRecurringSchedule(row: AutomationRow): RecurringTicketSchedule | null {
  try {
    const rule = readRecurringRule(row.triggerConfig);
    const action = readRecurringAction(row.action);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      templateId: action.template.templateId,
      title: action.template.title,
      projectId: action.template.projectId,
      priority: action.template.priority,
      labels: action.template.labels,
      rule,
      createdById: row.createdById,
      enabled: row.enabled,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
    };
  } catch {
    return null;
  }
}

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/* ------------------------------------------------------------------------- *
 * Automation rules (canonical ticket events → ButtonAction plans).
 * ------------------------------------------------------------------------- */

/**
 * Rules a workspace authored, in creation order.
 *
 * The rules are workspace management data: writing one asks for
 * `canManageMembers` (`saveAutomationRuleAction`), so reading them asks the
 * same question — a `GUEST` never receives the workspace's automations.
 */
export async function listAutomationRulesAction(
  workspaceId: string,
): Promise<AutomationResult<{ rules: AutomationRule[] }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage automations." };
  }
  const rows = await prisma.automation.findMany({
    where: { workspaceId, kind: RULE_KIND },
    orderBy: { createdAt: "asc" },
    select: RULE_SELECT,
  });
  return {
    ok: true,
    rules: rows
      .map((row) => toAutomationRule(row))
      .filter((rule): rule is StoredAutomationRule => rule !== null)
      .map(publicRule),
  };
}

/** Create or replace an automation rule, validated by the engine. */
export async function saveAutomationRuleAction(input: {
  workspaceId: string;
  ruleId?: string;
  name?: string;
  enabled?: boolean;
  trigger: unknown;
  actions: unknown;
}): Promise<AutomationResult<{ id: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage automations." };
  }

  const id = input.ruleId?.trim() || randomUUID();
  const candidate = {
    id,
    workspaceId: input.workspaceId,
    name: input.name?.trim() || "Automation",
    enabled: input.enabled !== false,
    trigger: input.trigger,
    actions: input.actions,
    createdById: user.id,
  };
  const issues = validateAutomation(candidate);
  if (issues.length > 0) {
    return {
      error: "This automation is not valid.",
      issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
    };
  }

  const triggerConfig = candidate.trigger as Prisma.InputJsonValue;
  const action = candidate.actions as Prisma.InputJsonValue;
  if (input.ruleId?.trim()) {
    const updated = await prisma.automation.updateMany({
      where: { id, workspaceId: input.workspaceId, kind: RULE_KIND },
      data: {
        name: candidate.name,
        enabled: candidate.enabled,
        triggerConfig,
        action,
      },
    });
    if (updated.count === 0) return { error: "Automation not found." };
  } else {
    await prisma.automation.create({
      data: {
        id,
        workspaceId: input.workspaceId,
        createdById: user.id,
        name: candidate.name,
        kind: RULE_KIND,
        enabled: candidate.enabled,
        triggerConfig,
        action,
      },
    });
  }
  revalidatePath("/w", "layout");
  return { ok: true, id };
}

/** Delete an automation rule. */
export async function deleteAutomationRuleAction(
  workspaceId: string,
  ruleId: string,
): Promise<AutomationResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { error: "You do not have permission to manage automations." };
  }
  const deleted = await prisma.automation.deleteMany({
    where: { id: ruleId, workspaceId, kind: RULE_KIND },
  });
  if (deleted.count === 0) return { error: "Automation not found." };
  revalidatePath("/w", "layout");
  return { ok: true };
}

/**
 * Plan every enabled rule in scope for `event` into a declarative action plan.
 * The loop guard is threaded through `plan.visited` / `plan.depth`, so a chain
 * that comes back around is reported as `skipped` rather than looping.
 */
export async function dispatchAutomationEventAction(
  workspaceId: string,
  event: AutomationEvent,
  context: {
    row?: { id?: string; title?: string; values?: Record<string, unknown> };
    variables?: Record<string, string>;
    now?: string;
  } = {},
): Promise<AutomationResult<{ plans: AutomationPlan[] }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return { error: "You do not have access to this workspace." };

  const row = context.row
    ? {
        id: context.row.id ?? "",
        ...(context.row.title !== undefined ? { title: context.row.title } : {}),
        ...(context.row.values !== undefined ? { values: context.row.values } : {}),
      }
    : undefined;

  const records = await prisma.automation.findMany({
    where: { workspaceId, kind: RULE_KIND, enabled: true },
    orderBy: { createdAt: "asc" },
    select: RULE_SELECT,
  });

  const plans: AutomationPlan[] = [];
  let depth = 0;
  let visited: string[] = [];
  for (const record of records) {
    const rule = toAutomationRule(record);
    if (!rule || rule.enabled === false) continue;
    if (!matchesTrigger(rule, event)) continue;
    const plan = planAutomation(publicRule(rule), {
      row,
      variables: context.variables,
      now: context.now,
      depth,
      visited,
    });
    plans.push(plan);
    if (plan.status === "planned") {
      visited = plan.visited;
      depth = plan.depth + 1;
    }
  }
  return { ok: true, plans };
}

/* ------------------------------------------------------------------------- *
 * Recurring tickets (schedule → created tickets).
 * ------------------------------------------------------------------------- */

/**
 * Schedule a recurring ticket; the rule is validated by `parseRule` and the
 * project by `assertScopedProject` before anything is written.
 *
 * A schedule names a ticket title, so it is tracker data: writing one asks for
 * `canEditContent`, and `listRecurringTicketsAction` asks the same question —
 * a `GUEST` fails closed on every path.
 */
export async function saveRecurringTicketAction(input: {
  workspaceId: string;
  id?: string;
  templateId?: string;
  title: string;
  projectId?: string | null;
  priority?: string | null;
  labels?: string[];
  enabled?: boolean;
  rule: unknown;
}): Promise<AutomationResult<{ id: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to schedule recurring tickets." };
  }
  const title = input.title.trim().slice(0, 300);
  if (!title) return { error: "Give the recurring ticket a title." };

  // B132: the project must live in the same workspace. The schedule stores
  // the project id and every spawned ticket carries it on.
  const project = await assertScopedProject({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
  });
  if ("error" in project) return project;

  let rule: RecurrenceRule;
  try {
    rule = parseRule(input.rule);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That recurrence rule is not valid." };
  }

  // Label ids are re-checked against the workspace: a foreign id must never
  // travel into a spawned ticket. Unknown ids are dropped rather than trusted.
  const requestedLabels = readLabelIds(input.labels);
  const labelIds =
    requestedLabels.length === 0
      ? []
      : (
          await prisma.label.findMany({
            where: { workspaceId: input.workspaceId, id: { in: requestedLabels } },
            select: { id: true },
          })
        ).map((label) => label.id);

  const requestedId = input.id?.trim();
  let existing: AutomationRow | null = null;
  if (requestedId) {
    existing = await prisma.automation.findFirst({
      where: { id: requestedId, workspaceId: input.workspaceId, kind: RECURRING_KIND },
      select: RULE_SELECT,
    });
    if (!existing) return { error: "Recurring ticket not found." };
  }

  // A new schedule uses its own id as the template id, so retries of the same
  // occurrence share the durable `ticketKey`; an edit keeps the original.
  let templateId = input.templateId?.trim();
  if (!templateId && existing) {
    try {
      templateId = readRecurringAction(existing.action).template.templateId;
    } catch {
      templateId = existing.id;
    }
  }
  const id = existing?.id ?? requestedId ?? randomUUID();
  templateId = templateId || id;

  // An edit that does not mention `enabled` keeps the schedule's current
  // state; only an explicit `true`/`false` changes it.
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const now = new Date();
  const next = nextOccurrence(rule, now);
  const triggerConfig = { rule: serializeRecurringRule(rule) } as Prisma.InputJsonValue;
  const action = serializeRecurringAction({
    templateId,
    title,
    projectId: project.projectId,
    priority: input.priority?.trim() || null,
    labels: labelIds,
  }) as unknown as Prisma.InputJsonValue;

  if (existing) {
    await prisma.automation.update({
      where: { id },
      data: {
        name: title,
        enabled,
        triggerConfig,
        action,
        nextRunAt: enabled ? next : null,
      },
    });
  } else {
    // A brand-new rule starts spawning from now; a cron tick never
    // back-fills the series before the user created it.
    await prisma.automation.create({
      data: {
        id,
        workspaceId: input.workspaceId,
        createdById: user.id,
        name: title,
        kind: RECURRING_KIND,
        enabled,
        triggerConfig,
        action,
        lastRunAt: now,
        nextRunAt: enabled ? next : null,
      },
    });
  }
  revalidatePath("/w", "layout");
  return { ok: true, id };
}

/**
 * The workspace's recurring ticket schedules. Reading asks the same question
 * as writing (`canEditContent`), so a `GUEST` never receives them.
 */
export async function listRecurringTicketsAction(workspaceId: string): Promise<
  AutomationResult<{ tickets: RecurringTicketListItem[] }>
> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to manage recurring tickets." };
  }
  const rows = await prisma.automation.findMany({
    where: { workspaceId, kind: RECURRING_KIND },
    orderBy: { createdAt: "asc" },
    select: RULE_SELECT,
  });
  const tickets: RecurringTicketListItem[] = [];
  for (const row of rows) {
    const schedule = toRecurringSchedule(row);
    if (!schedule) continue;
    tickets.push({
      id: schedule.id,
      templateId: schedule.templateId,
      title: schedule.title,
      projectId: schedule.projectId,
      priority: schedule.priority,
      labels: schedule.labels,
      enabled: schedule.enabled,
      summary: recurringScheduleSummary(schedule.rule),
      rule: serializeRecurringRule(schedule.rule),
      lastRunAt: iso(schedule.lastRunAt),
      nextRunAt: iso(schedule.nextRunAt),
    });
  }
  return { ok: true, tickets };
}

/** Delete a recurring ticket schedule (its durable run history cascades). */
export async function deleteRecurringTicketAction(
  workspaceId: string,
  id: string,
): Promise<AutomationResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to manage recurring tickets." };
  }
  const deleted = await prisma.automation.deleteMany({
    where: { id, workspaceId, kind: RECURRING_KIND },
  });
  if (deleted.count === 0) return { error: "Recurring ticket not found." };
  revalidatePath("/w", "layout");
  return { ok: true };
}

/**
 * Pause or resume a schedule. `nextRunAt` is cleared on pause and recomputed on
 * resume, so the tracker panel (and the cron query) always agree on the state.
 */
export async function setRecurringTicketEnabledAction(input: {
  workspaceId: string;
  id: string;
  enabled: boolean;
}): Promise<AutomationResult<{ enabled: boolean; nextRunAt: string | null }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to manage recurring tickets." };
  }
  const row = await prisma.automation.findFirst({
    where: { id: input.id, workspaceId: input.workspaceId, kind: RECURRING_KIND },
    select: RULE_SELECT,
  });
  if (!row) return { error: "Recurring ticket not found." };

  const now = new Date();
  let next: Date | null = null;
  if (input.enabled) {
    try {
      next = nextOccurrence(readRecurringRule(row.triggerConfig), now);
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "That recurrence rule is not valid.",
      };
    }
  }

  // Moving the baseline to `now` on both transitions means a paused schedule
  // never back-fills the pause window when it resumes: the next tick starts
  // from the resume, exactly as a user expects from "Pause".
  const updated = await prisma.automation.updateMany({
    where: { id: input.id, workspaceId: input.workspaceId, kind: RECURRING_KIND },
    data: { enabled: input.enabled, nextRunAt: next, lastRunAt: now },
  });
  if (updated.count === 0) return { error: "Recurring ticket not found." };
  revalidatePath("/w", "layout");
  return { ok: true, enabled: input.enabled, nextRunAt: iso(next) };
}

/* ------------------------------------------------------------------------- *
 * Cron surface. `POST /api/cron/tickets` holds no session, so these accessors
 * fail closed unless the caller presents the configured CRON_SECRET.
 * ------------------------------------------------------------------------- */

/**
 * The ops-gate budget for the cron action surface: 120 calls per 60 s.
 *
 * The budget is shared by the legitimate caller (the cron tick calls these
 * actions in-process — once per tick plus once per materialized schedule) and
 * by anyone who reaches the action over HTTP, because a server action
 * exported from a `"use server"` file *is* an HTTP endpoint.
 */
const AUTOMATIONS_LIMIT = 120;
const AUTOMATIONS_WINDOW_MS = 60_000;

/**
 * The ops gate for the cron action surface: rate limit first, then a
 * constant-time comparison of the presented secret.
 *
 * The rate-limit key is built from the **configured** secret, never from the
 * presented one: a key derived from the guess would hand the attacker a fresh
 * bucket per attempt, and the limit would be bypassable by varying the guess.
 */
function cronActionGate(presented: string): { ok: true } | { error: string } {
  const expected = process.env.CRON_SECRET;
  // Fail closed: without a configured secret there is nothing to compare.
  if (!expected || expected.trim() === "") return { error: "Unauthorized" };
  const limited = checkRateLimit(
    opsSecretLimitKey("automations", expected),
    AUTOMATIONS_LIMIT,
    AUTOMATIONS_WINDOW_MS,
  );
  if (!limited.ok) return { error: "Rate limit exceeded." };
  if (!safeSecretEqual(presented, expected)) return { error: "Unauthorized" };
  return { ok: true };
}

/**
 * The durable rules a cron tick must consider. Disabled rows are excluded in
 * the query itself, so a paused schedule can never spawn even if the caller
 * ignores its `enabled` flag later in the pipeline.
 */
export async function listDueAutomationsForCronAction(secret: string): Promise<
  AutomationResult<{
    scheduled: AutomationRule[];
    recurring: RecurringTicketSchedule[];
  }>
> {
  const gate = cronActionGate(secret);
  if ("error" in gate) return { error: gate.error };

  const rows = await prisma.automation.findMany({
    where: {
      OR: [
        { kind: RULE_KIND, enabled: true },
        { kind: RECURRING_KIND, enabled: true },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: RULE_SELECT,
  });

  const scheduled: AutomationRule[] = [];
  const recurring: RecurringTicketSchedule[] = [];
  for (const row of rows) {
    if (row.kind === RULE_KIND) {
      const rule = toAutomationRule(row);
      if (rule && rule.trigger.event === "schedule") scheduled.push(publicRule(rule));
    } else if (row.kind === RECURRING_KIND) {
      const schedule = toRecurringSchedule(row);
      if (schedule) recurring.push(schedule);
    }
  }
  return { ok: true, scheduled, recurring };
}

/** Prisma's stable code for a unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Materialize one due schedule, atomically and idempotently.
 *
 * The whole run is one Prisma transaction:
 *  1. re-read the rule and its baseline (a paused/deleted row is refused);
 *  2. skip unless the pure `shouldSpawn` gate says the next occurrence is due;
 *  3. let `materializeTickets` draft `(lastRunAt, now]`, passing every already-
 *     claimed occurrence key so a retry can never duplicate one;
 *  4. create the tickets and an `AutomationRun` claim (unique on
 *     `(automationId, occurrenceKey)`) in the same transaction;
 *  5. advance `lastRunAt` and recompute `nextRunAt`.
 *
 * If a concurrent tick wins the unique claim first, the whole transaction rolls
 * back (no ticket survives) and one retry observes the winner's claim and
 * reports a skip — at-most-once, never a duplicate.
 */
export async function materializeRecurringTicketRunAction(input: {
  secret: string;
  id: string;
  now: string;
}): Promise<
  AutomationResult<{
    created: number;
    skipped: boolean;
    keys: string[];
    nextRunAt: string | null;
  }>
> {
  const gate = cronActionGate(input.secret);
  if ("error" in gate) return { error: gate.error };

  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) return { error: "Invalid run time." };

  const run = () =>
    prisma.$transaction(async (tx) => {
      const row = await tx.automation.findUnique({
        where: { id: input.id },
        select: RULE_SELECT,
      });
      if (!row || row.kind !== RECURRING_KIND) {
        return { error: "Recurring ticket not found." } as const;
      }
      if (!row.enabled) {
        return {
          ok: true as const,
          created: 0,
          skipped: true,
          keys: [],
          nextRunAt: iso(row.nextRunAt),
        };
      }

      const rule = readRecurringRule(row.triggerConfig);
      const action = readRecurringAction(row.action);
      const template = action.template;
      const baseline = row.lastRunAt;
      const next = nextOccurrence(rule, now);

      // No baseline: establish one instead of guessing how far back to scan.
      if (!baseline || !Number.isFinite(baseline.getTime())) {
        await tx.automation.update({
          where: { id: row.id },
          data: { lastRunAt: now, nextRunAt: next },
        });
        return {
          ok: true as const,
          created: 0,
          skipped: true,
          keys: [],
          nextRunAt: iso(next),
        };
      }

      if (!shouldSpawn(rule, baseline, now)) {
        // Refresh the projection even on a no-op tick so the panel is honest.
        await tx.automation.update({
          where: { id: row.id },
          data: { nextRunAt: next },
        });
        return {
          ok: true as const,
          created: 0,
          skipped: true,
          keys: [],
          nextRunAt: iso(next),
        };
      }

      // Occurrences are strictly after the baseline, so only runs claimed
      // since it can collide with this window.
      const claimed = await tx.automationRun.findMany({
        where: { automationId: row.id, ranAt: { gte: baseline } },
        select: { occurrenceKey: true },
      });

      const drafts = materializeTickets(
        rule,
        {
          id: template.templateId,
          title: template.title,
          projectId: template.projectId,
          priority: template.priority,
          labels: template.labels,
        },
        {
          from: baseline,
          to: now,
          actorId: row.createdById,
          existing: claimed.map((entry) => entry.occurrenceKey),
          limit: MAX_DRAFTS_PER_RULE,
        },
      );

      if (drafts.length === 0) {
        await tx.automation.update({
          where: { id: row.id },
          data: { lastRunAt: now, nextRunAt: next },
        });
        return {
          ok: true as const,
          created: 0,
          skipped: true,
          keys: [],
          nextRunAt: iso(next),
        };
      }

      const workspace = await tx.workspace.findUnique({
        where: { id: row.workspaceId },
        select: { name: true },
      });
      if (!workspace) throw new Error("Workspace not found.");

      const prefix = keyPrefix(workspace.name);
      // Re-check labels inside the run: a label deleted after the schedule was
      // saved must not turn every future tick into a hard failure.
      const liveLabels =
        template.labels.length === 0
          ? []
          : await tx.label.findMany({
              where: { workspaceId: row.workspaceId, id: { in: template.labels } },
              select: { id: true },
            });
      const labelIds = liveLabels.map((label) => label.id);
      const keys: string[] = [];
      for (const draft of drafts) {
        // Reserve the next number atomically so keys never collide.
        const bumped = await tx.workspace.update({
          where: { id: row.workspaceId },
          data: { ticketCounter: { increment: 1 } },
          select: { ticketCounter: true },
        });
        const number = bumped.ticketCounter;
        const ticket = await tx.ticket.create({
          data: {
            workspaceId: row.workspaceId,
            number,
            key: formatTicketKey(prefix, number),
            title: draft.title,
            type: "task",
            status: "todo",
            priority: draft.priority ?? "none",
            startDate: draft.occurrence,
            reporterId: draft.actorId,
            projectId: draft.projectId,
            position: number * 1000,
            ...(labelIds.length > 0
              ? {
                  labels: {
                    create: labelIds.map((labelId) => ({
                      label: { connect: { id: labelId } },
                    })),
                  },
                }
              : {}),
          },
          select: { id: true },
        });

        // The durable claim. Unique on `(automationId, occurrenceKey)`; a
        // competing tick loses here and its whole transaction rolls back.
        await tx.automationRun.create({
          data: {
            automationId: row.id,
            occurrenceKey: draft.key,
            ranAt: now,
            createdTicketIds: [ticket.id],
          },
        });
        keys.push(draft.key);
      }

      // A capped catch-up must not advance the baseline past occurrences that
      // were not materialized. Keep the last created occurrence as the next
      // baseline so the following tick resumes exactly there.
      const capped = drafts.length >= MAX_DRAFTS_PER_RULE;
      const baselineAfterRun = capped ? drafts[drafts.length - 1].occurrence : now;
      const nextAfterRun = nextOccurrence(rule, baselineAfterRun);

      await tx.automation.update({
        where: { id: row.id },
        data: { lastRunAt: baselineAfterRun, nextRunAt: nextAfterRun },
      });

      return {
        ok: true as const,
        created: drafts.length,
        skipped: false,
        keys,
        nextRunAt: iso(nextAfterRun),
      };
    }, { timeout: 30_000 });

  try {
    return await run();
  } catch (error) {
    // A concurrent tick claimed an occurrence first: retry once, so this call
    // observes the claim and reports a skip instead of surfacing a raw P2002.
    if (isUniqueViolation(error)) return run();
    throw error;
  }
}

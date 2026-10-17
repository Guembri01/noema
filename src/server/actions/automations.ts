"use server";

import { revalidatePath } from "next/cache";
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
} from "@/lib/automations";
import { parseRule, type RecurrenceRule } from "@/lib/recurring-tickets";
import { checkRateLimit } from "@/lib/rate-limit";
import { opsSecretLimitKey, safeSecretEqual } from "@/lib/ops-guard";

/**
 * Automation rule store + dispatcher (docs/specs/automations.md §13/§20), and
 * the rule source behind `POST /api/cron/tickets`.
 *
 * The pure decision engines are `@/lib/automations` (canonical ticket events +
 * ButtonAction plans; `planAutomation`/`matchesTrigger`/`validateAutomation`)
 * and `@/lib/recurring-tickets` (recurrence rules for schedule-driven ticket
 * creation). This module is the reachable server surface over them: it owns the
 * rules a workspace authors, validates them with the engines, plans a matched
 * event, and — for the cron route — exposes the schedule rules.
 *
 * There is no `Automation`/`AutomationRun` Prisma model yet (the spec's §5 data
 * model is unimplemented), so rules live in an in-process store. That keeps the
 * engines genuinely reachable and testable end-to-end; durability across
 * restarts/multiple instances is a tracked follow-up.
 */

export type StoredRecurringTicket = {
  id: string;
  workspaceId: string;
  /** The deterministic template id used by the idempotency key. */
  templateId: string;
  title: string;
  projectId: string | null;
  priority: string | null;
  labels: string[];
  /** The normalized `RecurrenceRule` (the output of `parseRule`). */
  rule: RecurrenceRule;
  createdById: string;
  /** Baseline the next spawn is measured from (epoch millis). */
  lastSpawnedAt: number | null;
  /** Idempotency keys already materialized, so a retry never duplicates. */
  materializedKeys: string[];
};

/** Result shape for the automation actions. */
export type AutomationResult<T = unknown> =
  | ({ ok: true } & T)
  | { error: string; issues?: Pick<AutomationIssue, "path" | "message">[] };

type StoredAutomationRule = AutomationRule & { createdById: string };

const automationRules = new Map<string, StoredAutomationRule>();
const recurringTickets = new Map<string, StoredRecurringTicket>();
let sequence = 0;

/** A fresh, recognisable id without pulling in a uuid dependency. */
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence.toString(36)}_${Date.now().toString(36)}`;
}

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

/* ------------------------------------------------------------------------- *
 * Automation rules (canonical ticket events → ButtonAction plans).
 * ------------------------------------------------------------------------- */

/** Rules a workspace authored, in insertion order. */
export async function listAutomationRulesAction(
  workspaceId: string,
): Promise<AutomationResult<{ rules: AutomationRule[] }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return { error: "You do not have access to this workspace." };
  return {
    ok: true,
    rules: [...automationRules.values()]
      .filter((rule) => rule.workspaceId === workspaceId)
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

  const candidate = {
    id: input.ruleId?.trim() || nextId("rule"),
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
  automationRules.set(candidate.id, candidate as StoredAutomationRule);
  revalidatePath("/w", "layout");
  return { ok: true, id: candidate.id };
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
  const rule = automationRules.get(ruleId);
  if (!rule || rule.workspaceId !== workspaceId) return { error: "Automation not found." };
  automationRules.delete(ruleId);
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

  const plans: AutomationPlan[] = [];
  let depth = 0;
  let visited: string[] = [];
  for (const rule of automationRules.values()) {
    if (rule.workspaceId !== workspaceId || rule.enabled === false) continue;
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

/** Schedule a recurring ticket; the rule is validated by `parseRule`. */
export async function saveRecurringTicketAction(input: {
  workspaceId: string;
  id?: string;
  templateId?: string;
  title: string;
  projectId?: string | null;
  priority?: string | null;
  labels?: string[];
  rule: unknown;
}): Promise<AutomationResult<{ id: string }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to schedule recurring tickets." };
  }
  const title = input.title.trim().slice(0, 300);
  if (!title) return { error: "Give the recurring ticket a title." };

  let rule: RecurrenceRule;
  try {
    rule = parseRule(input.rule);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That recurrence rule is not valid." };
  }

  const id = input.id?.trim() || nextId("recur");
  const existing = recurringTickets.get(id);
  const record: StoredRecurringTicket = {
    id,
    workspaceId: input.workspaceId,
    templateId: input.templateId?.trim() || id,
    title,
    projectId: input.projectId ?? null,
    priority: input.priority ?? null,
    labels: Array.isArray(input.labels)
      ? input.labels.filter((label): label is string => typeof label === "string")
      : [],
    rule,
    createdById: existing?.createdById ?? user.id,
    // A brand-new rule starts spawning from now; an edit keeps its history.
    lastSpawnedAt: existing?.lastSpawnedAt ?? Date.now(),
    materializedKeys: existing?.materializedKeys ?? [],
  };
  recurringTickets.set(id, record);
  revalidatePath("/w", "layout");
  return { ok: true, id };
}

/** The workspace's recurring ticket schedules. */
export async function listRecurringTicketsAction(workspaceId: string): Promise<
  AutomationResult<{
    tickets: {
      id: string;
      templateId: string;
      title: string;
      projectId: string | null;
      rule: RecurrenceRule;
      lastSpawnedAt: number | null;
    }[];
  }>
> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return { error: "You do not have access to this workspace." };
  return {
    ok: true,
    tickets: [...recurringTickets.values()]
      .filter((ticket) => ticket.workspaceId === workspaceId)
      .map((ticket) => ({
        id: ticket.id,
        templateId: ticket.templateId,
        title: ticket.title,
        projectId: ticket.projectId,
        rule: ticket.rule,
        lastSpawnedAt: ticket.lastSpawnedAt,
      })),
  };
}

/** Delete a recurring ticket schedule. */
export async function deleteRecurringTicketAction(
  workspaceId: string,
  id: string,
): Promise<AutomationResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to manage recurring tickets." };
  }
  const record = recurringTickets.get(id);
  if (!record || record.workspaceId !== workspaceId) {
    return { error: "Recurring ticket not found." };
  }
  recurringTickets.delete(id);
  revalidatePath("/w", "layout");
  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Cron surface. `POST /api/cron/tickets` holds no session, so these two
 * accessors fail closed unless the caller presents the configured CRON_SECRET.
 * ------------------------------------------------------------------------- */

/**
 * The ops-gate budget for the cron action surface: 120 calls per 60 s.
 *
 * The budget is shared by the legitimate caller (the cron tick calls these
 * actions in-process — once per tick plus once per materialized schedule) and
 * by anyone who reaches the action over HTTP, because a server action
 * exported from a `"use server"` file *is* an HTTP endpoint. It is therefore
 * deliberately more generous than the routes' 12/60 s, while still turning
 * "unlimited guessing" into a hard bound.
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
 * The action has no `Request` of its own, so no caller-derived key is
 * available — the deployment-wide bucket is the honest choice here.
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

/** The schedule rules + recurring tickets a cron tick must consider. */
export async function listDueAutomationsForCronAction(secret: string): Promise<
  AutomationResult<{ scheduled: AutomationRule[]; recurring: StoredRecurringTicket[] }>
> {
  const gate = cronActionGate(secret);
  if ("error" in gate) return { error: gate.error };
  return {
    ok: true,
    scheduled: [...automationRules.values()]
      .filter((rule) => rule.enabled !== false && rule.trigger.event === "schedule")
      .map(publicRule),
    recurring: [...recurringTickets.values()].map((record) => ({ ...record })),
  };
}

/** Record a recurring ticket's spawn: new idempotency keys + a new baseline. */
export async function commitRecurringRunAction(input: {
  secret: string;
  id: string;
  keys: string[];
  spawnedAt: string;
}): Promise<AutomationResult> {
  const gate = cronActionGate(input.secret);
  if ("error" in gate) return { error: gate.error };
  const record = recurringTickets.get(input.id);
  if (!record) return { error: "Recurring ticket not found." };
  const spawnedAt = new Date(input.spawnedAt).getTime();
  const merged = [...new Set([...record.materializedKeys, ...input.keys])].slice(-1000);
  recurringTickets.set(input.id, {
    ...record,
    materializedKeys: merged,
    lastSpawnedAt: Number.isFinite(spawnedAt) ? spawnedAt : Date.now(),
  });
  return { ok: true };
}

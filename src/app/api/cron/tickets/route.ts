import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/api-guard";
import {
  materializeTickets,
  nextOccurrence,
  parseRule,
  shouldSpawn,
  type TicketTemplate,
} from "@/lib/recurring-tickets";
import { keyPrefix, ticketKey as formatTicketKey } from "@/lib/tickets";
import { guardOpsSecret } from "@/lib/ops-guard";
import {
  commitRecurringRunAction,
  listDueAutomationsForCronAction,
} from "@/server/actions/automations";

export const runtime = "nodejs";

/** Cap on tickets a single tick will materialize per rule (bounds a catch-up). */
const MAX_DRAFTS_PER_RULE = 50;

/**
 * Materialize due recurring tickets (MISSING_FEATURES §20, docs/specs/automations.md
 * R27.13-R27.15). Point a scheduler (cron, Vercel Cron, GitHub Actions, Task
 * Scheduler) at this endpoint and protect it with `CRON_SECRET` sent as the
 * `x-cron-secret` header.
 *
 * The recurrence maths is `@/lib/recurring-tickets`: every schedule is
 * re-validated with `parseRule`, the tick is gated by `shouldSpawn`, the window
 * `(lastSpawnedAt, now]` is turned into deterministic drafts by
 * `materializeTickets`, and `nextOccurrence` reports where the series is headed.
 * Materialization is idempotent by `ticketKey(templateId, occurrence)`: keys the
 * store already recorded are passed back as `existing`, so a retried tick (or a
 * crash between create and commit) never double-creates a ticket.
 */
export async function POST(request: Request) {
  // The shared gate: fail closed without a secret, throttle before the
  // comparison (a wrong secret is bounded, not an unbounded guessing oracle),
  // and compare the secret in constant time.
  const secret = process.env.CRON_SECRET ?? "";
  const gate = guardOpsSecret(request, {
    secret,
    limit: () => rateLimit(request, "cron", 12, 60_000),
  });
  if (!gate.ok) return gate.response;

  const now = new Date();
  const due = await listDueAutomationsForCronAction(secret);
  if ("error" in due) return NextResponse.json({ error: due.error }, { status: 403 });

  let created = 0;
  let skipped = 0;
  const failed: { id: string; error: string }[] = [];

  for (const record of due.recurring) {
    try {
      const rule = parseRule(record.rule);
      const lastSpawned =
        record.lastSpawnedAt === null ? null : new Date(record.lastSpawnedAt);
      // A rule with no baseline has never been ticked; `materializeTickets`
      // from `from = null` is ill-defined, so skip until the store sets one.
      if (!lastSpawned || !shouldSpawn(rule, lastSpawned, now)) {
        skipped += 1;
        continue;
      }

      const template: TicketTemplate = {
        id: record.templateId,
        title: record.title,
        projectId: record.projectId,
        priority: record.priority,
        labels: record.labels,
      };
      const drafts = materializeTickets(rule, template, {
        from: lastSpawned,
        to: now,
        actorId: record.createdById,
        existing: record.materializedKeys,
        limit: MAX_DRAFTS_PER_RULE,
      });

      if (drafts.length === 0) {
        // Advance the baseline even on a no-op tick, so the same empty window
        // is not re-scanned on every subsequent tick.
        await commitRecurringRunAction({ secret, id: record.id, keys: [], spawnedAt: now.toISOString() });
        skipped += 1;
        continue;
      }

      const workspace = await prisma.workspace.findUnique({
        where: { id: record.workspaceId },
        select: { name: true },
      });
      if (!workspace) {
        failed.push({ id: record.id, error: "Workspace not found." });
        continue;
      }
      const prefix = keyPrefix(workspace.name);

      const keys: string[] = [];
      for (const draft of drafts) {
        // Reserve the next number atomically so keys never collide.
        const bumped = await prisma.workspace.update({
          where: { id: record.workspaceId },
          data: { ticketCounter: { increment: 1 } },
          select: { ticketCounter: true },
        });
        const number = bumped.ticketCounter;
        await prisma.ticket.create({
          data: {
            workspaceId: record.workspaceId,
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
          },
        });
        keys.push(draft.key);
        created += 1;
      }

      await commitRecurringRunAction({ secret, id: record.id, keys, spawnedAt: now.toISOString() });
    } catch (error) {
      failed.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const upcoming = due.recurring.map((record) => {
    try {
      const next = nextOccurrence(parseRule(record.rule), now);
      return { id: record.id, nextRunAt: next?.toISOString() ?? null };
    } catch {
      return { id: record.id, nextRunAt: null };
    }
  });

  return NextResponse.json({
    scheduledAutomations: due.scheduled.length,
    recurring: { due: due.recurring.length, created, skipped, failed },
    upcoming,
  });
}

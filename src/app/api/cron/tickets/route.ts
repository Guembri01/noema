import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/api-guard";
import { guardOpsSecret } from "@/lib/ops-guard";
import {
  listDueAutomationsForCronAction,
  materializeRecurringTicketRunAction,
} from "@/server/actions/automations";

export const runtime = "nodejs";

/**
 * Materialize due recurring tickets (MISSING_FEATURES §20, docs/specs/automations.md
 * R27.13-R27.15). Point a scheduler (cron, Vercel Cron, GitHub Actions, Task
 * Scheduler) at this endpoint and protect it with `CRON_SECRET` sent as the
 * `x-cron-secret` header.
 *
 * The recurrence maths is `@/lib/recurring-tickets`; both the rules and the
 * idempotency claims are durable (`Automation` / `AutomationRun`). The route
 * itself holds no state: it lists the enabled rules and asks the materializer
 * to run one schedule at a time, where a Prisma transaction re-reads the
 * baseline, claims each occurrence and creates its ticket together. A retried
 * tick therefore never double-creates: the occurrence key is unique.
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
  // The materializer recomputes `nextRunAt` after advancing the baseline; the
  // row we listed was read before that, so prefer the outcome when we have it.
  const upcoming = new Map<string, string | null>();

  for (const record of due.recurring) {
    try {
      const outcome = await materializeRecurringTicketRunAction({
        secret,
        id: record.id,
        now: now.toISOString(),
      });
      if ("error" in outcome) {
        failed.push({ id: record.id, error: outcome.error });
        upcoming.set(record.id, record.nextRunAt?.toISOString() ?? null);
        continue;
      }
      created += outcome.created;
      if (outcome.skipped) skipped += 1;
      upcoming.set(record.id, outcome.nextRunAt);
    } catch (error) {
      failed.push({
        id: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
      upcoming.set(record.id, record.nextRunAt?.toISOString() ?? null);
    }
  }

  return NextResponse.json({
    scheduledAutomations: due.scheduled.length,
    recurring: { due: due.recurring.length, created, skipped, failed },
    upcoming: due.recurring.map((record) => ({
      id: record.id,
      nextRunAt: upcoming.has(record.id)
        ? (upcoming.get(record.id) ?? null)
        : (record.nextRunAt?.toISOString() ?? null),
    })),
  });
}

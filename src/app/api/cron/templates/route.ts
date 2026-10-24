import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/activity";
import {
  advanceTemplateSchedule,
  normalizeTemplateRecurrence,
  resolveTemplateActorId,
  templateAnchorFromConfig,
} from "@/lib/template-schedule";
import type { TemplateRecurrence } from "@/lib/recurrence";
import { rateLimit } from "@/lib/api-guard";
import { guardOpsSecret } from "@/lib/ops-guard";
import { materializeTemplateRow } from "@/server/template-materialization";

export const runtime = "nodejs";

/**
 * Normalize the stored `Template.recurrence` before it ever reaches the
 * recurrence engine. The column is a free `String?`, so an unknown/corrupt
 * cadence must not silently fall through `nextRunFor`'s catch-all `else`
 * (which is monthly). Anything outside the `TemplateRecurrence` vocabulary
 * `recurrence.ts` understands falls back to the route's historical default
 * (`daily`), reported once so a bad row is observable in the cron log.
 */
function normalizeRecurrence(id: string, value: unknown): TemplateRecurrence {
  const known = normalizeTemplateRecurrence(value);
  if (known) return known;
  if (value !== null && value !== undefined) {
    console.warn(
      `[cron/templates] template ${id}: invalid recurrence ${String(value)}; using "daily"`,
    );
  }
  return "daily";
}

/**
 * Materialize due recurring database templates. Point a scheduler (cron, Vercel
 * Cron, GitHub Actions, Task Scheduler) at this endpoint. Protect it by setting
 * CRON_SECRET and sending `x-cron-secret: <value>`.
 *
 * The endpoint is a **system actor**: it holds no user session, so it is
 * authorized only by the ops secret. Rows are attributed server-side to
 * `template.createdById ?? database.createdById`, and the activity line records
 * the scheduler as an actorless/system event (R31.1/R89.17).
 *
 * D3/D4/R31.22: each due template is isolated in its own try/catch and
 * materializes through `materializeTemplateRow` — one transaction containing the
 * `TemplateRun` idempotency claim, the row, its values and the `nextRunAt`
 * advance. A poison template yields `{ id, error }` in `failed[]`, keeps its
 * schedule (retried next tick) and never blocks later due templates. A
 * concurrent/replayed tick loses the unique occurrence claim and is reported as
 * `skipped`, never as a duplicate row.
 */
export async function POST(request: Request) {
  // Fail closed: materializing recurring templates mutates the workspace, so an
  // unconfigured secret is a deployment error rather than an open endpoint.
  // The shared gate runs the rate limit BEFORE the secret comparison (so a
  // wrong secret is throttled instead of being an unbounded guessing oracle)
  // and compares the secret in constant time.
  const gate = guardOpsSecret(request, {
    secret: process.env.CRON_SECRET,
    limit: () => rateLimit(request, "cron", 12, 60_000),
  });
  if (!gate.ok) return gate.response;

  const now = new Date();
  const due = await prisma.template.findMany({
    where: {
      recurrence: { not: null },
      // A paused schedule keeps its cadence for display but is never selected.
      paused: false,
      nextRunAt: { lte: now },
    },
    select: {
      id: true,
      databasePageId: true,
      name: true,
      icon: true,
      content: true,
      config: true,
      recurrence: true,
      nextRunAt: true,
      createdById: true,
    },
  });

  let created = 0;
  let skipped = 0;
  const failed: { id: string; error: string }[] = [];

  for (const template of due) {
    // D3: one template's failure is reported, not thrown — the queue continues.
    try {
      const recurrence = normalizeRecurrence(template.id, template.recurrence);
      const scheduled = template.nextRunAt ?? now;
      const anchor = templateAnchorFromConfig(template.config) ?? scheduled;
      // Catch-up policy (R31.22): at most one row per tick, then jump past now.
      const next = advanceTemplateSchedule(recurrence, scheduled, anchor, now);
      console.info(
        `[cron/templates] template ${template.id} (${recurrence}) next run ${next.toISOString()}`,
      );

      const database = await prisma.page.findUnique({
        where: { id: template.databasePageId },
        select: {
          id: true,
          workspaceId: true,
          createdById: true,
          deletedAt: true,
        },
      });

      if (!database || database.deletedAt) {
        // Preserved skip semantics: a missing/trashed database advances rather
        // than retrying forever, so restore resumes on a future tick.
        await prisma.template.update({
          where: { id: template.id },
          data: { nextRunAt: next },
        });
        skipped += 1;
        continue;
      }

      const actorId = resolveTemplateActorId(template, database);
      if (!actorId) throw new Error("Template has no attributable creator.");

      const materialized = await materializeTemplateRow({
        template,
        database,
        actorId,
        now,
        occurrence: { scheduledFor: scheduled, nextRunAt: next },
      });

      if (materialized.status === "duplicate") {
        // Another tick already owns this occurrence; the transaction rolled
        // back without writing a row. Advance the schedule anyway so a ledger
        // row left behind by a manual rewind can never wedge the queue.
        await prisma.template.update({
          where: { id: template.id },
          data: { nextRunAt: next },
        });
        skipped += 1;
        continue;
      }
      if (materialized.status === "unavailable") {
        await prisma.template.update({
          where: { id: template.id },
          data: { nextRunAt: next },
        });
        skipped += 1;
        continue;
      }

      skipped += materialized.skippedValues;
      created += 1;

      // The row is attributed to the template/database author, but the event is
      // recorded as the scheduler (no user actor) so the audit log can tell a
      // system materialization apart from a person clicking "New row".
      await logActivity({
        workspaceId: database.workspaceId,
        actorId: null,
        action: "page.created",
        targetType: "page",
        targetId: materialized.pageId,
        meta: {
          source: "template-schedule",
          templateId: template.id,
          scheduledFor: scheduled.toISOString(),
          occurrenceKey: materialized.occurrenceKey,
          attributedTo: actorId,
        },
      });
    } catch (error) {
      failed.push({
        id: template.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ due: due.length, created, skipped, failed });
}

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { nextRunFor, type TemplateRecurrence } from "@/lib/recurrence";
import { rateLimit } from "@/lib/api-guard";
import { guardOpsSecret } from "@/lib/ops-guard";

export const runtime = "nodejs";

type ConfiguredValue = { propertyId: string; value: unknown };

/**
 * Normalize the stored `Template.recurrence` before it ever reaches the
 * recurrence engine. The column is a free `String?`, so an unknown/corrupt
 * cadence must not silently fall through `nextRunFor`'s catch-all `else`
 * (which is monthly). Anything outside the `TemplateRecurrence` vocabulary
 * `recurrence.ts` understands falls back to the route's historical default
 * (`daily`), reported once so a bad row is observable in the cron log.
 */
function normalizeRecurrence(id: string, value: unknown): TemplateRecurrence {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  if (value !== null && value !== undefined) {
    console.warn(
      `[cron/templates] template ${id}: invalid recurrence ${String(value)}; using "daily"`,
    );
  }
  return "daily";
}

/**
 * Advance the schedule (D4): compute from the *stored* `nextRunAt` so
 * execution jitter never drifts the schedule, pinned to the schedule's own
 * wall clock (`config.anchorAt` when set, else the stored nextRunAt). A
 * schedule stale by more than one period (service down) catches up with a
 * single row and jumps past now — never one row per missed tick.
 */
function advanceOf(
  recurrence: TemplateRecurrence,
  scheduled: Date,
  anchor: Date,
  now: Date,
): Date {
  const next = nextRunFor(recurrence, scheduled, anchor);
  return next > now ? next : nextRunFor(recurrence, now, anchor);
}

/** R31.20 anchor (`config.anchorAt`, ISO in JSON) — fall back to the schedule itself. */
function anchorOf(config: unknown, scheduled: Date): Date {
  const anchorAt = (config as { anchorAt?: unknown } | null | undefined)?.anchorAt;
  const parsed =
    typeof anchorAt === "string" || typeof anchorAt === "number"
      ? new Date(anchorAt)
      : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : scheduled;
}

/**
 * Materialize due recurring database templates. Point a scheduler (cron, Vercel
 * Cron, GitHub Actions, Task Scheduler) at this endpoint. Protect it by setting
 * CRON_SECRET and sending `x-cron-secret: <value>`.
 *
 * D3: each due template is isolated in its own try/catch and materializes in a
 * single transaction (row + property values + nextRunAt advance) — one poison
 * template yields `{ id, error }` in `failed[]`, does not advance its own
 * schedule (retried next tick), and never blocks later due templates.
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
    where: { recurrence: { not: null }, nextRunAt: { lte: now } },
    select: {
      id: true,
      databasePageId: true,
      name: true,
      icon: true,
      content: true,
      config: true,
      recurrence: true,
      nextRunAt: true,
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
      const next = advanceOf(recurrence, scheduled, anchorOf(template.config, scheduled), now);
      // Report the next run the schedule advanced to, so the cron log records
      // both the fire and the cadence it was normalized against.
      console.info(
        `[cron/templates] template ${template.id} (${recurrence}) next run ${next.toISOString()}`,
      );

      const database = await prisma.page.findUnique({
        where: { id: template.databasePageId },
        select: { workspaceId: true, createdById: true, deletedAt: true },
      });

      if (!database || database.deletedAt) {
        await prisma.template.update({
          where: { id: template.id },
          data: { nextRunAt: next },
        });
        skipped += 1;
        continue;
      }

      const configured = (template.config ?? {}) as { values?: ConfiguredValue[] };
      const raw = configured.values ?? [];
      const values: ConfiguredValue[] = [];
      let stale = 0;
      if (raw.length > 0) {
        // R31.5: values whose propertyId no longer exists on this database are
        // skipped and counted, never thrown (they used to poison the loop with
        // an FK violation inside createMany). Duplicate propertyIds collapse to
        // the last entry (PropertyValue is unique on propertyId+pageId).
        const valid = new Set(
          (
            await prisma.property.findMany({
              where: { databasePageId: template.databasePageId },
              select: { id: true },
            })
          ).map((property) => property.id),
        );
        const seen = new Set<string>();
        for (const entry of raw) {
          if (!valid.has(entry.propertyId) || seen.has(entry.propertyId)) {
            stale += 1;
            continue;
          }
          seen.add(entry.propertyId);
          values.push(entry);
        }
      }

      // Atomic unit of work: a crash anywhere leaves neither a row without an
      // advanced schedule (double-create on the next tick) nor an advanced
      // schedule without a row.
      await prisma.$transaction(async (tx) => {
        const last = await tx.page.findFirst({
          where: { parentId: template.databasePageId },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        const row = await tx.page.create({
          data: {
            workspaceId: database.workspaceId,
            parentId: template.databasePageId,
            title: template.name,
            icon: template.icon,
            createdById: database.createdById,
            position: (last?.position ?? 0) + 1000,
            content: (template.content ?? undefined) as Prisma.InputJsonValue | undefined,
          },
          select: { id: true },
        });
        if (values.length > 0) {
          await tx.propertyValue.createMany({
            data: values.map((entry) => ({
              propertyId: entry.propertyId,
              pageId: row.id,
              value: entry.value as Prisma.InputJsonValue,
            })),
          });
        }
        await tx.template.update({
          where: { id: template.id },
          data: { nextRunAt: next },
        });
      });

      skipped += stale;
      created += 1;
    } catch (error) {
      failed.push({
        id: template.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ due: due.length, created, skipped, failed });
}

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { pageSearchText } from "@/lib/search";
import { applyTemplate } from "@/lib/database-templates";
import {
  isUniqueConstraintError,
  resolveTemplateContent,
  resolveTemplateText,
  resolveTemplateValue,
  templateOccurrenceKey,
  templatePropertyDefaults,
  templateVariableContext,
} from "@/lib/template-schedule";

/**
 * The single server-side row materializer for database templates
 * (docs/specs/templates.md R31.4/R31.5/R31.18/R31.22,
 * docs/specs/database-deep.md R89.17).
 *
 * Both the manual action (`createRowFromTemplateAction`) and the cron route
 * call this function, so "new row from template" and "scheduled row" can never
 * drift: same pure planner (`applyTemplate`), same stale-property filtering,
 * same variable resolution, same `searchText`, same workspace/parent binding,
 * same transaction.
 *
 * Scheduling adds a `TemplateRun` claim inside that transaction. The claim is
 * unique on `(templateId, occurrenceKey)`: a concurrent or replayed tick loses
 * the insert and its whole transaction rolls back, so at most one row exists
 * per scheduled occurrence.
 */

export type StoredRowTemplate = {
  id: string;
  databasePageId: string;
  name: string;
  icon: string | null;
  content: Prisma.JsonValue | null;
  config: Prisma.JsonValue | null;
  createdById?: string | null;
};

export type StoredDatabase = {
  /** The database page id; rows are its children. */
  id?: string;
  workspaceId: string;
  createdById?: string | null;
  deletedAt?: Date | null;
};

export type TemplateOccurrence = {
  /** The `nextRunAt` instant this run owns. */
  scheduledFor: Date;
  /** The advanced `nextRunAt` written in the same transaction. */
  nextRunAt: Date;
};

export type MaterializeTemplateOptions = {
  template: StoredRowTemplate;
  database: StoredDatabase;
  /** Server-derived attribution: session user (manual) or template/db author. */
  actorId: string;
  now: Date;
  /** Present only for cron materialization; drives the idempotency claim. */
  occurrence?: TemplateOccurrence;
  /** Optional user name for the `{{user}}` variable. */
  actorName?: string;
};

export type MaterializeTemplateResult =
  | {
      status: "created";
      pageId: string;
      /** Stale/duplicate `config.values` entries the planner skipped (R31.5). */
      skippedValues: number;
      searchText: string;
      occurrenceKey: string | null;
    }
  | { status: "duplicate"; occurrenceKey: string }
  | { status: "unavailable"; reason: "database_unavailable" };

/**
 * Materialize one template into a fresh row.
 *
 * The template body/values are resolved at `options.now` (never at the
 * template's authoring time), stale property ids are dropped by
 * `applyTemplate`, and the row is inserted with the same title/body-derived
 * `searchText` as `duplicatePageAction` (R31.4).
 */
export async function materializeTemplateRow(
  options: MaterializeTemplateOptions,
): Promise<MaterializeTemplateResult> {
  const { template, database, actorId, now, occurrence, actorName } = options;

  if (database.deletedAt) {
    return { status: "unavailable", reason: "database_unavailable" };
  }

  const properties = await prisma.property.findMany({
    where: { databasePageId: template.databasePageId },
    select: { id: true },
  });
  const validPropertyIds = new Set(properties.map((property) => property.id));

  const defaults = templatePropertyDefaults(template.config);
  const applied = applyTemplate(
    {
      id: template.id,
      name: template.name,
      icon: template.icon,
      propertyDefaults: defaults,
      content: null,
    },
    {},
    validPropertyIds,
  );

  const context = templateVariableContext(now, actorName);
  const title = resolveTemplateText(template.name, context);
  const content = resolveTemplateContent(template.content, context);
  const values = applied.values.map((cell) => ({
    propertyId: cell.propertyId,
    value: resolveTemplateValue(cell.value, context),
  }));
  const searchText = pageSearchText(title, content);
  const occurrenceKey = occurrence
    ? templateOccurrenceKey(template.id, occurrence.scheduledFor)
    : null;

  const run = async () =>
    prisma.$transaction(
      async (tx) => {
        // The durable claim comes before the row: two concurrent ticks race on
        // this unique insert, and the loser's transaction rolls back without
        // ever writing a page (R31.22 idempotency).
        if (occurrence && occurrenceKey) {
          await tx.templateRun.create({
            data: {
              templateId: template.id,
              occurrenceKey,
              scheduledFor: occurrence.scheduledFor,
              ranAt: now,
            },
          });
        }

        const last = await tx.page.findFirst({
          where: { parentId: template.databasePageId },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        const row = await tx.page.create({
          data: {
            // The parent *is* the authorized database; workspace comes from
            // that page, so the row can never straddle tenants (R89.17).
            workspaceId: database.workspaceId,
            parentId: template.databasePageId,
            title,
            icon: template.icon,
            createdById: actorId,
            position: (last?.position ?? 0) + 1000,
            content:
              content === undefined || content === null
                ? undefined
                : (content as Prisma.InputJsonValue),
            searchText,
          },
          select: { id: true },
        });

        if (values.length > 0) {
          await tx.propertyValue.createMany({
            data: values.map((cell) => ({
              propertyId: cell.propertyId,
              pageId: row.id,
              value: cell.value as Prisma.InputJsonValue,
            })),
          });
        }

        if (occurrence && occurrenceKey) {
          await tx.templateRun.update({
            where: {
              templateId_occurrenceKey: {
                templateId: template.id,
                occurrenceKey,
              },
            },
            data: { pageId: row.id },
          });
          await tx.template.update({
            where: { id: template.id },
            data: {
              nextRunAt: occurrence.nextRunAt,
              lastRunAt: now,
            },
          });
        }

        return {
          status: "created" as const,
          pageId: row.id,
          skippedValues: Math.max(
            0,
            Object.keys(defaults).length - applied.values.length,
          ),
          searchText,
          occurrenceKey,
        };
      },
      { timeout: 20_000 },
    );

  try {
    return await run();
  } catch (error) {
    // A concurrent tick claimed this occurrence first: report a skip, never a
    // failure, so the losing tick does not retry the same occurrence forever.
    if (occurrenceKey && isUniqueConstraintError(error)) {
      return { status: "duplicate", occurrenceKey };
    }
    throw error;
  }
}

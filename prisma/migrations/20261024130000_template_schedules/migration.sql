-- Recurring database row templates (docs/specs/templates.md R31.18-R31.23,
-- docs/specs/database-deep.md R89.17).
--
-- `paused` lets a schedule keep its cadence for display while the cron query
-- skips it; `lastRunAt` is the scheduler's own audit stamp and `createdById`
-- records template attribution for system-materialized rows.
--
-- `TemplateRun` is the durable idempotency claim: one row per
-- `(templateId, occurrenceKey)`, written in the same transaction as the row it
-- creates. A retried/concurrent tick therefore loses the unique insert and
-- rolls back instead of creating a second occurrence.

ALTER TABLE "Template" ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Template" ADD COLUMN "lastRunAt" TIMESTAMP(3);
ALTER TABLE "Template" ADD COLUMN "createdById" TEXT;

CREATE TABLE "TemplateRun" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "pageId" TEXT,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TemplateRun_templateId_occurrenceKey_key" ON "TemplateRun"("templateId", "occurrenceKey");
CREATE INDEX "TemplateRun_templateId_ranAt_idx" ON "TemplateRun"("templateId", "ranAt");
CREATE INDEX "Template_paused_nextRunAt_idx" ON "Template"("paused", "nextRunAt");

ALTER TABLE "TemplateRun" ADD CONSTRAINT "TemplateRun_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

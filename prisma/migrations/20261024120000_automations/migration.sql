-- Automations (event rules + recurring ticket schedules) and their runs.
-- The `AutomationRun` unique key is the durable idempotency claim the cron
-- materializer relies on: one row per `(automationId, occurrenceKey)`.

CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'rule',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggerConfig" JSONB,
    "action" JSONB,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdTicketIds" JSONB,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Automation_workspaceId_kind_enabled_idx" ON "Automation"("workspaceId", "kind", "enabled");
CREATE INDEX "Automation_enabled_nextRunAt_idx" ON "Automation"("enabled", "nextRunAt");
CREATE INDEX "Automation_createdById_idx" ON "Automation"("createdById");
CREATE UNIQUE INDEX "AutomationRun_automationId_occurrenceKey_key" ON "AutomationRun"("automationId", "occurrenceKey");
CREATE INDEX "AutomationRun_automationId_ranAt_idx" ON "AutomationRun"("automationId", "ranAt");

ALTER TABLE "Automation" ADD CONSTRAINT "Automation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

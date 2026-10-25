-- AI cost controls (R25.12-R25.14): durable per-workspace budgets and usage
-- counters. Usage is keyed by UTC calendar month + surface so the transport can
-- accumulate it atomically and the settings dashboard can group by surface.

CREATE TABLE "AiBudget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "monthlyTokenLimit" INTEGER NOT NULL DEFAULT 0,
    "warnPercent" INTEGER NOT NULL DEFAULT 80,
    "hardStop" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiBudget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiBudget_workspaceId_key" ON "AiBudget"("workspaceId");
CREATE INDEX "AiBudget_workspaceId_idx" ON "AiBudget"("workspaceId");

CREATE UNIQUE INDEX "AiUsage_workspaceId_period_surface_key" ON "AiUsage"("workspaceId", "period", "surface");
CREATE INDEX "AiUsage_workspaceId_period_idx" ON "AiUsage"("workspaceId", "period");

ALTER TABLE "AiBudget" ADD CONSTRAINT "AiBudget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

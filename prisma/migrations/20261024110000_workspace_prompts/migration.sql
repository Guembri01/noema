-- Reusable prompt library (R25.22): workspace-shared and personal prompts.
CREATE TABLE "WorkspacePrompt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'workspace',
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspacePrompt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkspacePrompt_workspaceId_scope_idx" ON "WorkspacePrompt"("workspaceId", "scope");
CREATE INDEX "WorkspacePrompt_createdById_idx" ON "WorkspacePrompt"("createdById");

ALTER TABLE "WorkspacePrompt" ADD CONSTRAINT "WorkspacePrompt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspacePrompt" ADD CONSTRAINT "WorkspacePrompt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

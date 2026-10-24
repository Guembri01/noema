-- Per-workspace SAML connections (M2). The deployment-default `AUTH_SAML_*`
-- connection stays available; these rows let one workspace point at its own IdP.
CREATE TABLE "SsoConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'saml',
    "idpEntityId" TEXT NOT NULL,
    "ssoUrl" TEXT NOT NULL,
    "certificate" TEXT NOT NULL,
    "spEntityId" TEXT,
    "callbackUrl" TEXT,
    "emailAttribute" TEXT,
    "nameAttribute" TEXT,
    "groupsAttribute" TEXT,
    "roleRules" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoConnection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SsoConnection_workspaceId_idx" ON "SsoConnection"("workspaceId");

ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

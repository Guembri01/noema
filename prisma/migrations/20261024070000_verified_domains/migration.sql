-- DNS-verified email domains for SAML auto-join (R10.9). A row is created
-- before verification so the admin can publish its TXT token; only rows with
-- `verifiedAt` set participate in login.
CREATE TABLE "VerifiedDomain" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT,
    "domain" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerifiedDomain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VerifiedDomain_workspaceId_domain_key" ON "VerifiedDomain"("workspaceId", "domain");
CREATE INDEX "VerifiedDomain_domain_verifiedAt_idx" ON "VerifiedDomain"("domain", "verifiedAt");
CREATE INDEX "VerifiedDomain_connectionId_idx" ON "VerifiedDomain"("connectionId");

ALTER TABLE "VerifiedDomain" ADD CONSTRAINT "VerifiedDomain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerifiedDomain" ADD CONSTRAINT "VerifiedDomain_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SsoConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

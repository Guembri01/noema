-- Metadata-URL rotation (R10.17): keep the previous IdP certificate for a
-- 24-hour overlap so a login is accepted while the IdP finishes its rotation.
ALTER TABLE "SsoConnection" ADD COLUMN "metadataUrl" TEXT;
ALTER TABLE "SsoConnection" ADD COLUMN "metadataFetchedAt" TIMESTAMP(3);
ALTER TABLE "SsoConnection" ADD COLUMN "prevCertificate" TEXT;
ALTER TABLE "SsoConnection" ADD COLUMN "prevCertificateExpiresAt" TIMESTAMP(3);

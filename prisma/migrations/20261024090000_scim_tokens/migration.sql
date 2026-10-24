-- SCIM 2.0 provisioning token (R10.20): the plaintext is shown once and only
-- its SHA-256 hash is stored.
ALTER TABLE "SsoConnection" ADD COLUMN "scimEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SsoConnection" ADD COLUMN "scimTokenHash" TEXT;

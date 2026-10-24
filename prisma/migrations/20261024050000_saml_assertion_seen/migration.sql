-- SAML assertion replay cache (R10.4/R10.16). The primary key is the stable
-- digest of the signed response, so a byte-for-byte resubmission is rejected
-- across restarts and across multiple app instances.
CREATE TABLE "SamlAssertionSeen" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SamlAssertionSeen_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SamlAssertionSeen_expiresAt_idx" ON "SamlAssertionSeen"("expiresAt");

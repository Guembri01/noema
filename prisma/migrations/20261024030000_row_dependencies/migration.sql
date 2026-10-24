-- Row dependencies (R89.31): a directed blocking edge between two rows of the
-- same database. The write action rejects self-edges, cross-database rows and
-- cycles, so `RowDependency` stays a DAG at rest.
CREATE TABLE "RowDependency" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RowDependency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RowDependency_blockerId_blockedId_key" ON "RowDependency"("blockerId", "blockedId");
CREATE INDEX "RowDependency_blockedId_idx" ON "RowDependency"("blockedId");

ALTER TABLE "RowDependency"
ADD CONSTRAINT "RowDependency_blockerId_fkey"
FOREIGN KEY ("blockerId") REFERENCES "Page"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RowDependency"
ADD CONSTRAINT "RowDependency_blockedId_fkey"
FOREIGN KEY ("blockedId") REFERENCES "Page"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

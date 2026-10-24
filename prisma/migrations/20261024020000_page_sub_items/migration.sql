-- Persisted sub-items: a database row may hang under another row of the same
-- database. `parentId` stays the database page; `subOfId` is the optional row
-- parent so a row can move in/out of the tree without changing its database.
ALTER TABLE "Page" ADD COLUMN "subOfId" TEXT;

CREATE INDEX "Page_subOfId_idx" ON "Page"("subOfId");

ALTER TABLE "Page"
ADD CONSTRAINT "Page_subOfId_fkey"
FOREIGN KEY ("subOfId") REFERENCES "Page"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Deterministic short-code alias for the public share surface:
-- `Page.shortCode` stores `generateShortCode({ seed: id })` so `/s/<code>`
-- resolves by an indexed unique lookup. Nullable: filled lazily at publish or
-- share-state read time, never derived on the fly from untrusted URL input.

ALTER TABLE "Page" ADD COLUMN     "shortCode" TEXT;

CREATE UNIQUE INDEX "Page_shortCode_key" ON "Page"("shortCode");

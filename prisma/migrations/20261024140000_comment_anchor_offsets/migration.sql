-- Inline comment anchors: exact selection offsets inside the anchored block's
-- plain text. Nullable so pre-existing block/quote anchors keep working.
ALTER TABLE "Comment" ADD COLUMN "anchorFrom" INTEGER,
ADD COLUMN "anchorTo" INTEGER;

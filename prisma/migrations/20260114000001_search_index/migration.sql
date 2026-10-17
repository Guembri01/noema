-- The GIN index behind full-text search.
--
-- It cannot live in `schema.prisma` (it is an *expression* index over
-- `to_tsvector(...)`, which Prisma's datamodel cannot express), and
-- `npm run setup:search` created it by hand — so every database built the way the
-- app builds one (`prisma migrate deploy`, which is what the boot wrapper runs) had
-- no index at all. Search still answered, by falling back to a capped sequential
-- scan: correct results, no index. On a large workspace that is the difference
-- between a fast search and a slow one.
--
-- `IF NOT EXISTS` makes this a no-op on databases that already have it (dev
-- databases, and anything created by `db push` + `setup:search`).
CREATE INDEX IF NOT EXISTS "Page_searchText_idx"
  ON "Page"
  USING GIN (to_tsvector('english', coalesce("searchText", "title")));

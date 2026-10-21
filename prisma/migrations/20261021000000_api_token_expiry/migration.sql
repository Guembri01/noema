-- B29: an API token used to stay valid forever.
--
-- The `ApiToken` row had no deadline. A token that leaked — a CI log, a
-- screenshot, the laptop of a former employee — kept working on `/api/v1/*`
-- until somebody happened to delete it by hand, and nothing in the row said
-- how long the credential was meant to live.
--
-- `expiresAt` is that deadline. It is read in the same query that verifies the
-- token (`authenticateApiRequest` in `src/lib/api-auth.ts`), so a token past
-- its deadline is refused exactly like an unknown one — `401 Unauthorized`, no
-- hint that it once existed. A token the app mints gets the default lifetime
-- (90 days, `API_TOKEN_LIFETIME_MS`).
--
-- Existing rows get the same lifetime, counted from their creation:
-- `createdAt + 90 days`. A token that is already older than that stops
-- working at once — that is the point of the change: a leaked credential must
-- not outlive its deadline. The column stays nullable, so a token that is
-- created without a deadline never expires.
--
-- The order is one-directional: the OLD build keeps working on the migrated
-- database (an added column is invisible to it), but the NEW build needs the
-- column to exist — its resolver reads it, and a missing column is a query
-- error, not a fallback. So apply the migration BEFORE the new build starts
-- serving. `npm run db:push` does the same without the migration history.

-- AlterTable
ALTER TABLE "ApiToken" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- AlterTable
UPDATE "ApiToken" SET "expiresAt" = "createdAt" + INTERVAL '90 days';

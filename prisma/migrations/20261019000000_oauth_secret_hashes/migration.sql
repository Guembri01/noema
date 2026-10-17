-- OAuth client secrets and authorization codes are no longer stored in
-- cleartext. Both are kept as a SHA-256 digest; the plaintext exists only in
-- the response that shows the client secret to the user (once, at creation)
-- and in the redirect that hands the authorization code to the client.
--
-- `sha256(bytea)` is a core PostgreSQL function (since PG 11), so the backfill
-- needs no extension: `encode(sha256(convert_to(x, 'UTF8')), 'hex')` is the
-- very digest `node:crypto`'s `createHash("sha256").update(x).digest("hex")`
-- produces — byte for byte — which is what the application compares against
-- (`hashApiToken` / `apiTokenMatches` in `src/lib/api-auth.ts`).
--
-- Existing rows are migrated losslessly: the old column holds the very
-- plaintext the client presents, so hashing it keeps every registered app
-- (and every authorization code still inside its 5-minute window) working. The
-- plaintext columns are dropped in the same transaction, so the cleartext is
-- gone from the database the moment this migration commits.
--
-- Deployment order (this is a contract change, it breaks in both directions):
-- the migration has to be applied BEFORE the new build starts serving, and the
-- old build has to be replaced right after it — the old client queries
-- "clientSecret", the new one queries "clientSecretHash". The `SET NOT NULL`
-- and the unique index take an ACCESS EXCLUSIVE lock and scan the table, so
-- run this while the OAuth tables are small; `docs/OPERATIONS.md` §8.2 has the
-- operator note. `prisma db push` cannot do this change (it does not
-- backfill); use `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "OAuthApp" ADD COLUMN     "clientSecretHash" TEXT;

-- AlterTable
UPDATE "OAuthApp"
   SET "clientSecretHash" = encode(sha256(convert_to("clientSecret", 'UTF8')), 'hex');

-- AlterTable
ALTER TABLE "OAuthApp" ALTER COLUMN "clientSecretHash" SET NOT NULL;

-- AlterTable
ALTER TABLE "OAuthApp" DROP COLUMN "clientSecret";

-- AlterTable
ALTER TABLE "OAuthCode" ADD COLUMN     "codeHash" TEXT;

-- AlterTable
UPDATE "OAuthCode"
   SET "codeHash" = encode(sha256(convert_to("code", 'UTF8')), 'hex');

-- AlterTable
ALTER TABLE "OAuthCode" ALTER COLUMN "codeHash" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCode_codeHash_key" ON "OAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "OAuthCode_codeHash_idx" ON "OAuthCode"("codeHash");

-- DropIndex
DROP INDEX "OAuthCode_code_key";

-- DropIndex
DROP INDEX "OAuthCode_code_idx";

-- AlterTable
ALTER TABLE "OAuthCode" DROP COLUMN "code";

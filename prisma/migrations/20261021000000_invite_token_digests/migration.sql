-- The workspace invitation token is a bearer credential: whoever holds it can
-- redeem the invitation and enter the workspace with the role it carries. It
-- is the one secret this project hands to a third party (the invitation link
-- is mailed out), so the column "Invite"."token" holds the domain-separated
-- SHA-256 digest of the token (`sha256("noema:token:" + token)` — `hashToken`
-- in `src/lib/secrets.ts`) and the plaintext exists only in the link that is
-- mailed out.
--
-- Rows written before that change still hold the raw token. They are migrated
-- here, losslessly: the raw token is hashed with the very function the
-- application uses, so an invitation that was issued before the change and has
-- not expired yet still works, and the cleartext leaves the database in this
-- transaction. (The same choice the OAuth secrets made: the plaintext columns
-- were replaced by digests, the registered clients kept working.)
--
-- The rows that already hold a digest are recognised by their shape — 64
-- lowercase hex characters — and are left alone. Hashing them a second time
-- would lock every pending invitation out, and the shape is unambiguous: a
-- token is unpadded base64url (43 characters), never 64 hex characters.
--
-- `sha256(bytea)` is a core PostgreSQL function (since PG 11), so the backfill
-- needs no extension: `encode(sha256(convert_to(x, 'UTF8')), 'hex')` is the
-- very digest `node:crypto`'s `createHash("sha256").update(x).digest("hex")`
-- produces — byte for byte — with the domain separator the application adds.
--
-- The statement is idempotent: a row that holds a digest does not match the
-- predicate, so the migration can be applied again without harm.

-- AlterTable
UPDATE "Invite"
   SET "token" = encode(sha256(convert_to('noema:token:' || "token", 'UTF8')), 'hex')
 WHERE "token" !~ '^[0-9a-f]{64}$';

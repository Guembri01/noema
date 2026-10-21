-- Per-account sign-in failure counter and temporary lock (B03).
--
-- The sign-in action is a server action, so it never passed through the
-- API rate limit: the password could be guessed as fast as bcrypt allows
-- and the account was never locked. These two columns persist the
-- consecutive failure count and the moment the lock expires, so the
-- backoff survives a restart of the app (and is shared by every instance
-- of it).
--
-- `failedLoginCount` is reset to 0 by a successful sign-in; `lockedUntil`
-- is only meaningful while it is in the future.
ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMP(3);

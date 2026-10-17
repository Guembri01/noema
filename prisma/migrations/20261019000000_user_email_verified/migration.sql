-- B07: an SSO sign-in must not silently link to an account whose address was
-- never proven. The flag records that proof: a local signup never proves the
-- address (false), an account created by the SSO callback inherits the
-- provider's proof (true).
--
-- Existing rows keep the column's default (false = unproven).
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the accounts the SSO callback created.
--
-- The criterion is `passwordHash LIKE 'sso:%'` — the sentinel the SSO
-- callback writes for a just-in-time account (`callback/route.ts`), and the
-- only place in the codebase that writes it. Such an account has no local
-- password and its address came out of a signed id_token, so the provider
-- vouched for it.
--
-- It deliberately does NOT match an account that was registered locally and
-- only *later* signed in through SSO: linking never rewrites `passwordHash`,
-- so that account keeps its bcrypt hash and stays unverified — correct,
-- because a local registration plus an SSO sign-in never proved the address
-- either. The IdP signs such a person in; it does not prove the address they
-- typed when they registered.
UPDATE "User" SET "emailVerified" = true WHERE "passwordHash" LIKE 'sso:%';

/**
 * The demo API token's grant.
 *
 * The seed creates an API token named "Reporting script" — a token that only
 * ever *reads*. Its scopes are the catalogue ids of
 * `src/lib/api-token-scope.ts` (`read:<resource>`, the verb in front of the
 * colon); a token created with a scope the catalogue does not know grants
 * nothing at all, because the API expands the stored list against the
 * catalogue and drops every unknown entry.
 *
 * The list lives here instead of inline in `seed.ts` so that it can be
 * checked against the catalogue without a database.
 */

/** The scopes the seeded "Reporting script" token carries. */
export const DEMO_TOKEN_SCOPES: readonly string[] = [
  "read:pages",
  "read:databases",
  "read:tickets",
];

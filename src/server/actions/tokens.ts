"use server";

import {
  createApiTokenAction as createScopedApiTokenAction,
  revokeApiTokenAction as revokeScopedApiTokenAction,
} from "@/server/actions/api-tokens";

/**
 * Create an API token; the plaintext is returned exactly once.
 *
 * This module is the entry point of the settings home
 * (`/w/[slug]/settings`), which renders the inline `ApiTokenManager`. It used
 * to persist the token *without* scopes — the scope column kept its schema
 * default `[]` — while the scope picker in the very same UI already handed the
 * picked scopes to the action, which dropped them. A token minted that way
 * grants nothing, so as soon as the `/api/v1/*` routes started enforcing the
 * grant it was refused with `403 insufficient_scope` on every call.
 *
 * The implementation therefore lives in `@/server/actions/api-tokens` — the
 * single source of truth for scope validation and persistence — and this
 * module delegates to it, exactly like `backlinks.ts` delegates to the
 * canonical `updatePageAction`. Both entry points now mint the same token.
 *
 * `scopes` is the candidate grant list from the picker; it is validated
 * wholesale (rejected on any issue) and stored expanded, so `write:pages`
 * also grants `read:pages`.
 */
export async function createApiTokenAction(
  name: string,
  scopes: readonly string[] = [],
): Promise<{ token: string } | { error: string }> {
  return createScopedApiTokenAction(name, scopes);
}

/**
 * Revoke one of the signed-in user's tokens. Delegates to the canonical
 * implementation, so both entry points delete exactly the same rows.
 */
export async function revokeApiTokenAction(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  return revokeScopedApiTokenAction(id);
}

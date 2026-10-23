import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The authenticated actor for one MCP tool invocation.
 *
 * Server actions normally resolve the caller from the session cookie via
 * `requireUser()`. The MCP transport authenticates with an API token instead,
 * so the route establishes this request-scoped actor before calling an action.
 * AsyncLocalStorage keeps concurrent tool calls isolated: one request can never
 * inherit another request's actor.
 *
 * This is intentionally a one-way capability: only code that has already
 * verified a bearer token may call `runAsActor`, and the store is never exposed
 * to the browser bundle.
 */
type Actor = { userId: string };

const storage = new AsyncLocalStorage<Actor>();

/** Run `fn` as the user already authenticated by the API-token verifier. */
export function runAsActor<T>(userId: string, fn: () => T): T {
  return storage.run({ userId }, fn);
}

/** The current MCP actor, or null outside an MCP tool call. */
export function currentActorUserId(): string | null {
  return storage.getStore()?.userId ?? null;
}

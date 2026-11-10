/**
 * P1-T04 — the deployment-topology signal, `NOEMA_INSTANCES`.
 *
 * The session registry (`src/lib/session-store.ts`), the rate-limit buckets
 * (`src/lib/rate-limit.ts`) and the share-unlock lockouts
 * (`src/server/actions/share.ts`) are **file/in-process state**: each app
 * instance keeps its own copy. That is the supported single-instance
 * deployment (docs/OPERATIONS.md §1.1); scaled horizontally, session
 * revocation and lockouts silently apply to only the instance that wrote
 * them, and an attacker who reaches the load balancer multiplies every rate
 * budget by the replica count.
 *
 * An operator therefore has to *declare* a scale-out:
 * `NOEMA_INSTANCES=<n>` with n > 1. There is no way to detect the replica
 * count from inside one instance — the signal is the env var, read at
 * module init of the stateful stores, which answers with one `console.warn`
 * naming the caveat and the docs. Unset/blank or anything that is not an
 * integer ≥ 0 is "not declared" → the single-instance default, no warning.
 */

/** The env var that declares the running replica count (`NOEMA_` prefix). */
export const MULTI_INSTANCE_ENV = "NOEMA_INSTANCES";

/**
 * Parse the declared instance count. Unset/blank/not a plain non-negative
 * integer → `null` (not declared). The parse is strict — `1.5`, `abc` and
 * `-3` are all "not declared" on purpose: this is a documentation signal,
 * not a security gate, so a misparsing operator value must never block a
 * boot (or half-count: `parseInt` would silently accept `1.5` as `1`).
 */
export function parseInstanceCount(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

let warned = false;

/**
 * Fire the multi-instance caveat at most once per process. Called at module
 * init by the stateful stores (`session-store.ts`, `rate-limit.ts`), so the
 * warning reaches the operator's log BEFORE the state is written, and the
 * shared flag keeps two stores in one process from repeating it.
 */
export function warnIfMultiInstance(): void {
  if (warned) return;
  const instances = parseInstanceCount(process.env[MULTI_INSTANCE_ENV]);
  if (instances === null || instances <= 1) return;
  warned = true;
  console.warn(
    `[noema] ${MULTI_INSTANCE_ENV}=${instances}: multi-instance deployment declared, but the session registry, the rate-limit buckets and the share-unlock lockouts are file/in-process state — session revocation and rate limits apply per instance only, and an attacker who rotates instances multiplies every budget. Run a single instance, or move this state to a shared store before adding the second replica. See SECURITY.md and docs/OPERATIONS.md §1.1.`,
  );
}

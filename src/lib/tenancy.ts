/**
 * Multi-tenancy isolation engine (FEATURE_MATRIX row "Multi-tenancy" —
 * "Isolate workspaces."; MISSING_FEATURES §17 Multi-tenancy).
 *
 * Every server action that touches a workspace-owned row has to answer the
 * same question — "does this record belong to the caller's workspace?" — and
 * the safe answer is always "only if the workspace id matches, and otherwise
 * fail hard". This module pulls that decision out as pure, synchronous helpers
 * so it can be proven without a database, a transaction or a clock:
 *
 *  - `scopeWhere` — the read side: build the Prisma-compatible `where` that
 *    pins a query to one workspace, carrying the optional caller id through as
 *    a `userId` predicate;
 *  - `assertScoped` / `filterScoped` — the row side: fail hard on a single
 *    foreign record, or keep only the caller's rows from a page;
 *  - `assertAllScoped` — the audit side: never throws, and reports every
 *    offender (by index, without echoing the other tenant's id);
 *  - `mergeScopes` — the composition side: intersect two caller scopes and
 *    refuse to widen access when they cannot overlap;
 *  - `isScopedWhere` — the detector: prove that a `where` a caller received
 *    (possibly nested under `AND` / `OR`) actually constrains the workspace.
 *
 * Conventions shared with the sibling pure modules (`tenant-scope.ts`,
 * `permission-matrix.ts`, `trash.ts`): everything is synchronous and
 * side-effect-free, inputs are treated as untrusted JSON, and the safety rules
 * fail closed — a blank/unknown workspace id never matches anything and never
 * widens a query, and a record is only trusted on the strength of its
 * *top-level* `workspaceId` (nested relations are never mistaken for it).
 * Diagnostic values never carry the foreign workspace id.
 */

/**
 * A caller's tenant identity: the workspace they are acting in, plus an
 * optional user id. `userId` is carried as a secondary predicate but row-level
 * helpers scope on the workspace only — the workspace is the isolation
 * boundary, the user is not.
 */
export type TenantScope = {
  workspaceId: string;
  userId?: string;
};

/** The literal `code` every {@link TenancyError} carries, for callers to switch on. */
export const TENANCY_VIOLATION = "TENANCY_VIOLATION";

/** A Prisma-compatible `where` fragment that pins a query to one tenant. */
export type ScopedWhere = {
  workspaceId: string;
  userId?: string;
};

/**
 * Thrown whenever a record, a query or a scope would cross a tenant boundary.
 * Carries the workspace the caller *asked* for (never the other tenant's id),
 * plus the machine-readable {@link code}.
 */
export class TenancyError extends Error {
  readonly code = TENANCY_VIOLATION;
  readonly workspaceId: string;

  constructor(message: string, workspaceId = "") {
    super(message);
    this.name = "TenancyError";
    this.workspaceId = workspaceId;
  }
}

/** Why {@link assertAllScoped} flagged a record. */
export type TenancyOffenseReason = "foreign-workspace" | "missing-workspace" | "invalid-scope";

/** One offender found while auditing a page of records; `index` is `-1` for a bad scope. */
export type TenancyOffense = {
  index: number;
  reason: TenancyOffenseReason;
};

/** A non-null, non-array object as an indexable record, or `null` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The id to match on, or `null` when the value is not a usable string (blank,
 * whitespace-only, `null`, a number, …). Blank ids fail closed: they match
 * nothing rather than defaulting to "all tenants".
 */
function usableId(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

/**
 * Build the Prisma-compatible `where` that scopes a query to `scope`'s
 * workspace — the returned object always contains `workspaceId`, and carries
 * `userId` too when the scope pins a usable one. A blank/unknown workspace id
 * throws rather than emitting an unscoped (or `undefined`) filter.
 */
export function scopeWhere(scope: TenantScope): ScopedWhere {
  const workspaceId = usableId(scope?.workspaceId);
  if (workspaceId === null) {
    throw new TenancyError("A workspace id is required to scope a query.", "");
  }
  const where: ScopedWhere = { workspaceId };
  const userId = usableId(scope?.userId);
  if (userId !== null) where.userId = userId;
  return where;
}

/**
 * Return `record` when its top-level `workspaceId` matches `scope`, otherwise
 * throw a {@link TenancyError}. A missing record, a record whose `workspaceId`
 * is blank/not a string, and a blank target scope all fail the same way. Only
 * the top-level field is consulted, so a nested relation never makes a foreign
 * row look owned (nor an owned row look foreign).
 */
export function assertScoped<T>(record: T, scope: TenantScope): T {
  const expected = usableId(scope?.workspaceId);
  if (expected === null) {
    throw new TenancyError("A workspace id is required to check tenant scope.", "");
  }
  const actual = usableId(asRecord(record)?.workspaceId);
  if (actual === null || actual !== expected) {
    throw new TenancyError(`Record is not scoped to workspace "${expected}".`, expected);
  }
  return record;
}

/**
 * The rows that belong to `scope`'s workspace, in input order and as a fresh
 * array (the input is never mutated). A blank/unknown workspace id, a
 * non-array input and any malformed row all yield nothing: scoping always
 * fails closed.
 */
export function filterScoped<T>(records: readonly T[], scope: TenantScope): T[] {
  const expected = usableId(scope?.workspaceId);
  if (expected === null || !Array.isArray(records)) return [];
  return records.filter((record) => usableId(asRecord(record)?.workspaceId) === expected);
}

/**
 * Intersect two caller scopes. They must agree on a single usable workspace,
 * and if both pin a user id those must agree too — otherwise the scopes are
 * disjoint and the intersection would silently widen access, so a
 * {@link TenancyError} is thrown. The result is a fresh object; the inputs are
 * never mutated.
 */
export function mergeScopes(a: TenantScope, b: TenantScope): TenantScope {
  const workspaceId = usableId(a?.workspaceId);
  const otherWorkspaceId = usableId(b?.workspaceId);
  if (workspaceId === null || otherWorkspaceId === null || workspaceId !== otherWorkspaceId) {
    throw new TenancyError("Scopes do not overlap on a single workspace.", workspaceId ?? "");
  }
  const userId = usableId(a?.userId);
  const otherUserId = usableId(b?.userId);
  if (userId !== null && otherUserId !== null && userId !== otherUserId) {
    throw new TenancyError("Scopes do not overlap on a single user.", workspaceId);
  }
  const merged = userId ?? otherUserId;
  return merged === null ? { workspaceId } : { workspaceId, userId: merged };
}

/**
 * Whether a `where` guarantees a workspace filter — a detector for the
 * "did someone forget to scope this query?" check. True when the clause pins
 * `workspaceId` directly, when an `AND` contains at least one scoped clause
 * (other clauses may be anything), or when an `OR` is non-empty and *every*
 * branch is scoped. Everything else is a false positive and is rejected: a
 * blank/non-string `workspaceId`, an operator object such as
 * `{ workspaceId: { not: null } }`, an empty `AND`/`OR`, a bare `NOT`, and
 * anything that is not a record.
 */
export function isScopedWhere(where: unknown): boolean {
  const clause = asRecord(where);
  if (!clause) return false;
  if (usableId(clause.workspaceId) !== null) return true;
  const and = clause.AND;
  if (Array.isArray(and)) return and.some((entry) => isScopedWhere(entry));
  const or = clause.OR;
  if (Array.isArray(or)) return or.length > 0 && or.every((entry) => isScopedWhere(entry));
  return false;
}

/**
 * Audit a page of records against `scope` without throwing, returning one
 * {@link TenancyOffense} per offender in input order:
 *
 *  - `foreign-workspace` — a well-formed record scoped to a different
 *    workspace;
 *  - `missing-workspace` — a record with a blank/missing/non-string
 *    `workspaceId` (or a non-record entry);
 *  - `invalid-scope` — the scope itself is unusable, reported once at index
 *    `-1` (nothing can be verified, so nothing is trusted).
 *
 * An empty result means every record is safely scoped. Offenses name only the
 * index and reason, never the foreign workspace id.
 */
export function assertAllScoped(
  records: readonly unknown[],
  scope: TenantScope,
): TenancyOffense[] {
  const expected = usableId(scope?.workspaceId);
  if (expected === null) return [{ index: -1, reason: "invalid-scope" }];
  const list = Array.isArray(records) ? records : [];
  const offenses: TenancyOffense[] = [];
  list.forEach((record, index) => {
    const actual = usableId(asRecord(record)?.workspaceId);
    if (actual === null) {
      offenses.push({ index, reason: "missing-workspace" });
    } else if (actual !== expected) {
      offenses.push({ index, reason: "foreign-workspace" });
    }
  });
  return offenses;
}

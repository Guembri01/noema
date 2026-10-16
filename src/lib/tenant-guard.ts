/**
 * Tenant guard — the single seam that ties the previously-unwired hardening
 * engines together and exposes them to production callers:
 *
 *  - `tenancy.ts`            — CANONICAL workspace scoping (read/row side).
 *  - `tenant-scope.ts`       — the ADAPTER for the overlapping scoping helpers
 *                              (re-expressed here on top of `tenancy.ts`) and
 *                              the canonical planner for scoped write batches.
 *  - `atomic-writes.ts`      — plan/retry/partial-write audit for a multi-step
 *                              write; {@link runAtomicWrites} is the pipeline.
 *  - `access-inheritance.ts` — CANONICAL page/workspace access resolution;
 *                              {@link resolveAccess} / {@link assertPageAccess}
 *                              are the only access decisions callers need.
 *  - `ip-allowlist.ts`       — CANONICAL CIDR allowlist arithmetic;
 *                              {@link decideIpAllowlist} is the fail-closed gate.
 *
 * This module is purposely **edge-safe**: it has no database, network, clock or
 * `process` dependency (the IP gate reads its allowlist from a value the caller
 * passes in, not from the environment), so `src/middleware.ts` can import it
 * without pulling Prisma into the Edge runtime.
 *
 * Reconciliation (item 2 of the wiring task): `tenancy.ts` is canonical and
 * `tenant-scope.ts` is the adapter. The two modules overlap on row scoping
 * (`scopeByWorkspace` / `assertWorkspaceMatch` vs. `filterScoped` /
 * `assertScoped`); the adapters below (`scopeByWorkspace`, `assertWorkspaceMatch`)
 * keep the `tenant-scope` call shape but delegate to the canonical engine, so a
 * scope decision can never diverge between the two. `tenant-scope.ts` stays
 * load-bearing for what only it provides: the declarative write-batch planner
 * ({@link planScopedWrites}) used by {@link runAtomicWrites}.
 */

import {
  TenancyError,
  assertAllScoped,
  assertScoped,
  filterScoped,
  isScopedWhere,
  scopeWhere,
  type ScopedWhere,
  type TenancyOffense,
  type TenantScope,
} from "./tenancy";
import {
  validateTransaction,
  withTransaction,
  type ScopedWrite,
  type TransactionIssue,
  type TransactionOperation,
  type TransactionPlan,
} from "./tenant-scope";
import {
  effectiveAccess,
  isSharePermission,
  type AccessLevel,
  type EffectiveAccessInput,
} from "./access-inheritance";
import { matchAny, normalizeIp, validateCidr } from "./ip-allowlist";
import {
  assertNoPartialWrite,
  planAtomicWrites,
  withRetry,
  type AtomicWritePlan,
  type OrderedStatement,
  type PartialWriteReport,
  type RetryOptions,
  type WriteOp,
  type WriteResult,
} from "./atomic-writes";

/* ------------------------------------------------------------------ *
 * Canonical scoping (tenancy.ts) + tenant-scope.ts adapters
 * ------------------------------------------------------------------ */

/** Build a Prisma `where` pinned to the scope's workspace (canonical). */
export function scopedWhere(scope: TenantScope): ScopedWhere {
  return scopeWhere(scope);
}

/** Return a row when it belongs to the scope, else throw (canonical). */
export function assertRowScoped<T>(record: T, scope: TenantScope): T {
  return assertScoped(record, scope);
}

/** Keep only the scope's rows, in input order (canonical). */
export function filterScopedRows<T>(rows: readonly T[], scope: TenantScope): T[] {
  return filterScoped(rows, scope);
}

/** Audit a page of rows without throwing (canonical). */
export function auditScopedRows(
  rows: readonly unknown[],
  scope: TenantScope,
): TenancyOffense[] {
  return assertAllScoped(rows, scope);
}

/**
 * Dev/prod audit that throws on the first out-of-scope row. Fails closed on a
 * blank scope too. Kept separate from {@link auditScopedRows} so callers that
 * only want the report are not forced to throw.
 */
export function assertRowsScoped(rows: readonly unknown[], scope: TenantScope): void {
  const offenses = assertAllScoped(rows, scope);
  if (offenses.length > 0) {
    throw new TenancyError(
      `Tenant audit found ${offenses.length} out-of-scope row(s): ${offenses
        .map((offense) => `#${offense.index} ${offense.reason}`)
        .join(", ")}.`,
      scope?.workspaceId ?? "",
    );
  }
}

/** Whether a `where` guarantees a workspace filter (canonical). */
export function isScoped(where: unknown): boolean {
  return isScopedWhere(where);
}

/**
 * `tenant-scope.ts`'s row-scoping helper, now delegated to canonical
 * `tenancy.ts`. The adapter exists only so existing `scopeByWorkspace(rows, id)`
 * call sites keep their shape while sharing one implementation.
 */
export function scopeByWorkspace<T>(rows: readonly T[], workspaceId: string): T[] {
  return filterScoped(rows, { workspaceId });
}

/**
 * `tenant-scope.ts`'s single-row assertion, delegated to canonical
 * `tenancy.ts`. Note the error type is `TenancyError` (canonical), not
 * `WorkspaceScopeError` — callers matching on the old error must switch.
 */
export function assertWorkspaceMatch<T>(row: T | null | undefined, workspaceId: string): T {
  return assertScoped(row, { workspaceId }) as T;
}

/** Validate a declarative write batch against one workspace (tenant-scope.ts). */
export function validateScopedWrites(
  operations: readonly ScopedWrite[],
  workspaceId: string,
): TransactionIssue[] {
  return validateTransaction(operations, workspaceId);
}

/**
 * Plan a single-workspace write batch, throwing on any cross-tenant op
 * (tenant-scope.ts, canonical for scoped transaction planning).
 */
export function planScopedWrites<T extends ScopedWrite>(
  operations: readonly T[],
  workspaceId: string,
): TransactionPlan<T> {
  return withTransaction(operations, workspaceId);
}

/* ------------------------------------------------------------------ *
 * Access resolution (access-inheritance.ts)
 * ------------------------------------------------------------------ */

/** Access levels strongest-last; mirrors the `SharePermission` enum order. */
const ACCESS_ORDER: readonly AccessLevel[] = ["READ", "COMMENT", "EDIT", "FULL"];

/** Rank an access level for comparison; unknown/forged levels rank last. */
export function accessRank(level: AccessLevel): number {
  return ACCESS_ORDER.indexOf(level);
}

/**
 * Whether `level` grants at least `required`. Fail closed: a `null` level, or a
 * forged value on either side, denies.
 */
export function accessAllows(level: AccessLevel | null, required: AccessLevel = "READ"): boolean {
  if (level === null || !isSharePermission(level) || !isSharePermission(required)) return false;
  return accessRank(level) >= accessRank(required);
}

/** Resolve the caller's effective access to a page (canonical). */
export function resolveAccess(input: EffectiveAccessInput): AccessLevel | null {
  return effectiveAccess(input);
}

/** Thrown by {@link assertPageAccess} when the resolved level is insufficient. */
export class AccessDeniedError extends Error {
  readonly status = 403;
  readonly required: AccessLevel;
  readonly pageId: string;

  constructor(required: AccessLevel, pageId: string) {
    super(`Access denied: "${required}" is required for page "${pageId}".`);
    this.name = "AccessDeniedError";
    this.required = required;
    this.pageId = pageId;
  }
}

/**
 * Resolve access and throw {@link AccessDeniedError} unless it grants at least
 * `required`. The one fail-closed page/workspace access check callers should
 * route through.
 */
export function assertPageAccess(
  input: EffectiveAccessInput,
  required: AccessLevel = "READ",
): AccessLevel {
  const level = resolveAccess(input);
  if (!accessAllows(level, required)) {
    throw new AccessDeniedError(required, input.page?.id ?? "");
  }
  return level as AccessLevel;
}

/* ------------------------------------------------------------------ *
 * IP allowlist (ip-allowlist.ts)
 * ------------------------------------------------------------------ */

/**
 * Parse a comma/whitespace separated allowlist into validated CIDR entries.
 * Malformed entries are dropped (never widened to "allow all"), duplicates are
 * removed, and an empty/missing value yields `[]` (gate not configured).
 */
export function parseIpAllowlist(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const entry = part.trim();
    if (entry === "" || !validateCidr(entry) || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}

/** The outcome of {@link decideIpAllowlist}. */
export type IpAllowlistDecision = {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Whether an allowlist was actually configured. */
  configured: boolean;
  reason: "not-configured" | "allowed" | "denied";
  /** The canonicalized client IP, or `null` when it was missing/malformed. */
  clientIp: string | null;
};

/**
 * Deny-by-default allowlist gate. When no valid entries are configured the gate
 * is open (no behaviour change); once configured it fails closed — a missing,
 * malformed or non-matching client IP is denied.
 */
export function decideIpAllowlist(
  clientIp: string | null | undefined,
  allowlist: readonly string[],
): IpAllowlistDecision {
  const entries = (Array.isArray(allowlist) ? allowlist : []).filter(validateCidr);
  if (entries.length === 0) {
    return {
      allowed: true,
      configured: false,
      reason: "not-configured",
      clientIp: typeof clientIp === "string" ? normalizeIp(clientIp) : null,
    };
  }
  const canonical = typeof clientIp === "string" ? normalizeIp(clientIp) : null;
  if (canonical === null) {
    return { allowed: false, configured: true, reason: "denied", clientIp: null };
  }
  const allowed = matchAny(canonical, entries);
  return {
    allowed,
    configured: true,
    reason: allowed ? "allowed" : "denied",
    clientIp: canonical,
  };
}

/** Pull the client IP from forwarding headers (XFF first hop, then X-Real-IP). */
export function headerClientIp(get: (name: string) => string | null): string | null {
  const forwarded = get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  const real = get("x-real-ip");
  return real && real.trim() !== "" ? real.trim() : null;
}

/** Paths that hold private workspace data (settings/audit) or admin tooling. */
const PRIVATE_SURFACE = /^\/(?:w\/[^/]+\/(?:settings|audit)|admin)(?:\/|$)/;

/** True when `pathname` is a private/admin surface the IP gate must protect. */
export function isPrivateSurface(pathname: string): boolean {
  return typeof pathname === "string" && PRIVATE_SURFACE.test(pathname);
}

/* ------------------------------------------------------------------ *
 * Atomic multi-step writes (atomic-writes.ts + tenant-scope.ts)
 * ------------------------------------------------------------------ */

/**
 * One step of an atomic write batch. It is a {@link WriteOp} (id/kind/model/
 * dependsOn/bestEffort) plus the workspace it touches and the callback that
 * performs it inside a transaction.
 */
export type GuardedWriteStep = {
  /** Stable id used by `dependsOn` and to correlate results. */
  id: string;
  /** Prisma delegate name, e.g. `"page"`. */
  model: string;
  /** The write verb (validated against the tenant-scope operation set). */
  operation: TransactionOperation;
  /** The workspace this step writes to; must match the batch workspace. */
  workspaceId: string;
  /** Ids of steps that must commit first. */
  dependsOn?: readonly string[];
  /** A write allowed to fail without aborting the batch (lone steps only). */
  bestEffort?: boolean;
  /** Runs the step. `tx` is the caller's transaction handle. */
  run: (tx: unknown) => Promise<unknown>;
};

/** Runs an ordered batch and reports which statements committed. */
export type AtomicExecutor = (
  statements: readonly OrderedStatement[],
) => Promise<readonly WriteResult[]>;

/** The audited outcome of {@link runAtomicWrites}. */
export type AtomicWriteOutcome = {
  plan: AtomicWritePlan;
  report: PartialWriteReport;
  results: readonly WriteResult[];
};

/** Map a guarded step to the pure planner's `WriteOp`. */
function toWriteOp(step: GuardedWriteStep): WriteOp {
  const op: WriteOp = { id: step.id, kind: step.operation, model: step.model };
  if (step.dependsOn) op.dependsOn = step.dependsOn;
  if (step.bestEffort !== undefined) op.bestEffort = step.bestEffort;
  return op;
}

/** Map a guarded step to the tenant-scope planner's `ScopedWrite`. */
function toScopedWrite(step: GuardedWriteStep): ScopedWrite {
  return { model: step.model, operation: step.operation, workspaceId: step.workspaceId };
}

/**
 * The write-side pipeline, reachable from `db.ts` as `atomicTransaction`:
 *
 * 1. `planAtomicWrites` orders the batch and rejects duplicate ids, dangling
 *    dependencies, cycles and best-effort writes smuggled into a transaction;
 * 2. `withTransaction` proves every op belongs to the caller's workspace — a
 *    cross-tenant batch is refused before the executor is ever called;
 * 3. `withRetry` runs the executor, retrying only transient conflicts;
 * 4. `assertNoPartialWrite` audits the results and throws `PartialWriteError`
 *    if the executor ever committed part of the batch.
 *
 * The executor owns the actual transaction; in production it is Prisma's
 * `$transaction`, which rolls back on a throw. The audit in step 4 is the
 * safety net that catches an executor that did *not*.
 */
export async function runAtomicWrites(
  scope: TenantScope,
  steps: readonly GuardedWriteStep[],
  execute: AtomicExecutor,
  options: RetryOptions = {},
): Promise<AtomicWriteOutcome> {
  // Canonical blank-scope check first, so a bad scope fails as a TenancyError.
  scopeWhere(scope);
  const plan = planAtomicWrites(steps.map(toWriteOp));
  // Throws WorkspaceScopeError on any cross-workspace (or malformed) op.
  withTransaction(steps.map(toScopedWrite), scope.workspaceId);

  const results = await withRetry(() => execute(plan.statements), options);
  const report = assertNoPartialWrite(plan, results);
  return { plan, report, results };
}

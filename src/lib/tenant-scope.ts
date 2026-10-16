/**
 * Pure multi-tenancy + soft-delete helpers (matrix rows "Multi-tenancy",
 * "Soft delete" and "Transactions / atomic writes"; spec
 * `docs/specs/engineering-hardening.md` §4.2, `workspaces-structure.md` R80.7).
 *
 * These are the tenant-safety rules that every server action already relies on
 * ad hoc — "only touch rows in the caller's workspace", "mark-deleted rather
 * than purge", "run a group of writes as one unit" — pulled out as pure,
 * synchronous decisions so they can be proven without a database, a transaction
 * or a clock:
 *
 *  - `scopeByWorkspace` / `assertWorkspaceMatch` — the read side: filter a page
 *    of rows down to one tenant, or fail hard when a single row is not scoped
 *    to the workspace the caller asked for (R80.7's containment check);
 *  - `softDelete` / `restoreSoftDeleted` plus `isSoftDeleted` / `isLive` — the
 *    trash side: `deletedAt` is the only marker, and the helpers never mutate
 *    the row they are given;
 *  - `withTransaction` / `validateTransaction` — the write side: turn a
 *    declarative op list into a descriptor whose every operation has been
 *    checked to belong to one workspace before anything runs (the pure half of
 *    R28.6's per-action `$transaction`).
 *
 * Conventions shared with the sibling pure modules (`permission-matrix.ts`,
 * `trash.ts`, `export-zip-plan.ts`): everything is synchronous and
 * side-effect-free, inputs are treated as untrusted JSON, and both safety rules
 * fail closed — a blank/unknown workspace id never matches anything, and a
 * mismatched op is rejected rather than silently widened.
 */

/** The one field every tenant-scoped row must carry. */
export type WorkspaceScoped = { workspaceId: string };

/** The one field every soft-deletable row must carry. */
export type SoftDeletable = { deletedAt: Date | null };

/** The Prisma-style verbs a planned transaction may contain. */
export type TransactionOperation =
  | "create"
  | "update"
  | "delete"
  | "upsert"
  | "createMany"
  | "updateMany"
  | "deleteMany";

/** Every allowed verb, in the order diagnostics present them. */
export const TRANSACTION_OPERATIONS: readonly TransactionOperation[] = [
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "updateMany",
  "deleteMany",
];

/**
 * One declared write inside a transaction descriptor. The planner only needs
 * `model` / `operation` / `workspaceId` to prove the batch is single-tenant;
 * callers may attach any extra fields (arguments, `where`, …) and
 * {@link withTransaction} preserves them.
 */
export type ScopedWrite = {
  /** Prisma delegate name, e.g. `"page"` or `"propertyValue"`. */
  model: string;
  /** The write verb. */
  operation: TransactionOperation;
  /** The workspace every operation in the batch must share. */
  workspaceId: string;
};

/** Why {@link validateTransaction} rejected an operation. */
export type TransactionIssueReason =
  | "invalid-workspace"
  | "missing-workspace"
  | "foreign-workspace"
  | "malformed-operation";

/** One problem found while scoping a transaction. */
export type TransactionIssue = {
  /** Index of the offending op, or `-1` when the target workspace itself is bad. */
  index: number;
  reason: TransactionIssueReason;
  detail: string;
};

/** A validated, single-workspace batch of writes. */
export type TransactionPlan<T extends ScopedWrite = ScopedWrite> = {
  workspaceId: string;
  count: number;
  operations: T[];
};

/**
 * Thrown whenever a row, an id or an operation would cross a workspace
 * boundary. Carries the workspace the caller *asked* for (never the other
 * tenant's id) plus, for a whole batch, every {@link TransactionIssue}.
 */
export class WorkspaceScopeError extends Error {
  readonly workspaceId: string;
  readonly issues: readonly TransactionIssue[];

  constructor(message: string, workspaceId: string, issues: readonly TransactionIssue[] = []) {
    super(message);
    this.name = "WorkspaceScopeError";
    this.workspaceId = workspaceId;
    this.issues = issues;
  }
}

/** A non-null object as an indexable record, or `null` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * The workspace id to match on, or `null` when the value is not a usable string
 * (blank, whitespace-only, `null`, a number, …). Blank ids fail closed: they
 * match nothing rather than defaulting to "all tenants".
 */
function normalizedWorkspaceId(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

/** True when `value` is a `Date` with a real (non-`NaN`) timestamp. */
function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * The rows that belong to `workspaceId`, in input order and as a fresh array
 * (the input is never mutated). A blank/unknown workspace id, a non-array
 * input, and any malformed row all yield nothing: scoping always fails closed.
 */
export function scopeByWorkspace<T extends WorkspaceScoped>(
  rows: readonly T[],
  workspaceId: string,
): T[] {
  const target = normalizedWorkspaceId(workspaceId);
  if (target === null || !Array.isArray(rows)) return [];
  return rows.filter((row) => asRecord(row)?.workspaceId === target);
}

/**
 * Return `row` when it belongs to `workspaceId`, otherwise throw a
 * {@link WorkspaceScopeError}. A missing row, a row whose `workspaceId` is
 * blank/not a string, and a blank target id all fail the same way. The error
 * message names only the expected workspace, so it can be logged without
 * leaking the other tenant's id.
 */
export function assertWorkspaceMatch<T extends WorkspaceScoped>(
  row: T | null | undefined,
  workspaceId: string,
): T {
  const expected = normalizedWorkspaceId(workspaceId);
  if (expected === null) {
    throw new WorkspaceScopeError(
      "A workspace id is required to check tenant scope.",
      String(workspaceId ?? ""),
    );
  }
  const record = asRecord(row);
  const actual = record?.workspaceId;
  if (!record || normalizedWorkspaceId(actual) === null) {
    throw new WorkspaceScopeError(`Row is not scoped to workspace "${expected}".`, expected);
  }
  if (actual !== expected) {
    throw new WorkspaceScopeError(`Row is not scoped to workspace "${expected}".`, expected);
  }
  return row as T;
}

/**
 * Whether a row is currently soft-deleted: `deletedAt` is a valid `Date`.
 * Anything else (`null`, a missing field, a string, an `Invalid Date`) is not a
 * deletion marker.
 */
export function isSoftDeleted(value: unknown): boolean {
  return isValidDate(asRecord(value)?.deletedAt);
}

/** Whether a row is live — i.e. not provably soft-deleted. See {@link isSoftDeleted}. */
export function isLive(value: unknown): boolean {
  return !isSoftDeleted(value);
}

/**
 * Mark a row deleted by stamping `deletedAt` on a copy. The input is never
 * mutated. Re-deleting an already-trashed row keeps its original timestamp so a
 * retry can never extend the retention window; an invalid `now` throws a
 * `TypeError` rather than persisting an `Invalid Date`.
 */
export function softDelete<T extends SoftDeletable>(
  row: T,
  now: Date,
): Omit<T, "deletedAt"> & { deletedAt: Date } {
  if (!isValidDate(now)) throw new TypeError("softDelete requires a valid Date stamp.");
  const stamp = isValidDate(row.deletedAt) ? row.deletedAt : now;
  return { ...row, deletedAt: stamp } as Omit<T, "deletedAt"> & { deletedAt: Date };
}

/**
 * Bring a soft-deleted row back by clearing `deletedAt` on a copy. Idempotent:
 * an already-live row yields an equivalent copy, and the input is never
 * mutated.
 */
export function restoreSoftDeleted<T extends SoftDeletable>(
  row: T,
): Omit<T, "deletedAt"> & { deletedAt: null } {
  return { ...row, deletedAt: null } as Omit<T, "deletedAt"> & { deletedAt: null };
}

/** A one-line, value-free description of an issue, safe to log or surface. */
function describeIssue(issue: TransactionIssue): string {
  return `#${issue.index} ${issue.reason} (${issue.detail})`;
}

/**
 * Audit a declarative op list against a single workspace, without throwing.
 * Returns one {@link TransactionIssue} per problem, in input order:
 *
 *  - `invalid-workspace` — the target workspace id is blank/not a string; this
 *    is reported once, at index `-1`, and short-circuits the per-op scan;
 *  - `malformed-operation` — an op that is not an object, or whose `model` is
 *    blank or whose `operation` is not one of {@link TRANSACTION_OPERATIONS};
 *  - `missing-workspace` — a well-formed op with a blank/missing `workspaceId`;
 *  - `foreign-workspace` — a well-formed op scoped to a different workspace.
 *
 * The operation's `detail` names only the model/field, never the foreign
 * workspace id.
 */
export function validateTransaction(
  operations: readonly ScopedWrite[],
  workspaceId: string,
): TransactionIssue[] {
  const target = normalizedWorkspaceId(workspaceId);
  if (target === null) {
    return [
      {
        index: -1,
        reason: "invalid-workspace",
        detail: "a non-empty workspace id is required",
      },
    ];
  }

  const list = Array.isArray(operations) ? operations : [];
  const issues: TransactionIssue[] = [];
  list.forEach((raw, index) => {
    const op = asRecord(raw);
    if (!op) {
      issues.push({ index, reason: "malformed-operation", detail: "operation is not an object" });
      return;
    }
    const model = op.model;
    if (typeof model !== "string" || model.trim() === "") {
      issues.push({ index, reason: "malformed-operation", detail: "model is required" });
      return;
    }
    const operation = op.operation;
    if (
      typeof operation !== "string" ||
      !TRANSACTION_OPERATIONS.includes(operation as TransactionOperation)
    ) {
      issues.push({
        index,
        reason: "malformed-operation",
        detail: `unknown operation on ${model}`,
      });
      return;
    }
    const scoped = normalizedWorkspaceId(op.workspaceId);
    if (scoped === null) {
      issues.push({
        index,
        reason: "missing-workspace",
        detail: `${model}.${operation} has no workspaceId`,
      });
      return;
    }
    if (scoped !== target) {
      issues.push({
        index,
        reason: "foreign-workspace",
        detail: `${model}.${operation} is scoped to a different workspace`,
      });
    }
  });
  return issues;
}

/**
 * Build a transaction descriptor from a declarative op list, proving first that
 * every operation belongs to `workspaceId`. On any violation it throws a
 * {@link WorkspaceScopeError} carrying every {@link TransactionIssue} — a
 * cross-tenant batch must never reach the database. On success it returns a
 * fresh plan: the operations are shallow copies, so mutating the plan cannot
 * corrupt the caller's declarations.
 */
export function withTransaction<T extends ScopedWrite>(
  operations: readonly T[],
  workspaceId: string,
): TransactionPlan<T> {
  const issues = validateTransaction(operations, workspaceId);
  if (issues.length > 0) {
    throw new WorkspaceScopeError(
      `Refusing a transaction that crosses workspace scopes: ${issues
        .map(describeIssue)
        .join("; ")}.`,
      normalizedWorkspaceId(workspaceId) ?? "",
      issues,
    );
  }
  const list = (Array.isArray(operations) ? operations : []).map((op) => ({ ...op }));
  return { workspaceId, count: list.length, operations: list };
}

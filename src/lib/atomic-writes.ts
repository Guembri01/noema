/**
 * Transaction / atomic-write helper engine (MISSING_FEATURES §17:
 * transactions, atomic writes, serialization retries).
 *
 * Every helper here is pure and deterministic: nothing touches Prisma, the
 * network or the real clock unless the caller leaves the default in place. The
 * DB-touching code lives in the route handlers; this module only decides
 * *what* to write, in *what order*, *whether* an error is worth retrying and
 * *whether* a batch was applied all-or-nothing.
 *
 * The pieces fit together as one pipeline:
 *
 * 1. {@link planAtomicWrites} turns a batch of {@link WriteOp}s into an ordered
 *    {@link AtomicWritePlan}. It refuses anything that could half-apply:
 *    duplicate ids, dangling or cyclic dependencies, and best-effort writes
 *    smuggled into a multi-step transaction.
 * 2. {@link chunkWrites} splits a large batch into ordered, deterministic
 *    chunks so a caller can batch `createMany`-style work without losing the
 *    original order.
 * 3. {@link withRetry} wraps a transaction call and retries only the errors
 *    that Postgres/Prisma mark as transient. Serialization failures and
 *    deadlocks are safe to retry because the transaction rolled back cleanly;
 *    everything else propagates on the first attempt.
 * 4. {@link assertNoPartialWrite} audits the per-op results afterwards. If some
 *    ops committed while others did not, the batch was not all-or-nothing and
 *    the plan's committed writes are surfaced as conflicts to be reconciled.
 */

/** Default number of times {@link withRetry} invokes its callback. */
export const DEFAULT_RETRY_ATTEMPTS = 3;

/** Default first-retry delay; each subsequent retry doubles it. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 50;

/**
 * The error codes worth retrying. Prisma surfaces the transactions codes it
 * borrows from the database, and raw `pg`/driver errors surface the Postgres
 * SQLSTATE directly. Both spellings are accepted.
 *
 * - `P2034` transaction failed due to a write conflict or a deadlock (Prisma)
 * - `P2002` unique constraint violation — retried where the caller can
 *   re-read and mint a fresh unique value
 * - `P2028` transaction API error (transaction already closed / timeout)
 * - `40001` serialization_failure (Postgres)
 * - `40P01` deadlock_detected (Postgres)
 *
 * `P2025` ("record not found") is deliberately absent: it is a logical error,
 * not a transient one, and retrying it just hides the bug.
 */
export const RETRYABLE_TX_CODES: ReadonlySet<string> = new Set([
  "P2034",
  "P2002",
  "P2028",
  "40001",
  "40P01",
]);

/** Human-readable fragments that identify a transient conflict in a message. */
const RETRYABLE_MESSAGE_PATTERNS: readonly RegExp[] = [
  /deadlock/i,
  /serializ/i,
  /write conflict/i,
  /concurrent update/i,
];

/** How far down a `.cause` chain {@link isRetryableTxError} will look. */
const MAX_CAUSE_DEPTH = 8;

/** A non-null, non-array object — the only shape trusted as a record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The best available error code for a value: the value itself when it is a
 * string/number, else `code` (or `meta.code`) on an object. `null` when there
 * is none.
 */
function codeOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);

  const record = asRecord(value);
  if (!record) return null;

  const direct = record.code;
  if (typeof direct === "string" && direct !== "") return direct;
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);

  const meta = asRecord(record.meta);
  if (meta) {
    const nested = meta.code;
    if (typeof nested === "string" && nested !== "") return nested;
    if (typeof nested === "number" && Number.isFinite(nested)) return String(nested);
  }
  return null;
}

/** The message of an `Error`, a bare string, or an object's `message` field. */
function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (record && typeof record.message === "string") return record.message;
  return "";
}

/** True when `text` mentions any known retryable code (`P2034`, `40001`, …). */
function mentionsRetryableCode(text: string): boolean {
  if (text === "") return false;
  for (const code of RETRYABLE_TX_CODES) {
    if (text.includes(code)) return true;
  }
  return false;
}

/** True when `text` contains a transient-conflict phrase. */
function mentionsRetryableSignal(text: string): boolean {
  if (text === "") return false;
  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether `error` is a transient transaction conflict that is safe to retry.
 *
 * Detection is intentionally generous and total — it never throws on junk:
 * - by code, from the value itself, its `code`/`meta.code`, by SQLSTATE;
 * - by Prisma's messages ("Transaction failed due to a write conflict or a
 *   deadlock", "could not serialize access due to concurrent update", …);
 * - by walking a wrapped `.cause` chain.
 *
 * Logical errors (`P2025`, validation, unknown shapes) return `false`.
 */
export function isRetryableTxError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined) return false;

    const record = asRecord(current);
    if (record) {
      if (seen.has(record)) return false;
      seen.add(record);
    }

    const code = codeOf(current);
    if (code !== null && RETRYABLE_TX_CODES.has(code.trim())) return true;

    const message = messageOf(current);
    if (mentionsRetryableCode(message) || mentionsRetryableSignal(message)) return true;

    let cause: unknown;
    if (current instanceof Error) {
      cause = current.cause;
    } else if (record) {
      cause = record.cause;
    }
    if (cause === undefined) return false;
    current = cause;
  }

  return false;
}

/** One retry as reported to {@link RetryOptions.onRetry}. */
export type RetryAttempt = {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Delay in milliseconds awaited before the next attempt. */
  delayMs: number;
  /** Timestamp from the injected `now` clock, recorded before sleeping. */
  at: number;
  /** The error that triggered the retry. */
  error: unknown;
};

/** Options accepted by {@link withRetry}; all fields are optional. */
export type RetryOptions = {
  /** Total attempts, including the first call. Non-finite → default. */
  attempts?: number;
  /** Override for {@link isRetryableTxError}. */
  isRetryable?: (error: unknown) => boolean;
  /** First-retry delay; doubles each retry. Defaults to 50ms. */
  baseDelayMs?: number;
  /** Wall-clock source, injected for deterministic tests. */
  now?: () => number;
  /** Sleeper, injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void> | void;
  /** Observer called once per scheduled retry, before sleeping. */
  onRetry?: (attempt: RetryAttempt) => void;
};

/** Real sleeper used when the caller does not inject one. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Clamp a caller-supplied attempt count into `[1, ∞)`, defaulting junk. */
function normalizeAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RETRY_ATTEMPTS;
  const floored = Math.floor(value);
  return floored < 1 ? 1 : floored;
}

/** Clamp the base delay into `[0, ∞)`, defaulting junk. */
function normalizeBaseDelay(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RETRY_BASE_DELAY_MS;
  }
  return value;
}

/**
 * Run `fn`, retrying transient transaction failures with exponential backoff.
 *
 * `attempts` counts the total invocations (so `attempts: 3` means up to two
 * sleeps); a retryable failure on the last attempt rethrows. A non-retryable
 * failure rethrows immediately without ever calling `sleep`. The delay before
 * retry `n` is `baseDelayMs * 2 ** (n - 1)`.
 *
 * `sleep` and `now` are injectable so tests are fully deterministic and never
 * wait on a real timer.
 */
export async function withRetry<T>(
  fn: () => T | Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = normalizeAttempts(options.attempts);
  const baseDelayMs = normalizeBaseDelay(options.baseDelayMs);
  const isRetryable = options.isRetryable ?? isRetryableTxError;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (!isRetryable(error)) break;

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.({ attempt, delayMs, at: now(), error });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/** Prisma-style write verb; kept as a string so callers can extend it. */
export type WriteKind = string;

/** A single write in a batch, before it is planned. */
export type WriteOp = {
  /** Stable id used by `dependsOn` and to correlate results. */
  id: string;
  /** The operation verb, e.g. `"create"`, `"update"`, `"delete"`. */
  kind: WriteKind;
  /** The model the op targets, e.g. `"Page"`, `"Block"`. */
  model: string;
  /** Ids of ops that must commit before this one. */
  dependsOn?: readonly string[];
  /** A write allowed to fail without aborting the batch. */
  bestEffort?: boolean;
};

/** One planned statement, in execution order. */
export type OrderedStatement = {
  /** Zero-based position in the plan. */
  index: number;
  id: string;
  kind: WriteKind;
  model: string;
  /** Declared prerequisites, preserved from the op. */
  dependsOn: string[];
  bestEffort: boolean;
};

/** The validated, ordered result of {@link planAtomicWrites}. */
export type AtomicWritePlan = {
  /** True when the whole plan must commit or roll back together. */
  atomic: boolean;
  statements: OrderedStatement[];
  /** Statement ids in execution order. */
  ids: string[];
};

/** Why a batch could not be planned. */
export type AtomicWriteReason =
  | "invalid-op"
  | "duplicate-id"
  | "unknown-dependency"
  | "cyclic-dependency"
  | "best-effort-mixed";

/** Thrown by {@link planAtomicWrites} when a batch cannot be all-or-nothing. */
export class AtomicWriteError extends Error {
  readonly reason: AtomicWriteReason;

  constructor(reason: AtomicWriteReason, message: string) {
    super(message);
    this.name = "AtomicWriteError";
    this.reason = reason;
  }
}

type PlannedEntry = { operation: WriteOp; index: number };

/**
 * Validate a batch and return its statements in a deterministic execution
 * order (topological over `dependsOn`, ties broken by input position).
 *
 * Rejects, with {@link AtomicWriteError}:
 * - `invalid-op` — a blank/missing id or model;
 * - `duplicate-id` — the same id twice;
 * - `unknown-dependency` — `dependsOn` names an op that is not in the batch;
 * - `cyclic-dependency` — a self-loop or a longer cycle;
 * - `best-effort-mixed` — a best-effort write alongside other writes, which
 *   would make the batch partly-applied by design.
 */
export function planAtomicWrites(ops: readonly WriteOp[]): AtomicWritePlan {
  const entries: PlannedEntry[] = ops.map((operation, index) => ({ operation, index }));

  for (const { operation, index } of entries) {
    const id = typeof operation.id === "string" ? operation.id.trim() : "";
    const model = typeof operation.model === "string" ? operation.model.trim() : "";
    if (id === "" || model === "") {
      throw new AtomicWriteError(
        "invalid-op",
        `Write op at index ${index} must have a non-empty id and model.`,
      );
    }
  }

  const byId = new Map<string, PlannedEntry>();
  for (const entry of entries) {
    if (byId.has(entry.operation.id)) {
      throw new AtomicWriteError(
        "duplicate-id",
        `Write op id "${entry.operation.id}" appears more than once.`,
      );
    }
    byId.set(entry.operation.id, entry);
  }

  if (entries.length > 1 && entries.some((entry) => entry.operation.bestEffort === true)) {
    throw new AtomicWriteError(
      "best-effort-mixed",
      "A best-effort write cannot be mixed into an atomic transaction.",
    );
  }

  for (const entry of entries) {
    for (const dependency of entry.operation.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new AtomicWriteError(
          "unknown-dependency",
          `Write op "${entry.operation.id}" depends on unknown op "${dependency}".`,
        );
      }
    }
  }

  const placed = new Set<string>();
  const ordered: PlannedEntry[] = [];
  while (ordered.length < entries.length) {
    let picked: PlannedEntry | null = null;
    for (const entry of entries) {
      if (placed.has(entry.operation.id)) continue;
      const dependencies = entry.operation.dependsOn ?? [];
      if (dependencies.every((dependency) => placed.has(dependency))) {
        picked = entry;
        break;
      }
    }
    if (picked === null) {
      throw new AtomicWriteError(
        "cyclic-dependency",
        "Write ops contain a dependency cycle and cannot be ordered.",
      );
    }
    placed.add(picked.operation.id);
    ordered.push(picked);
  }

  const statements: OrderedStatement[] = ordered.map((entry, index) => ({
    index,
    id: entry.operation.id,
    kind: entry.operation.kind,
    model: entry.operation.model,
    dependsOn: [...(entry.operation.dependsOn ?? [])],
    bestEffort: entry.operation.bestEffort === true,
  }));

  return {
    atomic: !statements.some((statement) => statement.bestEffort),
    statements,
    ids: statements.map((statement) => statement.id),
  };
}

/** One ordered slice of a write batch. */
export type WriteChunk = {
  /** Zero-based chunk position. */
  index: number;
  ops: WriteOp[];
};

/**
 * Split `ops` into ordered chunks of at most `size` ops.
 *
 * A non-finite size collapses the batch into a single chunk; a non-positive
 * (or sub-1 fractional) size falls back to one op per chunk. Order is always
 * preserved and the result is deterministic. An empty batch yields `[]`.
 */
export function chunkWrites(ops: readonly WriteOp[], size: number): WriteChunk[] {
  if (ops.length === 0) return [];

  let step: number;
  if (!Number.isFinite(size)) {
    step = ops.length;
  } else {
    const floored = Math.floor(size);
    step = floored < 1 ? 1 : floored;
  }

  const chunks: WriteChunk[] = [];
  for (let start = 0; start < ops.length; start += step) {
    chunks.push({ index: chunks.length, ops: ops.slice(start, start + step) });
  }
  return chunks;
}

/** The observed outcome of one planned statement. */
export type WriteResult = {
  id: string;
  ok: boolean;
};

/** The audit of a plan's results. */
export type PartialWriteReport = {
  /** True when the batch was all-or-nothing (all committed, or none). */
  consistent: boolean;
  /** Ids that committed, in plan order. */
  committed: string[];
  /** Ids that reported failure, in plan order. */
  failed: string[];
  /** Ids with no result at all, in plan order. */
  missing: string[];
  /** On an inconsistent plan, the committed ids that must be reconciled. */
  conflicts: string[];
};

/**
 * Compare a plan against its per-op results.
 *
 * A plan is consistent when either every op committed or nothing committed —
 * a wholesale rollback (including ops that never reported) leaves no partial
 * state. Anything in between is a partial write, and the committed ids are
 * listed as conflicts. Results for ids outside the plan are ignored.
 */
export function detectPartialWrite(
  plan: AtomicWritePlan,
  results: readonly WriteResult[],
): PartialWriteReport {
  const known = new Set(plan.ids);
  const outcomes = new Map<string, boolean>();
  for (const result of results) {
    if (known.has(result.id)) outcomes.set(result.id, result.ok === true);
  }

  const committed: string[] = [];
  const failed: string[] = [];
  const missing: string[] = [];

  for (const id of plan.ids) {
    const outcome = outcomes.get(id);
    if (outcome === undefined) {
      missing.push(id);
    } else if (outcome) {
      committed.push(id);
    } else {
      failed.push(id);
    }
  }

  const allSucceeded = plan.ids.length > 0 && committed.length === plan.ids.length;
  const consistent = committed.length === 0 || allSucceeded;

  return {
    consistent,
    committed,
    failed,
    missing,
    conflicts: consistent ? [] : [...committed],
  };
}

/** Thrown by {@link assertNoPartialWrite} when a batch half-applied. */
export class PartialWriteError extends Error {
  readonly report: PartialWriteReport;

  constructor(report: PartialWriteReport) {
    const conflicts =
      report.conflicts.length > 0 ? report.conflicts.join(", ") : "an unknown set of writes";
    super(`Atomic write plan partially applied: ${conflicts} committed without the full batch.`);
    this.name = "PartialWriteError";
    this.report = report;
  }
}

/**
 * Assert that `plan` was applied atomically, throwing {@link PartialWriteError}
 * (which carries the full report) when it was not. Returns the report when the
 * batch is consistent so callers can still inspect it.
 */
export function assertNoPartialWrite(
  plan: AtomicWritePlan,
  results: readonly WriteResult[],
): PartialWriteReport {
  const report = detectPartialWrite(plan, results);
  if (!report.consistent) throw new PartialWriteError(report);
  return report;
}

/**
 * In-process background-job runner — the pure, deterministic core
 * (docs/FEATURE_MATRIX.md §17, "Background jobs": an async task runner/queue
 * for imports and AI work).
 *
 * {@link JobQueue} is an in-memory job store plus a small state machine, with
 * every effectful dependency kept at the edge:
 *
 *  - `enqueue` adds a job in `queued` state, eligible at `runAt` (default: now);
 *  - `claim(now, { limit })` takes the due jobs — `queued` and `runAt <= now` —
 *    in deterministic order and flips them to `running`, counting the attempt;
 *  - `complete(id)` marks a job `done`; completing twice is a no-op;
 *  - `fail(id, error, now)` records the error and either requeues the job for a
 *    later retry (exponential backoff, {@link backoffDelay}) or dead-letters it
 *    once `maxAttempts` attempts are spent;
 *  - `retryDue(now)` is a read-only view of the jobs a claim would pick;
 *  - `stats()` reports counts per status; `drainOnce(handler)` claims a batch,
 *    runs the handler over each and completes/fails it.
 *
 * Ordering is deterministic and stable: ascending `runAt`, ties broken by
 * insertion order (an auto-incrementing `seq`). The clock is always injected —
 * the explicit `now` arguments above, plus the `{ now }` provider used by
 * `drainOnce` — so nothing here calls `Date.now()`. There is no DB, no I/O and
 * nothing the caller passes is ever mutated: every method returns fresh
 * snapshots.
 */

/** Lifecycle state of a job. */
export type JobStatus = "queued" | "running" | "done" | "dead";

/** Opaque job data. Kept JSON-shaped so it can round-trip through a store later. */
export type JobPayload = Record<string, unknown>;

/** A job as stored and as returned by every method (always a fresh copy). */
export type Job = {
  /** Stable identity, `"<prefix>-<seq>"`. */
  id: string;
  /** What kind of work this is (`"import"`, `"ai-autofill"`, …). */
  kind: string;
  /** Caller-supplied data handed to the handler. */
  payload: JobPayload;
  /** Current lifecycle state. */
  status: JobStatus;
  /** How many times the job has been claimed (attempts started). */
  attempts: number;
  /** Attempts allowed before the job is dead-lettered. Always `>= 1`. */
  maxAttempts: number;
  /** Epoch ms at/after which the job is eligible to be claimed. */
  runAt: number;
  /** Epoch ms the job entered the queue (from the injected clock). */
  createdAt: number;
  /** Insertion order, used to break `runAt` ties deterministically. */
  seq: number;
  /** Epoch ms of the most recent claim; `null` while never claimed. */
  claimedAt: number | null;
  /** Epoch ms of completion; `null` until `complete`. */
  completedAt: number | null;
  /** Message from the most recent failure; `null` while never failed. */
  lastError: string | null;
};

/** Exponential-backoff tuning; every field is optional and normalised on use. */
export type BackoffOptions = {
  /** First-retry delay in ms. Defaults to {@link DEFAULT_BACKOFF}. */
  baseMs?: number;
  /** Growth per attempt. Defaults to {@link DEFAULT_BACKOFF}. */
  factor?: number;
  /** Upper bound in ms. Defaults to {@link DEFAULT_BACKOFF}. */
  maxMs?: number;
};

/** Default backoff: 1s, doubling, capped at 60s. */
export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 1000,
  factor: 2,
  maxMs: 60_000,
};

/** Attempts allowed when neither the job nor the queue specifies one. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Input to {@link JobQueue.enqueue}. */
export type EnqueueInput = {
  /** What kind of work this is; required and non-empty. */
  kind: string;
  /** Caller data handed to the handler. Defaults to `{}`. */
  payload?: JobPayload;
  /** Attempts allowed before dead-lettering. Defaults to the queue's default. */
  maxAttempts?: number;
  /** When the job first becomes eligible. Defaults to `0` (immediately). */
  runAt?: Date | number | string;
};

/** Options for {@link JobQueue.claim} and {@link JobQueue.drainOnce}. */
export type ClaimOptions = {
  /** Maximum number of jobs to claim. Defaults to the queue's `claimLimit`. */
  limit?: number;
};

/** Construction options for {@link JobQueue}. */
export type JobQueueOptions = {
  /** `maxAttempts` applied when `enqueue` omits one. Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  defaultMaxAttempts?: number;
  /** Backoff tuning used by `fail`. Defaults to {@link DEFAULT_BACKOFF}. */
  backoff?: BackoffOptions;
  /** Injected clock for `createdAt`, `completedAt` and `drainOnce`. Defaults to `() => 0`. */
  now?: () => number;
  /** Default claim limit for `claim`/`drainOnce`. Defaults to `10`. */
  claimLimit?: number;
  /** Prefix for generated ids. Defaults to `"job"`. */
  idPrefix?: string;
};

/** A snapshot of queue occupancy, for ops/dashboards. */
export type QueueStats = {
  /** Total jobs ever enqueued (and not removed). */
  total: number;
  /** Jobs waiting to be claimed. */
  queued: number;
  /** Jobs currently claimed/in-flight. */
  running: number;
  /** Jobs completed successfully. */
  done: number;
  /** Jobs dead-lettered after exhausting their attempts. */
  dead: number;
};

/** The work a {@link JobQueue.drainOnce} call performs per claimed job. */
export type JobHandler = (job: Job) => void | Promise<void>;

/** Options for {@link JobQueue.drainOnce}. */
export type DrainOptions = {
  /** Maximum jobs to claim this drain. Defaults to the queue's `claimLimit`. */
  limit?: number;
  /** Clock override for this drain; defaults to the queue's injected clock. */
  now?: number;
};

/** Per-drain tally of what happened. */
export type DrainResult = {
  /** Jobs claimed for this drain. */
  claimed: number;
  /** Jobs whose handler resolved. */
  completed: number;
  /** Jobs that failed but were requeued for a retry. */
  retried: number;
  /** Jobs that failed their final attempt and were dead-lettered. */
  dead: number;
};

/**
 * The delay before the next retry after `attempt` failures.
 *
 * `attempt` is 1-based: the first retry waits `baseMs`, the n-th waits
 * `baseMs * factor^(n-1)`, capped at `maxMs`. Values below 1 are clamped to the
 * first step, and non-finite tuning falls back to {@link DEFAULT_BACKOFF}. The
 * result is always a whole, non-negative number of milliseconds.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = toMs(options.baseMs, DEFAULT_BACKOFF.baseMs);
  const factor = toFactor(options.factor, DEFAULT_BACKOFF.factor);
  const maxMs = toMs(options.maxMs, DEFAULT_BACKOFF.maxMs);
  const step = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const raw = baseMs * Math.pow(factor, step - 1);
  if (!Number.isFinite(raw)) return maxMs;
  return Math.min(Math.max(0, Math.round(raw)), maxMs);
}

/** Coerce a duration to a whole, non-negative number of ms, falling back on non-finite input. */
function toMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Coerce a growth factor to a finite number `>= 0`, falling back on bad input. */
function toFactor(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** Coerce a count to a whole number `>= 1`, falling back on non-finite/negative input. */
function toPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** Coerce a claim limit to a whole number `>= 0`, falling back on non-finite input. */
function toLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return Math.max(0, Math.floor(fallback));
  if (typeof value !== "number" || !Number.isFinite(value)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(value));
}

/** Epoch ms for a `Date`, number or parseable string; unparseable sorts to `0`. */
function instant(value: Date | number | string): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Human-readable text for an unknown thrown value. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A detached copy of a stored job, so callers can never mutate queue state. */
function snapshot(job: Job): Job {
  return { ...job, payload: { ...job.payload } };
}

/** Ascending `runAt`, ties broken by insertion order — the single ordering rule. */
function byDue(a: Job, b: Job): number {
  if (a.runAt !== b.runAt) return a.runAt - b.runAt;
  return a.seq - b.seq;
}

/**
 * An in-process job queue. See the module doc for the lifecycle. All state is
 * private; every method returns fresh snapshots and never mutates its arguments.
 */
export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;
  private readonly defaultMaxAttempts: number;
  private readonly backoff: BackoffOptions;
  private readonly clock: () => number;
  private readonly claimLimit: number;
  private readonly idPrefix: string;

  constructor(options: JobQueueOptions = {}) {
    this.defaultMaxAttempts = toPositiveInt(options.defaultMaxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.backoff = options.backoff ?? {};
    this.clock = options.now ?? (() => 0);
    this.claimLimit = toPositiveInt(options.claimLimit, 10);
    this.idPrefix = options.idPrefix ?? "job";
  }

  /**
   * Add a job in `queued` state. Defaults: `runAt = 0` (immediately eligible),
   * `maxAttempts` from the queue's default, `payload = {}`. Throws a
   * `TypeError` when `kind` is missing or blank.
   */
  enqueue(input: EnqueueInput): Job {
    if (
      input === null ||
      typeof input !== "object" ||
      typeof input.kind !== "string" ||
      input.kind.trim() === ""
    ) {
      throw new TypeError("enqueue requires a non-empty kind");
    }
    this.seq += 1;
    const job: Job = {
      id: `${this.idPrefix}-${this.seq}`,
      kind: input.kind,
      payload: input.payload ? { ...input.payload } : {},
      status: "queued",
      attempts: 0,
      maxAttempts: toPositiveInt(input.maxAttempts, this.defaultMaxAttempts),
      runAt: input.runAt === undefined ? 0 : instant(input.runAt),
      createdAt: this.clock(),
      seq: this.seq,
      claimedAt: null,
      completedAt: null,
      lastError: null,
    };
    this.jobs.set(job.id, job);
    return snapshot(job);
  }

  /**
   * Claim up to `limit` due jobs at `now` (`queued` and `runAt <= now`), in
   * `runAt`-then-insertion order. Each claimed job becomes `running`, its
   * `attempts` is incremented and `claimedAt` stamped. Returns the claimed
   * snapshots (empty when nothing is due or the limit is `<= 0`).
   */
  claim(now: number, options: ClaimOptions = {}): Job[] {
    const limit = toLimit(options.limit, this.claimLimit);
    if (limit <= 0) return [];
    return this.dueSorted(now)
      .slice(0, limit)
      .map((job) => {
        job.status = "running";
        job.attempts += 1;
        job.claimedAt = now;
        return snapshot(job);
      });
  }

  /**
   * Mark a job `done`, stamping `completedAt` (`now` or the injected clock).
   * Idempotent: completing an already-`done` job returns it unchanged. A
   * `dead` job is left as-is. Unknown id ⇒ `null`.
   */
  complete(id: string, now?: number): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "done" || job.status === "dead") return snapshot(job);
    job.status = "done";
    job.completedAt = now === undefined ? this.clock() : now;
    return snapshot(job);
  }

  /**
   * Record a failure for a claimed (or queued) job. The message is stored, and
   * the job is either requeued at `now + backoffDelay(attempts)` or, once
   * `attempts >= maxAttempts`, dead-lettered. A `done` or `dead` job is left
   * as-is. Unknown id ⇒ `null`.
   */
  fail(id: string, error: unknown, now: number): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "done" || job.status === "dead") return snapshot(job);
    job.lastError = errorText(error);
    if (job.attempts >= job.maxAttempts) {
      job.status = "dead";
      job.runAt = now;
      return snapshot(job);
    }
    job.status = "queued";
    job.runAt = now + backoffDelay(job.attempts, this.backoff);
    job.claimedAt = null;
    return snapshot(job);
  }

  /**
   * Read-only view of the jobs a claim at `now` would take: `queued` jobs with
   * `runAt <= now`, in deterministic order. Never mutates state.
   */
  retryDue(now: number): Job[] {
    return this.dueSorted(now).map(snapshot);
  }

  /** Counts of jobs by status, plus the total. */
  stats(): QueueStats {
    const stats: QueueStats = { total: this.jobs.size, queued: 0, running: 0, done: 0, dead: 0 };
    for (const job of this.jobs.values()) stats[job.status] += 1;
    return stats;
  }

  /**
   * Claim up to `limit` jobs at `now`, run `handler` over each in order, then
   * complete the ones that resolve and fail the ones that throw (so a thrown
   * handler feeds the normal backoff/dead-letter path). Returns a per-drain
   * tally. Sequential and awaited, so ordering within a drain is deterministic.
   */
  async drainOnce(handler: JobHandler, options: DrainOptions = {}): Promise<DrainResult> {
    const now = options.now === undefined ? this.clock() : options.now;
    const claimed = this.claim(now, { limit: options.limit });
    const result: DrainResult = { claimed: claimed.length, completed: 0, retried: 0, dead: 0 };
    for (const job of claimed) {
      try {
        await handler(job);
        this.complete(job.id, now);
        result.completed += 1;
      } catch (error) {
        const failed = this.fail(job.id, error, now);
        if (failed?.status === "dead") result.dead += 1;
        else result.retried += 1;
      }
    }
    return result;
  }

  /** Snapshot of a single job, or `null` when unknown (test/ops helper). */
  get(id: string): Job | null {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : null;
  }

  /** Number of stored jobs (test/ops helper). */
  size(): number {
    return this.jobs.size;
  }

  /** Drop every job and reset id numbering (test/ops helper). */
  reset(): void {
    this.jobs.clear();
    this.seq = 0;
  }

  /** Due jobs in deterministic order, as stored references (internal use). */
  private dueSorted(now: number): Job[] {
    return [...this.jobs.values()]
      .filter((job) => job.status === "queued" && job.runAt <= now)
      .sort(byDue);
  }
}

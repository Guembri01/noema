/**
 * Background job queue — a pure, in-memory scheduling model for deferred work.
 *
 * This is the reference policy behind "run this later / retry on failure"
 * processing (sending an email, delivering a webhook, running a cleanup pass).
 * It is **not** a worker: it holds no timers, no storage and no network. Every
 * operation is a **pure, immutable** function that takes a queue array plus an
 * injected `now` (epoch ms) and returns a new array — the argument and the jobs
 * handed in are never mutated. That keeps the whole scheduling policy
 * deterministic, clock-free and unit-testable, and lets the same code run on
 * the client, the server, or inside a cron loop.
 *
 * A {@link Job} is one unit of deferred work addressed by a stable `id`.
 * `runAt` is the earliest instant it may run; `attempts` counts failed
 * deliveries so far and `maxAttempts` caps them. A job that is currently being
 * worked on carries a `leaseUntil` instant — a claim, not a lock. Claiming
 * stamps the lease; {@link complete} drops the job and {@link fail} either
 * reschedules it (with exponential backoff, exactly as
 * {@link backoffFor} from `offline-queue`) or drops it once it is exhausted.
 *
 * The retry/backoff semantics intentionally mirror `src/lib/offline-queue.ts`
 * so both queues age failed work the same way.
 */

import { backoffFor } from "@/lib/offline-queue";

/** A job's verb. Kept open (`string`) so callers can extend the vocabulary. */
export type JobKind = string;

/**
 * A job admitted to the queue. Treat as immutable; transitions return copies.
 *
 * A job is **runnable** at `now` when it is not actively leased
 * (`leaseUntil === null || leaseUntil <= now`) and `runAt <= now`.
 */
export type Job = {
  /** Caller-supplied identity, stable across retries. */
  id: string;
  /** The verb (`"email"`, `"webhook"`, `"cleanup"`, …). */
  kind: JobKind;
  /** Earliest instant (unix ms) the job may run. */
  runAt: number;
  /** Failed delivery attempts so far; `0` until the first failure. */
  attempts: number;
  /** Cap on attempts before the job is dropped; always `>= 1`. */
  maxAttempts: number;
  /**
   * Epoch ms the current claim expires, or `null` when the job is not leased.
   * A lease at or before `now` is considered expired and the job is runnable
   * again.
   */
  leaseUntil: number | null;
};

/** A caller-supplied job before the queue defaults `attempts` / `maxAttempts`. */
export type JobDraft = {
  id: string;
  kind: JobKind;
  runAt: number;
  /** Defaults to `0`. */
  attempts?: number;
  /** Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Defaults to `null` (not leased). */
  leaseUntil?: number | null;
};

/** Tuning for a {@link claimDue} batch. */
export type ClaimOptions = {
  /** Maximum number of jobs to claim; clamped to a whole number `>= 0`. */
  limit: number;
  /** How long (ms) each claim survives before it can be re-claimed; `>= 0`. */
  leaseMs: number;
};

/** The outcome of a {@link claimDue} call: the leased jobs and the updated queue. */
export type ClaimResult = {
  /** The jobs claimed by this call, each stamped with its lease. */
  claimed: Job[];
  /** A new queue with the claimed jobs' leases applied and everything else unchanged. */
  queue: Job[];
};

/** A snapshot of queue composition at an injected `now`. */
export type JobStats = {
  /** Every job in the queue. */
  total: number;
  /** Runnable now: not leased and `runAt <= now`. */
  due: number;
  /** Actively leased now (`leaseUntil > now`). */
  running: number;
  /** Scheduled for the future: not leased and `runAt > now`. */
  pending: number;
  /** Jobs with at least one failed attempt (`attempts > 0`). */
  retrying: number;
  /** Count of jobs per `kind`. */
  byKind: Record<string, number>;
};

/** Attempt cap applied when a draft omits `maxAttempts`. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Coerce a count to a whole number `>= 1`, falling back on non-finite input. */
function toCount(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** Coerce a duration to a whole number `>= 0`, falling back on non-finite input. */
function toDuration(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Whether a job is under a lease that is still active at `now`. */
function isLeased(job: Job, now: number): boolean {
  return job.leaseUntil !== null && job.leaseUntil > now;
}

/**
 * Admit a job to the queue, defaulting `attempts` to `0`, `maxAttempts` to
 * {@link DEFAULT_MAX_ATTEMPTS} and `leaseUntil` to `null`. The job is appended
 * and a fresh array is returned; the input queue and the draft are untouched.
 */
export function schedule(queue: readonly Job[], job: JobDraft): Job[] {
  const queued: Job = {
    id: job.id,
    kind: job.kind,
    runAt: job.runAt,
    attempts: job.attempts ?? 0,
    maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    leaseUntil: job.leaseUntil ?? null,
  };
  return [...queue, queued];
}

/**
 * Claim the runnable jobs at `now` — the next batch of work a worker should
 * pick up — and stamp each with a lease ending `leaseMs` after `now`.
 *
 * A job is runnable when it is not actively leased and `runAt <= now` (the
 * boundary is inclusive). Runnable jobs are ordered by `runAt` ascending, with
 * ties keeping their insertion order (stable), and at most `limit` are taken.
 * `limit` is clamped to `[0, due.length]`; a non-finite `limit` means
 * "everything due". A negative `leaseMs` is clamped to `0` (a lease that
 * expires immediately).
 *
 * Pure: the input queue is not mutated. The returned `queue` is a new array
 * with leases applied to the claimed jobs (matched by `id`), and `claimed`
 * holds detached copies of those leased jobs.
 */
export function claimDue(
  queue: readonly Job[],
  now: number,
  options: ClaimOptions,
): ClaimResult {
  const due = queue
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => !isLeased(job, now) && job.runAt <= now)
    .sort((a, b) => a.job.runAt - b.job.runAt || a.index - b.index);

  const size = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit))
    : due.length;
  const leaseUntil = now + toDuration(options.leaseMs, 0);

  const claimed = due
    .slice(0, size)
    .map(({ job }) => ({ ...job, leaseUntil }));
  const byId = new Map(claimed.map((job) => [job.id, job]));

  return {
    claimed,
    queue: queue.map((job) => {
      const leased = byId.get(job.id);
      return leased ? { ...leased } : job;
    }),
  };
}

/**
 * Drop the job whose `id` was acknowledged. Unknown ids are ignored and a
 * fresh array is always returned; the input queue is not mutated.
 */
export function complete(queue: readonly Job[], id: string): Job[] {
  return queue.filter((job) => job.id !== id);
}

/**
 * Record a failed delivery for `id` at `now`:
 *
 * - while `attempts + 1 < maxAttempts`, the job stays with `attempts`
 *   incremented, its lease cleared, and `runAt` pushed to
 *   `now + backoffFor(attempts + 1)` — the same exponential schedule
 *   `offline-queue` uses; and
 * - once `attempts + 1 >= maxAttempts`, it is **dropped** — permanently
 *   failed.
 *
 * `maxAttempts` defaults to the job's own cap but may be overridden per call
 * via `options.maxAttempts`. An unknown id yields a fresh copy of the queue.
 * Pure: the input queue is not mutated.
 */
export function fail(
  queue: readonly Job[],
  id: string,
  now: number,
  options: { maxAttempts?: number } = {},
): Job[] {
  const next: Job[] = [];
  for (const job of queue) {
    if (job.id !== id) {
      next.push(job);
      continue;
    }
    const maxAttempts = toCount(options.maxAttempts ?? job.maxAttempts, job.maxAttempts);
    const attempts = job.attempts + 1;
    if (attempts >= maxAttempts) continue;
    next.push({ ...job, attempts, runAt: now + backoffFor(attempts), leaseUntil: null });
  }
  return next;
}

/**
 * Summarise the queue at `now`. `due`, `running` and `pending` partition
 * `total`; `retrying` counts jobs with a non-zero `attempts`; `byKind` tallies
 * jobs per verb. Pure and deterministic — the only input is the queue and the
 * injected `now`.
 */
export function stats(queue: readonly Job[], now: number): JobStats {
  const out: JobStats = {
    total: queue.length,
    due: 0,
    running: 0,
    pending: 0,
    retrying: 0,
    byKind: {},
  };
  for (const job of queue) {
    if (isLeased(job, now)) out.running += 1;
    else if (job.runAt <= now) out.due += 1;
    else out.pending += 1;
    if (job.attempts > 0) out.retrying += 1;
    out.byKind[job.kind] = (out.byKind[job.kind] ?? 0) + 1;
  }
  return out;
}

/**
 * Offline mutation queue — the pure, in-memory reference implementation behind
 * the mobile/web "keep editing while offline, flush when back online" path.
 *
 * Every operation here is **pure and immutable**: functions take a queue array
 * and return a new one, never mutating the argument or the drafts handed in. No
 * timers, no storage, no network — callers own the clock, the transport and the
 * persistence. That keeps the whole replay policy unit-testable and lets the
 * same code run on the client and (if needed) on the server.
 *
 * A {@link QueuedMutation} is a single edit addressed at one `targetId`
 * (a block, page, row, …). `seq` is a monotonic insertion counter that defines
 * the replay order; `attempts` tracks how many delivery attempts have failed so
 * far. Mutations that share a target and touch the same field can be
 * {@link coalesce}d so a burst of keystrokes collapses into one write.
 */

/** A mutation's verb. Kept open (`string`) so callers can extend the vocabulary. */
export type MutationKind = string;

/** The field changes a mutation carries; keys are field names, values are the new values. */
export type MutationPayload = Record<string, unknown>;

/** A mutation that has been admitted to the durable queue. */
export type QueuedMutation = {
  /** Caller-supplied identity, stable across retries. */
  id: string;
  /** Monotonic insertion counter; defines replay order. */
  seq: number;
  /** The verb (`"update"`, `"create"`, `"delete"`, …). */
  kind: MutationKind;
  /** The entity the mutation applies to. */
  targetId: string;
  /** The field values to write. */
  payload: MutationPayload;
  /** Caller-supplied creation timestamp (unix ms). */
  createdAt: number;
  /** Failed delivery attempts so far; `0` until the first failure. */
  attempts: number;
};

/** A caller-supplied mutation before the queue assigns `seq` / defaults `attempts`. */
export type MutationDraft = {
  id: string;
  kind: MutationKind;
  targetId: string;
  payload: MutationPayload;
  createdAt: number;
  /** Defaults to `0`. */
  attempts?: number;
};

/** Base delay (ms) applied after the first failed attempt. */
export const BACKOFF_BASE_MS = 1_000;

/** Multiplier applied for each subsequent attempt. */
export const BACKOFF_FACTOR = 2;

/** Upper bound (ms) on any single backoff delay. */
export const BACKOFF_CAP_MS = 60_000;

/** The next monotonic `seq`: one past the highest currently in the queue. */
function nextSeq(queue: readonly QueuedMutation[]): number {
  let max = 0;
  for (const mutation of queue) {
    if (mutation.seq > max) max = mutation.seq;
  }
  return max + 1;
}

/**
 * Admit a draft to the queue, assigning a monotonic `seq` and defaulting
 * `attempts` to `0`. The new mutation is appended and a fresh array is returned;
 * the input queue and the draft are left untouched.
 *
 * `seq` is `max(seq) + 1`, so order survives prior {@link markDone} removals
 * (the counter never rewinds to a value still in use).
 */
export function enqueue(
  queue: readonly QueuedMutation[],
  mutation: MutationDraft,
): QueuedMutation[] {
  const queued: QueuedMutation = {
    id: mutation.id,
    seq: nextSeq(queue),
    kind: mutation.kind,
    targetId: mutation.targetId,
    payload: mutation.payload,
    createdAt: mutation.createdAt,
    attempts: mutation.attempts ?? 0,
  };
  return [...queue, queued];
}

/**
 * Replay order: a new array sorted by `seq` ascending. Equal `seq` values keep
 * their input order (the sort is stable), so the result is deterministic.
 */
export function replayOrder(queue: readonly QueuedMutation[]): QueuedMutation[] {
  return [...queue].sort((a, b) => a.seq - b.seq);
}

/** True when two payloads share at least one field name. */
function sharesField(a: MutationPayload, b: MutationPayload): boolean {
  for (const key of Object.keys(a)) {
    if (Object.prototype.hasOwnProperty.call(b, key)) return true;
  }
  return false;
}

/**
 * Collapse **consecutive** mutations that target the same entity with the same
 * verb and touch the same field: a shallow merge of the payloads with the later
 * mutation winning on shared keys. The merged entry keeps the later mutation's
 * identity (`id`, `seq`, `createdAt`, `kind`, `targetId`) so it still sits last
 * in the queue, but preserves the highest `attempts` seen so retry history is
 * not lost.
 *
 * Non-adjacent writes, disjoint fields, and different verbs are never merged.
 * A second pass coalesces runs longer than two (a, b, c → one entry). Pure: the
 * input is not mutated and the output is returned in `seq` order.
 */
export function coalesce(queue: readonly QueuedMutation[]): QueuedMutation[] {
  const ordered = replayOrder(queue);
  const out: QueuedMutation[] = [];
  for (const mutation of ordered) {
    const previous = out[out.length - 1];
    const mergeable =
      previous !== undefined &&
      previous.targetId === mutation.targetId &&
      previous.kind === mutation.kind &&
      sharesField(previous.payload, mutation.payload);
    if (mergeable) {
      out[out.length - 1] = {
        ...mutation,
        payload: { ...previous.payload, ...mutation.payload },
        attempts: Math.max(previous.attempts, mutation.attempts),
      };
      continue;
    }
    out.push(mutation);
  }
  return out;
}

/**
 * The next batch to dispatch: the first `max` mutations in replay order.
 * `max` is clamped to `[0, queue.length]`; a non-finite `max` is treated as
 * "everything". Pure — the input queue is not mutated.
 */
export function nextBatch(
  queue: readonly QueuedMutation[],
  options: { max: number },
): QueuedMutation[] {
  const size = Number.isFinite(options.max)
    ? Math.max(0, Math.floor(options.max))
    : queue.length;
  return replayOrder(queue).slice(0, size);
}

/** The number of mutations still awaiting delivery. */
export function pendingCount(queue: readonly QueuedMutation[]): number {
  return queue.length;
}

/**
 * Drop every mutation whose `id` is in `ids` (they were acknowledged). Unknown
 * ids are ignored and a fresh array is always returned.
 */
export function markDone(
  queue: readonly QueuedMutation[],
  ids: readonly string[],
): QueuedMutation[] {
  const done = new Set(ids);
  return queue.filter((mutation) => !done.has(mutation.id));
}

/**
 * Record a failed delivery for `id`:
 *
 * - while `attempts + 1 < maxAttempts`, the mutation stays with `attempts`
 *   incremented (and is retried later at {@link backoffFor}); and
 * - once `attempts + 1 >= maxAttempts`, it is **dropped** — permanently failed.
 *
 * An unknown id (or a queue with no such row) yields a fresh copy of the queue.
 */
export function markFailed(
  queue: readonly QueuedMutation[],
  id: string,
  options: { maxAttempts: number },
): QueuedMutation[] {
  const next: QueuedMutation[] = [];
  for (const mutation of queue) {
    if (mutation.id !== id) {
      next.push(mutation);
      continue;
    }
    const attempts = mutation.attempts + 1;
    if (attempts >= options.maxAttempts) continue;
    next.push({ ...mutation, attempts });
  }
  return next;
}

/**
 * Exponential backoff for a 1-based `attempt`: `base * factor^(attempt - 1)`,
 * capped at {@link BACKOFF_CAP_MS}. Non-positive / non-finite attempts yield
 * `0` (no wait). Deterministic — no jitter.
 */
export function backoffFor(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  const delay = BACKOFF_BASE_MS * BACKOFF_FACTOR ** (Math.floor(attempt) - 1);
  return Math.min(delay, BACKOFF_CAP_MS);
}

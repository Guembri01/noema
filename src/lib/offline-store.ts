/**
 * Offline persistence store — the durable shell around the pure
 * {@link "@/lib/offline-queue"} policy.
 *
 * `offline-queue.ts` owns the *what*: how mutations are ordered, coalesced and
 * retried, with no clock, storage or network of its own. This module owns the
 * *where*: a tiny, storage-agnostic {@link OfflineBackend} (`read` / `write`)
 * that the same store drives over `localStorage`, IndexedDB, a service worker
 * cache, or — in tests — an in-memory array. Nothing here touches a platform
 * API directly, so the whole thing runs unchanged on the client, in a worker,
 * or under Node.
 *
 * A store is a *stateful, async* handle by design (like `lru.ts` or
 * `session-store.ts`): every method reads the backend, applies a pure
 * `offline-queue` transform, writes the result back, and returns a plain value.
 * Concurrent calls are serialized through a private promise chain, so two
 * `enqueue`s racing across microtasks can never lose a read-modify-write — the
 * backend only ever sees whole, sequenced queues.
 *
 * The public surface is `createOfflineStore(backend)` →
 *   • `enqueue(draft)`    — admit an edit and persist the new `seq`.
 *   • `pending()`         — the queue in replay order.
 *   • `drain(batch)`      — acknowledge a delivered batch (objects or ids).
 *   • `snapshot()`        — a deterministic summary for the "unsynced" badge.
 */

import {
  enqueue as appendMutation,
  markDone,
  replayOrder,
  type MutationDraft,
  type QueuedMutation,
} from "@/lib/offline-queue";

/**
 * The persistence seam. A backend stores *one* queue (an ordered list of
 * {@link QueuedMutation}s) and nothing else — it does not know about `seq`,
 * coalescing or ordering, so a dumb `localStorage.setItem(key, JSON.stringify)`
 * or an IndexedDB object store both qualify.
 *
 * `read` returns `null` when nothing has been persisted yet (a fresh install),
 * which the store treats exactly like an empty queue. `write` replaces the
 * whole queue atomically; implementations should not partially persist.
 */
export type OfflineBackend = {
  read(): Promise<readonly QueuedMutation[] | null>;
  write(queue: readonly QueuedMutation[]): Promise<void>;
};

/** A batch to acknowledge: the mutations themselves, or just their ids. */
export type DrainBatch = readonly QueuedMutation[] | readonly string[];

/**
 * A point-in-time summary of the queue, cheap enough to recompute for a badge
 * or a "N changes waiting to sync" hint without the caller walking the queue.
 * Timestamps are `null` when the queue is empty.
 */
export type OfflineSnapshot = {
  /** Live mutations in replay order (a fresh array). */
  mutations: QueuedMutation[];
  /** How many mutations await delivery (`mutations.length`). */
  pending: number;
  /** The `seq` the next {@link OfflineStore.enqueue} will assign. */
  nextSeq: number;
  /** Total failed delivery attempts across the queue. */
  attempts: number;
  /** `createdAt` of the oldest pending mutation, or `null` when empty. */
  oldestCreatedAt: number | null;
  /** `createdAt` of the newest pending mutation, or `null` when empty. */
  newestCreatedAt: number | null;
};

/** The handle returned by {@link createOfflineStore}. */
export type OfflineStore = {
  /**
   * Admit `draft` to the queue (assigning a monotonic `seq`), persist it, and
   * return the stored mutation. The draft is not mutated.
   */
  enqueue(mutation: MutationDraft): Promise<QueuedMutation>;
  /** The persisted queue in replay order (`seq` ascending). */
  pending(): Promise<QueuedMutation[]>;
  /** Drop an acknowledged batch, persist, and return what remains. */
  drain(batch: DrainBatch): Promise<QueuedMutation[]>;
  /** Summarize the persisted queue (see {@link OfflineSnapshot}). */
  snapshot(): Promise<OfflineSnapshot>;
};

/**
 * In-memory backend — the deterministic double for tests and for a
 * client that wants to run fully offline for the session. `read` and `write`
 * both copy, so the caller can never alias (and accidentally mutate) the
 * stored queue through a returned array or a written argument.
 */
export function createMemoryBackend(
  initial: readonly QueuedMutation[] | null = null,
): OfflineBackend {
  const clone = (queue: readonly QueuedMutation[]): QueuedMutation[] =>
    queue.map((mutation) => ({ ...mutation, payload: { ...mutation.payload } }));
  let stored: QueuedMutation[] | null = initial === null ? null : clone(initial);
  return {
    async read() {
      return stored === null ? null : clone(stored);
    },
    async write(queue) {
      stored = clone(queue);
    },
  };
}

/** Read the persisted queue, normalizing "nothing yet" to an empty array. */
async function readQueue(backend: OfflineBackend): Promise<QueuedMutation[]> {
  const stored = await backend.read();
  return stored ? [...stored] : [];
}

/** Normalize a {@link DrainBatch} to the ids {@link markDone} consumes. */
function acknowledgedIds(batch: DrainBatch): string[] {
  const ids: string[] = [];
  for (const entry of batch) {
    ids.push(typeof entry === "string" ? entry : entry.id);
  }
  return ids;
}

/**
 * Create a store bound to `backend`. The returned handle reads and writes the
 * backend on every call, so it holds no cache: two stores over the same
 * backend observe each other's writes immediately.
 *
 * All four methods are serialized through one promise chain (per store). A
 * task that rejects does not wedge the chain — the next call runs regardless —
 * so a transient backend error is not sticky.
 */
export function createOfflineStore(backend: OfflineBackend): OfflineStore {
  let tail: Promise<void> = Promise.resolve();

  /** Run `task` after every previously queued task, whatever their outcome. */
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    enqueue(mutation) {
      return exclusive(async () => {
        const queue = appendMutation(await readQueue(backend), mutation);
        await backend.write(queue);
        return queue[queue.length - 1];
      });
    },

    pending() {
      return exclusive(async () => replayOrder(await readQueue(backend)));
    },

    drain(batch) {
      return exclusive(async () => {
        const remaining = markDone(await readQueue(backend), acknowledgedIds(batch));
        await backend.write(remaining);
        return replayOrder(remaining);
      });
    },

    snapshot() {
      return exclusive(async () => {
        const mutations = replayOrder(await readQueue(backend));
        let nextSeq = 1;
        let attempts = 0;
        let oldest: number | null = null;
        let newest: number | null = null;
        for (const mutation of mutations) {
          if (mutation.seq >= nextSeq) nextSeq = mutation.seq + 1;
          attempts += mutation.attempts;
          if (oldest === null || mutation.createdAt < oldest) oldest = mutation.createdAt;
          if (newest === null || mutation.createdAt > newest) newest = mutation.createdAt;
        }
        return {
          mutations,
          pending: mutations.length,
          nextSeq,
          attempts,
          oldestCreatedAt: oldest,
          newestCreatedAt: newest,
        };
      });
    },
  };
}

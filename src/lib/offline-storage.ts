/**
 * Offline storage adapters + the `offline-store` bridge (§17 Offline cache).
 *
 * `offline-cache.ts` is the **canonical** offline engine. Beyond its TTL+LRU
 * entry cache it owns the on-disk *queue envelope*: one namespace
 * ({@link OFFLINE_CACHE_PREFIX}), one schema version
 * ({@link OFFLINE_CACHE_SCHEMA_VERSION}) and one mutations key
 * ({@link OFFLINE_MUTATIONS_KEY}). Every adapter here writes into that canonical
 * shape, so the cache's entries and its replay queue survive a reload together.
 *
 * Two adapters implement {@link OfflineStorage} over a platform store:
 *
 *  - {@link createWebStorage} wraps a synchronous `localStorage`/`sessionStorage`
 *    (the fast, ubiquitous default);
 *  - {@link createIndexedDbStorage} wraps an IndexedDB object store (durable,
 *    larger quota) — used by {@link createDefaultStorage} when IndexedDB exists.
 *
 * {@link createOfflineBackend} is the reconciliation seam: it adapts the very
 * same {@link OfflineStorage} into the `offline-store.ts` `OfflineBackend`, so
 * `offline-store.ts` is **load-bearing as the queue policy/delivery layer**
 * (coalescing, batching, backoff — via `offline-queue.ts`) *over the canonical
 * queue*. Because both sides read and write one key in one envelope, a mutation
 * enqueued through either engine is immediately visible to the other. Nothing
 * here touches a platform API unless asked; the memory fallback keeps SSR and
 * Node tests running unchanged.
 */

import {
  OFFLINE_CACHE_PREFIX,
  OFFLINE_CACHE_SCHEMA_VERSION,
  createMemoryStorage,
  type OfflineStorage,
} from "@/lib/offline-cache";
import type { QueuedMutation } from "@/lib/offline-queue";
import type { OfflineBackend } from "@/lib/offline-store";

/**
 * The single storage key the canonical replay queue lives under. Mirrors the
 * private constant inside `offline-cache.ts`, derived from the exported prefix
 * so the two can never drift apart.
 */
export const OFFLINE_MUTATIONS_KEY = `${OFFLINE_CACHE_PREFIX}mutations`;

/** The synchronous web-storage surface (`localStorage` / `sessionStorage`). */
export type WebStorageLike = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * Adapt a synchronous `localStorage`/`sessionStorage` to the async
 * {@link OfflineStorage} seam. `keys()` walks the whole store and sorts, so
 * iteration is deterministic regardless of the browser's key order.
 */
export function createWebStorage(storage: WebStorageLike): OfflineStorage {
  return {
    async getItem(key) {
      return storage.getItem(key);
    },
    async setItem(key, value) {
      storage.setItem(key, value);
    },
    async removeItem(key) {
      storage.removeItem(key);
    },
    async keys() {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null) keys.push(key);
      }
      return keys.sort();
    },
  };
}

/** Options accepted by {@link createIndexedDbStorage}. */
export type IndexedDbOptions = {
  /** Database name; defaults to `"noema-offline"`. */
  database?: string;
  /** Object-store name; defaults to `"offline-cache"`. */
  store?: string;
  /** The IndexedDB factory to use; defaults to the global, when present. */
  factory?: IDBFactory;
};

/**
 * Adapt an IndexedDB object store to the async {@link OfflineStorage} seam —
 * one key maps to one string, exactly like `localStorage`. The connection is
 * opened lazily on first use and reused. With no factory available (SSR, Node
 * tests, a locked-down browser) this degrades to {@link createMemoryStorage}
 * rather than throwing.
 */
export function createIndexedDbStorage(options: IndexedDbOptions = {}): OfflineStorage {
  const factory = options.factory ?? (typeof indexedDB === "undefined" ? null : indexedDB);
  if (factory === null) return createMemoryStorage();

  const databaseName = options.database ?? "noema-offline";
  const storeName = options.store ?? "offline-cache";
  let opened: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (opened !== null) return opened;
    opened = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return opened;
  };

  const transact = <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const transaction = db.transaction(storeName, mode);
          const pending = run(transaction.objectStore(storeName));
          pending.onsuccess = () => resolve(pending.result);
          pending.onerror = () =>
            reject(pending.error ?? new Error("IndexedDB request failed"));
        }),
    );

  return {
    async getItem(key) {
      const value = await transact<unknown>("readonly", (store) => store.get(key));
      return typeof value === "string" ? value : null;
    },
    async setItem(key, value) {
      await transact("readwrite", (store) => store.put(value, key));
    },
    async removeItem(key) {
      await transact("readwrite", (store) => store.delete(key));
    },
    async keys() {
      const keys = await transact<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
      return keys.map((key) => String(key)).sort();
    },
  };
}

/**
 * `localStorage` when the platform exposes one, else an in-memory session store.
 * Access itself can throw (sandboxed iframe, disabled cookies), so it is guarded.
 */
export function createBrowserStorage(): OfflineStorage {
  try {
    if (typeof localStorage !== "undefined") return createWebStorage(localStorage);
  } catch {
    // Fall through to memory.
  }
  return createMemoryStorage();
}

/**
 * The app-shell default: IndexedDB where available (durable, larger quota),
 * else `localStorage`, else memory. Creation is cheap and side-effect free —
 * the IndexedDB connection only opens on first read/write.
 */
export function createDefaultStorage(options: IndexedDbOptions = {}): OfflineStorage {
  if (typeof indexedDB !== "undefined") return createIndexedDbStorage(options);
  return createBrowserStorage();
}

/** A plain object check that narrows `unknown` without `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural guard for a persisted `QueuedMutation` (see `offline-queue.ts`). */
function isQueuedMutation(value: unknown): value is QueuedMutation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.seq === "number" &&
    typeof value.kind === "string" &&
    typeof value.targetId === "string" &&
    isRecord(value.payload) &&
    typeof value.createdAt === "number" &&
    typeof value.attempts === "number"
  );
}

/**
 * The persisted queue envelope. Its shape is `offline-cache.ts`'s private
 * mutations envelope — `{ schemaVersion, mutations }` — mirrored here so the two
 * engines can share one key.
 */
type QueueEnvelope = {
  schemaVersion: number;
  mutations: readonly QueuedMutation[];
};

/**
 * Adapt the canonical {@link OfflineStorage} into the `offline-store.ts`
 * {@link OfflineBackend}: `read()` returns the persisted `QueuedMutation[]`
 * under {@link OFFLINE_MUTATIONS_KEY} (or `null` for a fresh install), and
 * `write()` replaces the whole queue in the cache's schema envelope. With this
 * bridge, `createOfflineStore` and `OfflineCache.pendingMutations()` observe the
 * same queue in both directions.
 */
export function createOfflineBackend(
  storage: OfflineStorage,
  key: string = OFFLINE_MUTATIONS_KEY,
): OfflineBackend {
  return {
    async read() {
      const raw = await storage.getItem(key);
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!isRecord(parsed) || parsed.schemaVersion !== OFFLINE_CACHE_SCHEMA_VERSION) {
        return null;
      }
      if (!Array.isArray(parsed.mutations)) return null;
      const mutations: QueuedMutation[] = [];
      for (const entry of parsed.mutations) {
        if (isQueuedMutation(entry)) mutations.push(entry);
      }
      return mutations;
    },
    async write(queue) {
      const envelope: QueueEnvelope = {
        schemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
        mutations: queue,
      };
      await storage.setItem(key, JSON.stringify(envelope));
    },
  };
}

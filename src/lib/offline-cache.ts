/**
 * Offline document cache — the pure, in-memory TTL+LRU cache layered over an
 * injected storage backend, behind the "read cached documents while offline,
 * refresh when back online" path.
 *
 * A cache is a bounded map of `key → document` where every entry carries an
 * expiry (`storedAt + ttlMs`). It reuses {@link LruCache} (`./lru.ts`) as the
 * recency index: a `put` promotes its key and, on overflow, the
 * least-recently-used key is evicted; a `get` promotes a hit so a repeatedly
 * read document survives eviction. A private map holds the records so `snapshot`
 * can read them **without** disturbing recency.
 *
 * The cache is **pure** in the offline-queue sense: it reads no clock, runs no
 * timers and does no network I/O. Callers inject `now` (unix milliseconds) on
 * every time-sensitive call, so a sequence of operations is fully reproducible
 * in tests.
 *
 * The {@link CacheBackend} is a synchronous store the cache writes through to on
 * `put` and reads from when a key is cold in memory — the seam that lets a
 * restarted app rebuild its hot tier from persistence. Entries evicted, expired
 * or deleted leave the backend too, so the two tiers stay in step.
 */

import { createLru, type LruCache } from "./lru";

/**
 * One cached document plus its lifetime metadata. `expiresAt` is `Infinity` when
 * the entry never expires.
 */
export type CacheRecord<V> = {
  /** The cached document. */
  readonly value: V;
  /** Unix milliseconds the entry was written. */
  readonly storedAt: number;
  /** Unix milliseconds the entry goes stale; `Infinity` means never. */
  readonly expiresAt: number;
};

/**
 * The persistence seam under the cache. A synchronous, side-effect-only store:
 * the cache mirrors every live entry here, so a fresh cache over the same
 * backend can hydrate previously cached documents.
 */
export type CacheBackend<V> = {
  /** Read a persisted record, or `undefined` for a miss. */
  read(key: string): CacheRecord<V> | undefined;
  /** Insert or overwrite a persisted record. */
  write(key: string, record: CacheRecord<V>): void;
  /** Drop a persisted record; a miss is a no-op. */
  remove(key: string): void;
};

/** Options accepted by {@link createOfflineCache} / the {@link OfflineCache} constructor. */
export type OfflineCacheOptions<V> = {
  /** Maximum number of live entries; normalized to a finite integer ≥ 1. */
  capacity: number;
  /** Storage backend; defaults to a private {@link createMemoryBackend}. */
  backend?: CacheBackend<V>;
};

/** Options accepted by {@link OfflineCache.put}. */
export type PutOptions = {
  /** Time-to-live in milliseconds; a non-finite/negative value means "just expired". */
  ttlMs: number;
  /** Timestamp the write happened, in milliseconds (injected — never read). */
  now: number;
};

/** A single entry as seen by {@link OfflineCache.snapshot}. */
export type CacheSnapshotEntry<V> = {
  readonly key: string;
  readonly value: V;
  readonly storedAt: number;
  readonly expiresAt: number;
};

/** An immutable, serializable view of the live entries. */
export type CacheSnapshot<V> = {
  /** The normalized capacity. */
  readonly capacity: number;
  /** Number of live entries (`entries.length`). */
  readonly size: number;
  /** Live entries, most-recently-used first. */
  readonly entries: readonly CacheSnapshotEntry<V>[];
};

/** A usable timestamp: a finite number, else `0`. */
function normalizeNow(now: number): number {
  return Number.isFinite(now) ? now : 0;
}

/**
 * A usable time-to-live: a finite number ≥ 0, `Infinity` for "never expires",
 * and `0` for anything else (a negative, `NaN` or non-number ttl is "expired
 * immediately").
 */
function normalizeTtl(ttlMs: number): number {
  if (ttlMs === Infinity) return Infinity;
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
}

/** Whether a record is stale at `now` (inclusive: it expires *at* `expiresAt`). */
function isExpired(record: CacheRecord<unknown>, now: number): boolean {
  return now >= record.expiresAt;
}

/** Create a {@link CacheBackend} backed by a private `Map`. */
export function createMemoryBackend<V>(): CacheBackend<V> {
  const records = new Map<string, CacheRecord<V>>();
  return {
    read(key) {
      return records.get(key);
    },
    write(key, record) {
      records.set(key, record);
    },
    remove(key) {
      records.delete(key);
    },
  };
}

/**
 * A bounded TTL+LRU cache of documents over an injected storage backend.
 *
 * Mutable by design (recency is state), but it never reads a clock: `put`,
 * `get` and `evictExpired` all take `now`. Prefer the {@link createOfflineCache}
 * factory so the capacity is normalized for you.
 */
export class OfflineCache<V> {
  /** Normalized capacity (a finite integer ≥ 1). */
  readonly capacity: number;

  /** Recency index: keys live here in LRU order; the value is unused. */
  private readonly recency: LruCache<string, true>;

  /** The documents themselves, so reads don't disturb recency. */
  private readonly records = new Map<string, CacheRecord<V>>();

  private readonly backend: CacheBackend<V>;

  constructor({ capacity, backend }: OfflineCacheOptions<V>) {
    this.recency = createLru<string, true>({ capacity });
    this.capacity = this.recency.capacity;
    this.backend = backend ?? createMemoryBackend<V>();
  }

  /**
   * Write `value` under `key` with a fresh expiry of `now + ttlMs`, mark it
   * most-recently-used, and write through to the backend. Inserting a new key at
   * capacity evicts the least-recently-used entry (from memory and backend).
   * Returns the cache to allow chaining.
   */
  put(key: string, value: V, { ttlMs, now }: PutOptions): this {
    const storedAt = normalizeNow(now);
    const ttl = normalizeTtl(ttlMs);
    const record: CacheRecord<V> = {
      value,
      storedAt,
      expiresAt: ttl === Infinity ? Infinity : storedAt + ttl,
    };
    this.insert(key, record);
    this.backend.write(key, record);
    return this;
  }

  /**
   * Read `key` at `now`, promoting a hit. Returns `undefined` for a miss or a
   * stale entry; a stale entry is dropped from memory and the backend. A cold
   * key is hydrated from the backend first.
   */
  get(key: string, now: number): V | undefined {
    const at = normalizeNow(now);
    if (this.recency.has(key)) {
      const record = this.records.get(key);
      if (record === undefined) return undefined;
      if (isExpired(record, at)) {
        this.drop(key);
        return undefined;
      }
      this.recency.set(key, true); // promote
      return record.value;
    }
    const persisted = this.backend.read(key);
    if (persisted === undefined) return undefined;
    if (isExpired(persisted, at)) {
      this.backend.remove(key);
      return undefined;
    }
    this.insert(key, persisted);
    return persisted.value;
  }

  /** Drop `key` from memory and the backend; returns whether it was held. */
  delete(key: string): boolean {
    const existed = this.records.delete(key);
    this.recency.delete(key);
    if (existed) this.backend.remove(key);
    return existed;
  }

  /** Drop every entry from memory and the backend. */
  clear(): void {
    for (const key of this.records.keys()) this.backend.remove(key);
    this.records.clear();
    this.recency.clear();
  }

  /** Live keys, most-recently-used first. A fresh array, safe to mutate. */
  keys(): string[] {
    return this.recency.keys();
  }

  /** Number of held entries (never above `capacity`; may include not-yet-pruned stale entries). */
  size(): number {
    return this.records.size;
  }

  /**
   * Prune every entry stale at `now` from memory and the backend. Returns the
   * removed keys, most-recently-used first (the cache's key order). A prune pass
   * never evicts a live entry, so it is safe to run on every resume.
   */
  evictExpired(now: number): string[] {
    const at = normalizeNow(now);
    const removed: string[] = [];
    for (const key of this.recency.keys()) {
      const record = this.records.get(key);
      if (record === undefined || !isExpired(record, at)) continue;
      this.drop(key);
      removed.push(key);
    }
    return removed;
  }

  /**
   * A plain view of the live entries, most-recently-used first. Read-only: it
   * does not promote keys, so calling it never changes eviction order. Stale
   * entries that have not been {@link evictExpired} yet are still listed.
   */
  snapshot(): CacheSnapshot<V> {
    const entries = this.recency.keys().map((key) => {
      const record = this.records.get(key) as CacheRecord<V>;
      return {
        key,
        value: record.value,
        storedAt: record.storedAt,
        expiresAt: record.expiresAt,
      };
    });
    return { capacity: this.capacity, size: entries.length, entries };
  }

  /**
   * Insert `record` under `key`, promoting it and evicting the
   * least-recently-used key on overflow. The evicted victim is removed from the
   * backend too, keeping the two tiers aligned.
   */
  private insert(key: string, record: CacheRecord<V>): void {
    const isNew = !this.recency.has(key);
    let victim: string | undefined;
    if (isNew && this.recency.size() >= this.capacity) {
      const keys = this.recency.keys(); // most-recent first
      victim = keys[keys.length - 1];
    }
    this.records.set(key, record);
    this.recency.set(key, true);
    if (victim !== undefined && victim !== key) this.drop(victim);
  }

  /** Remove `key` from both tiers. */
  private drop(key: string): void {
    this.records.delete(key);
    this.recency.delete(key);
    this.backend.remove(key);
  }
}

/** Create an empty {@link OfflineCache} with a normalized `capacity`. */
export function createOfflineCache<V>(options: OfflineCacheOptions<V>): OfflineCache<V> {
  return new OfflineCache<V>(options);
}

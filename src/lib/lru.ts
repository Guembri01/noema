/**
 * LRU cache — a small, generic least-recently-used map (F? — the bounded cache
 * the mention search, link-preview and storage helpers layer on top of).
 *
 * The public surface mirrors `Map` (`get`, `set`, `has`, `delete`, `clear`)
 * so callers can read it as a map, plus `keys` (most-recent → least-recent) and
 * `size` for inspection. Unlike the immutable helpers next to it
 * (`undo-stack.ts`, `row-order.ts`), a cache is a *stateful* container by
 * design: `get`/`set` mutate recency, which is exactly the point. Keeping it a
 * class rather than a value avoids threading a new copy through every read —
 * the same trade-off `rate-limit.ts`'s `RateLimiter` makes. It reads no clock
 * and does no I/O, so a sequence of operations is fully reproducible in tests.
 *
 * Recency rides on `Map`'s insertion order: the first key is the
 * least-recently-used victim, the last key is the most recent. A `get` or
 * `set` on an existing key re-inserts it at the end to mark it fresh, and a
 * `set` that overflows `capacity` drops the first key.
 *
 * `createLru({ capacity })` is the factory; `capacity` is normalized to a
 * finite integer ≥ 1 (anything else clamps to 1).
 */

/** Options accepted by {@link createLru}. */
export type LruCacheOptions = {
  /** Maximum number of live entries; normalized to a finite integer ≥ 1. */
  capacity: number;
};

/**
 * A usable capacity: a finite integer ≥ 1. Non-finite input (including a
 * missing value coerced to `NaN`) clamps to `1`, the smallest useful cache.
 */
function normalizeCapacity(capacity: number): number {
  if (!Number.isFinite(capacity)) return 1;
  return Math.max(1, Math.floor(capacity));
}

/**
 * A bounded map that evicts the least-recently-used entry on overflow.
 *
 * Mutable by design: `get`/`set` update recency in place. Prefer the
 * {@link createLru} factory so the capacity is normalized for you.
 */
export class LruCache<K, V> {
  /** Normalized capacity (a finite integer ≥ 1). */
  readonly capacity: number;

  /** Entries oldest → newest; `Map` iteration order encodes recency. */
  private readonly entries = new Map<K, V>();

  constructor({ capacity }: LruCacheOptions) {
    this.capacity = normalizeCapacity(capacity);
  }

  /**
   * Read `key` and mark it most-recently-used. Returns `undefined` for a miss
   * (a miss does not touch recency).
   */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * Insert or update `key` and mark it most-recently-used. When the cache is at
   * capacity and `key` is new, the least-recently-used entry is evicted first.
   * Returns the cache to allow chaining.
   */
  set(key: K, value: V): this {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return this;
  }

  /** Whether `key` is present. A plain read: it does not promote the entry. */
  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Remove `key`; returns `true` when an entry was removed. */
  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.clear();
  }

  /** Live keys, most-recently-used first. A fresh array, safe to mutate. */
  keys(): K[] {
    return [...this.entries.keys()].reverse();
  }

  /** Number of live entries (never above `capacity`). */
  size(): number {
    return this.entries.size;
  }
}

/** Create an empty {@link LruCache} with a normalized `capacity`. */
export function createLru<K, V>(options: LruCacheOptions): LruCache<K, V> {
  return new LruCache<K, V>(options);
}

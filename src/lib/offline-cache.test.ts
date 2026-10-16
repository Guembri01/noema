import { describe, expect, it } from "vitest";
import {
  OfflineCache,
  createMemoryBackend,
  createOfflineCache,
  type CacheBackend,
  type CacheRecord,
} from "@/lib/offline-cache";

/**
 * Offline document cache — the pure, in-memory TTL+LRU cache layered over an
 * injected storage backend.
 *
 * Red-first: this file was written BEFORE `src/lib/offline-cache.ts` existed, so
 * every import resolved to module-not-found and the suite failed to collect. It
 * pins the model the offline read path leans on:
 *
 *  - `createOfflineCache({ capacity, backend? })` — a bounded cache with a
 *    normalized capacity and a memory backend by default;
 *  - `put(key, value, { ttlMs, now })` — write-through, expiry computed from the
 *    injected `now` (never a clock read);
 *  - `get(key, now)` — promotes on a hit, drops and reports `undefined` for an
 *    entry at or past its expiry, and hydrates a cold key from the backend;
 *  - `evictExpired(now)` — prunes every stale entry, returning their keys;
 *  - `snapshot()` — a plain, non-mutating view of the live entries.
 */

/** A backend that records every operation while wrapping a real memory store. */
function createSpyBackend<V>() {
  const store = createMemoryBackend<V>();
  const reads: string[] = [];
  const writes: string[] = [];
  const removes: string[] = [];
  const backend: CacheBackend<V> = {
    read(key) {
      reads.push(key);
      return store.read(key);
    },
    write(key, record) {
      writes.push(key);
      store.write(key, record);
    },
    remove(key) {
      removes.push(key);
      store.remove(key);
    },
  };
  return { backend, store, reads, writes, removes };
}

describe("createOfflineCache", () => {
  it("starts empty with the requested capacity", () => {
    const cache = createOfflineCache<string>({ capacity: 4 });

    expect(cache.capacity).toBe(4);
    expect(cache.size()).toBe(0);
    expect(cache.keys()).toEqual([]);
    expect(cache.snapshot()).toEqual({ capacity: 4, size: 0, entries: [] });
  });

  it("normalizes capacity to a finite integer ≥ 1", () => {
    expect(createOfflineCache({ capacity: 2.9 }).capacity).toBe(2);
    expect(createOfflineCache({ capacity: -5 }).capacity).toBe(1);
    expect(createOfflineCache({ capacity: Number.NaN }).capacity).toBe(1);
  });

  it("is an OfflineCache instance", () => {
    expect(createOfflineCache({ capacity: 2 })).toBeInstanceOf(OfflineCache);
  });

  it("defaults to a private memory backend (no cross-instance sharing)", () => {
    const first = createOfflineCache<string>({ capacity: 2 });
    first.put("a", "one", { ttlMs: 100, now: 0 });

    const second = createOfflineCache<string>({ capacity: 2 });

    expect(second.get("a", 0)).toBeUndefined();
  });
});

describe("createMemoryBackend", () => {
  it("round-trips records and reports a miss as undefined", () => {
    const backend = createMemoryBackend<number>();
    const record: CacheRecord<number> = { value: 7, storedAt: 10, expiresAt: 20 };

    backend.write("k", record);

    expect(backend.read("k")).toEqual(record);
    expect(backend.read("missing")).toBeUndefined();
  });

  it("removes records and keeps instances independent", () => {
    const a = createMemoryBackend<string>();
    const b = createMemoryBackend<string>();
    a.write("k", { value: "x", storedAt: 0, expiresAt: 1 });

    expect(b.read("k")).toBeUndefined();
    a.remove("k");
    expect(a.read("k")).toBeUndefined();
  });
});

describe("put + get", () => {
  it("stores and reads a document", () => {
    const cache = createOfflineCache<string>({ capacity: 3 });

    cache.put("page:1", "hello", { ttlMs: 1_000, now: 100 });

    expect(cache.get("page:1", 100)).toBe("hello");
    expect(cache.get("page:1", 1_099)).toBe("hello");
    expect(cache.size()).toBe(1);
  });

  it("misses an unknown key without side effects", () => {
    const cache = createOfflineCache<string>({ capacity: 3 });

    expect(cache.get("nope", 0)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("overwrites an existing key with the latest value", () => {
    const cache = createOfflineCache<number>({ capacity: 3 });
    cache.put("k", 1, { ttlMs: 1_000, now: 0 });

    cache.put("k", 2, { ttlMs: 1_000, now: 0 });

    expect(cache.get("k", 0)).toBe(2);
    expect(cache.size()).toBe(1);
  });

  it("returns the cache for chaining", () => {
    const cache = createOfflineCache<number>({ capacity: 3 });

    const returned = cache.put("a", 1, { ttlMs: 100, now: 0 });

    expect(returned).toBe(cache);
  });

  it("holds structured documents", () => {
    type Doc = { title: string; blocks: number[] };
    const cache = createOfflineCache<Doc>({ capacity: 3 });
    const doc: Doc = { title: "Notes", blocks: [1, 2, 3] };

    cache.put("doc", doc, { ttlMs: 100, now: 0 });

    expect(cache.get("doc", 0)).toEqual(doc);
  });
});

describe("TTL", () => {
  it("is live until the ttl elapses and expires exactly at storedAt + ttl", () => {
    const cache = createOfflineCache<string>({ capacity: 2 });
    cache.put("k", "v", { ttlMs: 500, now: 1_000 });

    expect(cache.get("k", 1_499)).toBe("v");
    expect(cache.get("k", 1_500)).toBeUndefined();
  });

  it("treats a negative or NaN ttl as immediately expired", () => {
    const cache = createOfflineCache<string>({ capacity: 2 });
    cache.put("neg", "v", { ttlMs: -50, now: 10 });
    cache.put("nan", "v", { ttlMs: Number.NaN, now: 10 });

    expect(cache.get("neg", 10)).toBeUndefined();
    expect(cache.get("nan", 10)).toBeUndefined();
  });

  it("never expires an Infinity ttl", () => {
    const cache = createOfflineCache<string>({ capacity: 2 });
    cache.put("k", "v", { ttlMs: Infinity, now: 0 });

    expect(cache.get("k", Number.MAX_SAFE_INTEGER)).toBe("v");
  });

  it("applies each entry's own ttl independently", () => {
    const cache = createOfflineCache<string>({ capacity: 3 });
    cache.put("short", "s", { ttlMs: 10, now: 0 });
    cache.put("long", "l", { ttlMs: 1_000, now: 0 });

    expect(cache.get("short", 20)).toBeUndefined();
    expect(cache.get("long", 20)).toBe("l");
  });

  it("refreshes expiry when a key is re-put", () => {
    const cache = createOfflineCache<string>({ capacity: 2 });
    cache.put("k", "v", { ttlMs: 100, now: 0 });

    cache.put("k", "v2", { ttlMs: 1_000, now: 500 });

    expect(cache.get("k", 1_400)).toBe("v2");
  });

  it("drops an expired entry on read so it stops counting toward size", () => {
    const cache = createOfflineCache<string>({ capacity: 2 });
    cache.put("k", "v", { ttlMs: 10, now: 0 });

    expect(cache.get("k", 20)).toBeUndefined();
    expect(cache.size()).toBe(0);
    expect(cache.keys()).toEqual([]);
  });

  it("treats a non-finite now as 0", () => {
    const cache = createOfflineCache<string>({ capacity: 2 });
    cache.put("k", "v", { ttlMs: 100, now: Number.NaN });

    expect(cache.get("k", 50)).toBe("v");
    expect(cache.get("k", 100)).toBeUndefined();
  });
});

describe("LRU eviction", () => {
  it("evicts the least-recently-used entry on overflow", () => {
    const cache = createOfflineCache<number>({ capacity: 2 });
    cache.put("a", 1, { ttlMs: 1_000, now: 0 });
    cache.put("b", 2, { ttlMs: 1_000, now: 0 });

    cache.put("c", 3, { ttlMs: 1_000, now: 0 });

    expect(cache.size()).toBe(2);
    expect(cache.keys()).toEqual(["c", "b"]);
    expect(cache.get("a", 0)).toBeUndefined();
  });

  it("evicts by recency, not insertion order", () => {
    const cache = createOfflineCache<number>({ capacity: 2 });
    cache.put("a", 1, { ttlMs: 1_000, now: 0 });
    cache.put("b", 2, { ttlMs: 1_000, now: 0 });
    cache.get("a", 0); // `a` is now the most recent, so `b` is the victim

    cache.put("c", 3, { ttlMs: 1_000, now: 0 });

    expect(cache.get("b", 0)).toBeUndefined();
    expect(cache.keys()).toEqual(["c", "a"]);
  });

  it("promotes on set without evicting an existing sibling", () => {
    const cache = createOfflineCache<number>({ capacity: 2 });
    cache.put("a", 1, { ttlMs: 1_000, now: 0 });
    cache.put("b", 2, { ttlMs: 1_000, now: 0 });

    cache.put("a", 10, { ttlMs: 1_000, now: 0 });

    expect(cache.size()).toBe(2);
    expect(cache.get("b", 0)).toBe(2);
    expect(cache.get("a", 0)).toBe(10);
  });

  it("honours a capacity of 1", () => {
    const cache = createOfflineCache<number>({ capacity: 1 });
    cache.put("a", 1, { ttlMs: 1_000, now: 0 });

    cache.put("b", 2, { ttlMs: 1_000, now: 0 });

    expect(cache.get("a", 0)).toBeUndefined();
    expect(cache.keys()).toEqual(["b"]);
  });
});

describe("keys", () => {
  it("lists keys most-recently-used first", () => {
    const cache = createOfflineCache<number>({ capacity: 5 });
    cache.put("a", 1, { ttlMs: 100, now: 0 });
    cache.put("b", 2, { ttlMs: 100, now: 0 });
    cache.put("c", 3, { ttlMs: 100, now: 0 });
    expect(cache.keys()).toEqual(["c", "b", "a"]);

    cache.get("a", 0);

    expect(cache.keys()).toEqual(["a", "c", "b"]);
  });

  it("returns a fresh array that does not alias the cache", () => {
    const cache = createOfflineCache<number>({ capacity: 3 });
    cache.put("a", 1, { ttlMs: 100, now: 0 });
    cache.put("b", 2, { ttlMs: 100, now: 0 });

    const keys = cache.keys();
    keys.pop();

    expect(cache.keys()).toEqual(["b", "a"]);
  });
});

describe("evictExpired", () => {
  it("removes only stale entries and returns their keys, most-recent first", () => {
    const cache = createOfflineCache<string>({ capacity: 5 });
    cache.put("a", "v", { ttlMs: 10, now: 0 });
    cache.put("b", "v", { ttlMs: 1_000, now: 0 });
    cache.put("c", "v", { ttlMs: 10, now: 0 });

    const removed = cache.evictExpired(20);

    expect(removed).toEqual(["c", "a"]);
    expect(cache.keys()).toEqual(["b"]);
  });

  it("is a no-op that returns an empty array when nothing is stale", () => {
    const cache = createOfflineCache<string>({ capacity: 3 });
    cache.put("a", "v", { ttlMs: 1_000, now: 0 });

    expect(cache.evictExpired(100)).toEqual([]);
    expect(cache.size()).toBe(1);
  });

  it("removes stale entries from the backend too", () => {
    const { backend, store } = createSpyBackend<string>();
    const cache = createOfflineCache<string>({ capacity: 3, backend });
    cache.put("a", "v", { ttlMs: 10, now: 0 });

    cache.evictExpired(20);

    expect(store.read("a")).toBeUndefined();
  });
});

describe("delete + clear", () => {
  it("deletes by key from memory and backend, reporting whether anything went", () => {
    const { backend, store } = createSpyBackend<string>();
    const cache = createOfflineCache<string>({ capacity: 3, backend });
    cache.put("a", "v", { ttlMs: 100, now: 0 });

    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.size()).toBe(0);
    expect(store.read("a")).toBeUndefined();
  });

  it("clears every entry from memory and backend", () => {
    const { backend, store } = createSpyBackend<string>();
    const cache = createOfflineCache<string>({ capacity: 3, backend });
    cache.put("a", "v", { ttlMs: 100, now: 0 });
    cache.put("b", "v", { ttlMs: 100, now: 0 });

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.keys()).toEqual([]);
    expect(store.read("a")).toBeUndefined();
    expect(store.read("b")).toBeUndefined();
  });
});

describe("snapshot", () => {
  it("reports capacity, size and live entries most-recently-used first", () => {
    const cache = createOfflineCache<string>({ capacity: 4 });
    cache.put("a", "one", { ttlMs: 100, now: 5 });
    cache.put("b", "two", { ttlMs: 200, now: 5 });

    expect(cache.snapshot()).toEqual({
      capacity: 4,
      size: 2,
      entries: [
        { key: "b", value: "two", storedAt: 5, expiresAt: 205 },
        { key: "a", value: "one", storedAt: 5, expiresAt: 105 },
      ],
    });
  });

  it("is a non-mutating read (repeat calls do not change recency)", () => {
    const cache = createOfflineCache<string>({ capacity: 3 });
    cache.put("a", "one", { ttlMs: 100, now: 0 });
    cache.put("b", "two", { ttlMs: 100, now: 0 });

    const first = cache.snapshot();
    const second = cache.snapshot();

    expect(second).toEqual(first);
    expect(cache.keys()).toEqual(["b", "a"]);
  });
});

describe("storage backend", () => {
  it("writes through on put", () => {
    const { backend, store } = createSpyBackend<string>();
    const cache = createOfflineCache<string>({ capacity: 3, backend });

    cache.put("a", "v", { ttlMs: 100, now: 7 });

    expect(store.read("a")).toEqual({ value: "v", storedAt: 7, expiresAt: 107 });
  });

  it("hydrates a cold key from a shared backend", () => {
    const backend = createMemoryBackend<string>();
    const first = createOfflineCache<string>({ capacity: 3, backend });
    first.put("a", "persisted", { ttlMs: 1_000, now: 0 });

    const second = createOfflineCache<string>({ capacity: 3, backend });

    expect(second.get("a", 5)).toBe("persisted");
    expect(second.size()).toBe(1);
  });

  it("does not serve or keep an expired backend entry", () => {
    const { backend, store } = createSpyBackend<string>();
    const cache = createOfflineCache<string>({ capacity: 3, backend });
    cache.put("a", "v", { ttlMs: 10, now: 0 });
    // Drop it from the hot tier only; the backend still holds the (now stale) record.
    cache.delete("a");
    store.write("a", { value: "v", storedAt: 0, expiresAt: 10 });

    expect(cache.get("a", 20)).toBeUndefined();
    expect(store.read("a")).toBeUndefined();
  });

  it("drops an evicted victim from the backend", () => {
    const { backend, store } = createSpyBackend<string>();
    const cache = createOfflineCache<string>({ capacity: 2, backend });
    cache.put("a", "1", { ttlMs: 100, now: 0 });
    cache.put("b", "2", { ttlMs: 100, now: 0 });

    cache.put("c", "3", { ttlMs: 100, now: 0 });

    expect(store.read("a")).toBeUndefined();
    expect(store.read("b")).not.toBeUndefined();
    expect(store.read("c")).not.toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  OFFLINE_CACHE_SCHEMA_VERSION,
  OfflineCache,
  createMemoryStorage,
  createOfflineCache,
  entryStorageKey,
  type OfflineStorage,
} from "@/lib/offline-cache";

/**
 * Offline cache engine (§17) — the async, storage-backed TTL+LRU cache plus the
 * pending-mutation replay queue the offline read/write path leans on.
 *
 * Red-first: this file was written BEFORE the engine existed, so every import
 * resolved to module-not-found (or the stale, incompatible surface) and the
 * suite failed to collect. It pins the model:
 *
 *  - `createMemoryStorage()` — a deterministic `OfflineStorage` double;
 *  - `createOfflineCache(storage, { now, maxBytes?, ttlMs? })` — a cache over an
 *    injected async storage seam, reading the injected `now()` clock only;
 *  - `put` / `get` (TTL + `stale` flag), `putMany` / `getMany`;
 *  - `invalidate(prefix)` and `evictLRU()` (size-bounded, least-recently-used by
 *    `lastAccess`);
 *  - `queueMutation` / `pendingMutations` / `markMutationSynced` replay queue;
 *  - `stats()` — a deterministic summary;
 *  - entries carry a `schemaVersion`; a mismatched version is a miss.
 */

/** A clock we can move by hand so every read is reproducible. */
function makeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    set(value: number) {
      current = value;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

/** A storage that records every call while wrapping a real memory store. */
function createSpyStorage(seed: Record<string, string> = {}) {
  const store = createMemoryStorage(seed);
  const gets: string[] = [];
  const sets: [string, string][] = [];
  const removes: string[] = [];
  const storage: OfflineStorage = {
    async getItem(key) {
      gets.push(key);
      return store.getItem(key);
    },
    async setItem(key, value) {
      sets.push([key, value]);
      await store.setItem(key, value);
    },
    async removeItem(key) {
      removes.push(key);
      await store.removeItem(key);
    },
    keys() {
      return store.keys();
    },
  };
  return { storage, store, gets, sets, removes };
}

/** A raw, on-disk entry envelope for hand-rolled fixtures (e.g. version bumps). */
function rawEnvelope<V>(key: string, value: V, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
    key,
    value,
    storedAt: 0,
    lastAccess: 0,
    expiresAt: null,
    bytes: 1,
    meta: {},
    ...over,
  });
}

describe("createMemoryStorage", () => {
  it("reads null before anything is written", async () => {
    await expect(createMemoryStorage().getItem("missing")).resolves.toBeNull();
  });

  it("round-trips values and removes them", async () => {
    const storage = createMemoryStorage();
    await storage.setItem("a", "1");
    await expect(storage.getItem("a")).resolves.toBe("1");
    await storage.removeItem("a");
    await expect(storage.getItem("a")).resolves.toBeNull();
  });

  it("lists keys deterministically and keeps instances independent", async () => {
    const first = createMemoryStorage();
    const second = createMemoryStorage();
    await first.setItem("b", "2");
    await first.setItem("a", "1");

    await expect(first.keys()).resolves.toEqual(["a", "b"]);
    await expect(second.keys()).resolves.toEqual([]);
  });

  it("seeds from an initial record without aliasing it", async () => {
    const seed: Record<string, string> = { k: "v" };
    const storage = createMemoryStorage(seed);
    seed.k2 = "v2";
    await expect(storage.keys()).resolves.toEqual(["k"]);
  });
});

describe("createOfflineCache — put + get", () => {
  it("returns an OfflineCache instance", () => {
    const clock = makeClock();
    const cache = createOfflineCache(createMemoryStorage(), { now: clock.now });
    expect(cache).toBeInstanceOf(OfflineCache);
  });

  it("stores a value and reads it back with metadata", async () => {
    const clock = makeClock(1_000);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });

    await cache.put("page:1", "hello");
    const entry = await cache.get("page:1");

    expect(entry).not.toBeNull();
    expect(entry?.value).toBe("hello");
    expect(entry?.key).toBe("page:1");
    expect(entry?.storedAt).toBe(1_000);
    expect(entry?.lastAccess).toBe(1_000);
    expect(entry?.stale).toBe(false);
    expect(entry?.ageMs).toBe(0);
  });

  it("reports whether a put replaced an existing entry", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<number>(createMemoryStorage(), { now: clock.now });

    const first = await cache.put("k", 1);
    const second = await cache.put("k", 2);

    expect(first.replaced).toBe(false);
    expect(second.replaced).toBe(true);
    expect((await cache.get("k"))?.value).toBe(2);
  });

  it("misses an unknown key with a null", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await expect(cache.get("nope")).resolves.toBeNull();
  });

  it("persists entries under a namespaced storage key", async () => {
    const { storage, store } = createSpyStorage();
    const clock = makeClock();
    const cache = createOfflineCache<string>(storage, { now: clock.now });

    await cache.put("page:1", "hello");

    expect(entryStorageKey("page:1")).toBe("@offline-cache/entry/page:1");
    await expect(store.getItem(entryStorageKey("page:1"))).resolves.not.toBeNull();
  });

  it("round-trips structured values", async () => {
    type Doc = { title: string; blocks: number[] };
    const clock = makeClock();
    const cache = createOfflineCache<Doc>(createMemoryStorage(), { now: clock.now });
    const doc: Doc = { title: "Notes", blocks: [1, 2, 3] };

    await cache.put("doc", doc);

    await expect(cache.get("doc")).resolves.toMatchObject({ value: doc });
  });

  it("preserves put meta (tags and explicit size)", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });

    await cache.put("k", "v", { tags: ["page", "pinned"], sizeBytes: 42 });
    const entry = await cache.get("k");

    expect(entry?.meta).toEqual({ tags: ["page", "pinned"], sizeBytes: 42 });
    expect(entry?.bytes).toBe(42);
  });
});

describe("TTL", () => {
  it("serves a fresh entry before its expiry", async () => {
    const clock = makeClock(1_000);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("k", "v", { ttlMs: 500 });

    clock.advance(499);

    expect((await cache.get("k"))?.stale).toBe(false);
  });

  it("flags an entry stale exactly at storedAt + ttl", async () => {
    const clock = makeClock(1_000);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("k", "v", { ttlMs: 500 });

    clock.advance(500);

    expect((await cache.get("k"))?.stale).toBe(true);
  });

  it("keeps serving a stale value (stale-while-revalidate)", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("k", "v", { ttlMs: 10 });

    clock.advance(1_000);

    const entry = await cache.get("k");
    expect(entry?.stale).toBe(true);
    expect(entry?.value).toBe("v");
    expect(entry?.ageMs).toBe(1_000);
  });

  it("applies the options-level default ttl", async () => {
    const clock = makeClock(100);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now, ttlMs: 200 });
    await cache.put("k", "v");

    clock.advance(199);
    expect((await cache.get("k"))?.stale).toBe(false);
    clock.advance(1);
    expect((await cache.get("k"))?.stale).toBe(true);
  });

  it("lets a per-entry ttl override the default", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now, ttlMs: 10 });
    await cache.put("k", "v", { ttlMs: 1_000 });

    clock.advance(500);

    expect((await cache.get("k"))?.stale).toBe(false);
    expect((await cache.get("k"))?.expiresAt).toBe(1_000);
  });

  it("never expires when no ttl is configured", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("k", "v");

    clock.set(Number.MAX_SAFE_INTEGER);

    const entry = await cache.get("k");
    expect(entry?.expiresAt).toBeNull();
    expect(entry?.stale).toBe(false);
  });

  it("treats a zero ttl as immediately stale", async () => {
    const clock = makeClock(50);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("k", "v", { ttlMs: 0 });

    expect((await cache.get("k"))?.stale).toBe(true);
  });

  it("refreshes the expiry when a key is re-put", async () => {
    const clock = makeClock(1_000);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("k", "v", { ttlMs: 100 });

    clock.advance(90);
    await cache.put("k", "v2", { ttlMs: 100 });
    clock.advance(90);

    const entry = await cache.get("k");
    expect(entry?.value).toBe("v2");
    expect(entry?.stale).toBe(false);
    expect(entry?.expiresAt).toBe(1_190);
  });
});

describe("schema version", () => {
  it("exposes a numeric schema version", () => {
    expect(typeof OFFLINE_CACHE_SCHEMA_VERSION).toBe("number");
    expect(OFFLINE_CACHE_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("treats a mismatched version as a miss", async () => {
    const clock = makeClock(0);
    const storage = createMemoryStorage({
      [entryStorageKey("page:1")]: rawEnvelope("page:1", "old", { schemaVersion: 0 }),
    });
    const cache = createOfflineCache<string>(storage, { now: clock.now });

    await expect(cache.get("page:1")).resolves.toBeNull();
  });

  it("removes a mismatched-version entry from storage", async () => {
    const clock = makeClock(0);
    const storage = createMemoryStorage({
      [entryStorageKey("page:1")]: rawEnvelope("page:1", "old", { schemaVersion: 999 }),
    });
    const cache = createOfflineCache<string>(storage, { now: clock.now });

    await cache.get("page:1");

    await expect(storage.getItem(entryStorageKey("page:1"))).resolves.toBeNull();
    expect((await cache.stats()).entries).toBe(0);
  });

  it("skips a mismatched-version entry inside getMany", async () => {
    const clock = makeClock(0);
    const storage = createMemoryStorage({
      [entryStorageKey("a")]: rawEnvelope("a", "ok"),
      [entryStorageKey("b")]: rawEnvelope("b", "old", { schemaVersion: 0 }),
    });
    const cache = createOfflineCache<string>(storage, { now: clock.now });

    const entries = await cache.getMany(["a", "b"]);

    expect(entries[0]?.value).toBe("ok");
    expect(entries[1]).toBeNull();
  });
});

describe("putMany + getMany", () => {
  it("stores a batch and returns results in order", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });

    const results = await cache.putMany([
      { key: "a", value: "one" },
      { key: "b", value: "two" },
    ]);

    expect(results.map((r) => r.key)).toEqual(["a", "b"]);
    await expect(cache.get("a")).resolves.toMatchObject({ value: "one" });
    await expect(cache.get("b")).resolves.toMatchObject({ value: "two" });
  });

  it("reads a batch in request order, with nulls for misses", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("a", "one");

    const entries = await cache.getMany(["missing", "a", "also-missing"]);

    expect(entries[0]).toBeNull();
    expect(entries[1]?.value).toBe("one");
    expect(entries[2]).toBeNull();
  });

  it("promotes recency for entries read in a batch", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<string>(createMemoryStorage(), {
      now: clock.now,
      maxBytes: 20,
    });
    await cache.put("a", "1", { sizeBytes: 10 });
    clock.advance(1);
    await cache.put("b", "2", { sizeBytes: 10 });
    clock.advance(1);
    await cache.put("c", "3", { sizeBytes: 10 });

    clock.advance(10);
    await cache.getMany(["a"]); // `a` becomes most-recent; `b` is now the victim

    await expect(cache.evictLRU()).resolves.toEqual(["b"]);
  });
});

describe("invalidate", () => {
  it("removes only entries matching the prefix and returns them", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("page:1", "a");
    await cache.put("page:2", "b");
    await cache.put("doc:1", "c");

    const removed = await cache.invalidate("page:");

    expect(removed.sort()).toEqual(["page:1", "page:2"]);
    expect((await cache.get("page:1"))?.value).toBeUndefined();
    expect((await cache.get("doc:1"))?.value).toBe("c");
  });

  it("clears every entry for an empty prefix", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("a", "1");
    await cache.put("b", "2");

    await cache.invalidate("");

    expect((await cache.stats()).entries).toBe(0);
  });

  it("leaves the mutation queue untouched", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("page:1", "a");
    await cache.queueMutation({ id: "m1", kind: "update" });

    await cache.invalidate("");

    await expect(cache.pendingMutations()).resolves.toMatchObject([{ id: "m1" }]);
  });

  it("returns an empty array when nothing matches", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("a", "1");

    await expect(cache.invalidate("zzz")).resolves.toEqual([]);
  });
});

describe("evictLRU", () => {
  const seed = async (cache: OfflineCache<number>, clock: ReturnType<typeof makeClock>) => {
    await cache.put("a", 1, { sizeBytes: 10 });
    clock.advance(1);
    await cache.put("b", 2, { sizeBytes: 10 });
    clock.advance(1);
    await cache.put("c", 3, { sizeBytes: 10 });
  };

  it("evicts least-recently-used entries until within maxBytes", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<number>(createMemoryStorage(), {
      now: clock.now,
      maxBytes: 20,
    });
    await seed(cache, clock);

    const evicted = await cache.evictLRU();

    expect(evicted).toEqual(["a"]);
    expect((await cache.stats()).bytes).toBe(20);
  });

  it("uses lastAccess so a promoted entry survives", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<number>(createMemoryStorage(), {
      now: clock.now,
      maxBytes: 20,
    });
    await seed(cache, clock);

    clock.advance(10);
    await cache.get("a"); // `a` becomes most-recent; `b` is now the victim
    const evicted = await cache.evictLRU();

    expect(evicted).toEqual(["b"]);
    expect((await cache.get("a"))?.value).toBe(1);
  });

  it("is a no-op for an unbounded cache", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<number>(createMemoryStorage(), { now: clock.now });
    await cache.put("a", 1, { sizeBytes: 10 });

    await expect(cache.evictLRU()).resolves.toEqual([]);
    expect((await cache.stats()).entries).toBe(1);
  });

  it("evicts everything when maxBytes is zero", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<number>(createMemoryStorage(), {
      now: clock.now,
      maxBytes: 0,
    });
    await seed(cache, clock);

    const evicted = await cache.evictLRU();

    expect(evicted).toEqual(["a", "b", "c"]);
    expect((await cache.stats()).entries).toBe(0);
  });
});

describe("replay queue", () => {
  it("assigns a monotonic seq and sane defaults", async () => {
    const clock = makeClock(500);
    const cache = createOfflineCache<unknown>(createMemoryStorage(), { now: clock.now });

    const first = await cache.queueMutation({ id: "m1", kind: "update" });
    const second = await cache.queueMutation({ id: "m2", kind: "create", targetId: "row:9" });

    expect(first).toMatchObject({ id: "m1", seq: 1, attempts: 0, createdAt: 500, targetId: null });
    expect(second).toMatchObject({ id: "m2", seq: 2, targetId: "row:9" });
  });

  it("returns pending mutations in replay order", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<unknown>(createMemoryStorage(), { now: clock.now });
    await cache.queueMutation({ id: "m1", kind: "update" });
    await cache.queueMutation({ id: "m2", kind: "update" });
    await cache.queueMutation({ id: "m3", kind: "update" });

    const pending = await cache.pendingMutations();

    expect(pending.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(pending.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("respects a caller-supplied createdAt", async () => {
    const clock = makeClock(999);
    const cache = createOfflineCache<unknown>(createMemoryStorage(), { now: clock.now });

    const queued = await cache.queueMutation({ id: "m1", kind: "update", createdAt: 42 });

    expect(queued.createdAt).toBe(42);
  });

  it("persists the queue across instances sharing storage", async () => {
    const clock = makeClock();
    const storage = createMemoryStorage();
    const first = createOfflineCache<unknown>(storage, { now: clock.now });
    await first.queueMutation({ id: "m1", kind: "update" });

    const second = createOfflineCache<unknown>(storage, { now: clock.now });

    await expect(second.pendingMutations()).resolves.toMatchObject([{ id: "m1" }]);
  });

  it("drops a synced mutation and reports whether it existed", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<unknown>(createMemoryStorage(), { now: clock.now });
    await cache.queueMutation({ id: "m1", kind: "update" });
    await cache.queueMutation({ id: "m2", kind: "update" });

    await expect(cache.markMutationSynced("m1")).resolves.toBe(true);
    await expect(cache.markMutationSynced("m1")).resolves.toBe(false);
    await expect(cache.markMutationSynced("ghost")).resolves.toBe(false);
    expect((await cache.pendingMutations()).map((m) => m.id)).toEqual(["m2"]);
  });

  it("keeps replay order after a sync and a new enqueue", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<unknown>(createMemoryStorage(), { now: clock.now });
    await cache.queueMutation({ id: "a", kind: "update" });
    await cache.queueMutation({ id: "b", kind: "update" });
    await cache.markMutationSynced("a");

    await cache.queueMutation({ id: "c", kind: "update" });

    expect((await cache.pendingMutations()).map((m) => m.id)).toEqual(["b", "c"]);
    expect((await cache.pendingMutations()).map((m) => m.seq)).toEqual([2, 3]);
  });

  it("reads a wrong-version queue as empty", async () => {
    const clock = makeClock();
    const storage = createMemoryStorage({
      "@offline-cache/mutations": JSON.stringify({ schemaVersion: 0, mutations: [{ id: "x" }] }),
    });
    const cache = createOfflineCache<unknown>(storage, { now: clock.now });

    await expect(cache.pendingMutations()).resolves.toEqual([]);
  });
});

describe("stats", () => {
  it("reports entry count, bytes and the configured bounds", async () => {
    const clock = makeClock(0);
    const cache = createOfflineCache<string>(createMemoryStorage(), {
      now: clock.now,
      maxBytes: 100,
      ttlMs: 5_000,
    });
    await cache.put("a", "1", { sizeBytes: 30 });
    await cache.put("b", "2", { sizeBytes: 20 });

    const stats = await cache.stats();

    expect(stats).toMatchObject({
      schemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
      entries: 2,
      bytes: 50,
      maxBytes: 100,
      defaultTtlMs: 5_000,
    });
  });

  it("reports the lastAccess extremes", async () => {
    const clock = makeClock(100);
    const cache = createOfflineCache<string>(createMemoryStorage(), { now: clock.now });
    await cache.put("a", "1");
    clock.advance(50);
    await cache.put("b", "2");

    const stats = await cache.stats();

    expect(stats.oldestLastAccess).toBe(100);
    expect(stats.newestLastAccess).toBe(150);
  });

  it("counts pending mutations and reports null bounds when unset", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<unknown>(createMemoryStorage(), { now: clock.now });
    await cache.queueMutation({ id: "m1", kind: "update" });

    const stats = await cache.stats();

    expect(stats.pendingMutations).toBe(1);
    expect(stats.maxBytes).toBeNull();
    expect(stats.defaultTtlMs).toBeNull();
  });
});

describe("concurrency", () => {
  it("serializes concurrent puts without losing writes", async () => {
    const clock = makeClock();
    const cache = createOfflineCache<number>(createMemoryStorage(), { now: clock.now });

    await Promise.all([
      cache.put("a", 1),
      cache.put("b", 2),
      cache.put("c", 3),
    ]);

    expect((await cache.stats()).entries).toBe(3);
    await expect(cache.get("a")).resolves.toMatchObject({ value: 1 });
    await expect(cache.get("c")).resolves.toMatchObject({ value: 3 });
  });
});

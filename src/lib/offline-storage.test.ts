import { describe, expect, it } from "vitest";
import {
  OFFLINE_MUTATIONS_KEY,
  createBrowserStorage,
  createIndexedDbStorage,
  createOfflineBackend,
  createWebStorage,
  type WebStorageLike,
} from "@/lib/offline-storage";
import {
  OFFLINE_CACHE_PREFIX,
  createMemoryStorage,
  createOfflineCache,
} from "@/lib/offline-cache";
import { createOfflineStore } from "@/lib/offline-store";
import type { MutationDraft } from "@/lib/offline-queue";

/**
 * Wiring proof for `src/lib/offline-cache.ts` + `src/lib/offline-store.ts`.
 *
 * `createOfflineBackend` is the reconciliation seam: it must persist the
 * store's queue in the cache's canonical envelope (one key, one schema version)
 * so a mutation written by either engine is read by the other. The adapter tests
 * use an injected `WebStorageLike` (never the real `window.localStorage`), and
 * the fallbacks run in the Node environment where neither platform API exists.
 */

/** A Map-backed `localStorage` double that reports keys in sorted order. */
function fakeWebStorage(): WebStorageLike {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()].sort()[index] ?? null;
    },
    getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

const draft = (over: Partial<MutationDraft> & { id: string }): MutationDraft => ({
  kind: "update",
  targetId: "page:1",
  payload: { title: "draft" },
  createdAt: 1_000,
  ...over,
});

describe("createWebStorage", () => {
  it("implements the async seam over a synchronous store", async () => {
    const storage = createWebStorage(fakeWebStorage());
    expect(await storage.getItem("missing")).toBeNull();
    await storage.setItem("b", "2");
    await storage.setItem("a", "1");
    expect(await storage.getItem("a")).toBe("1");
    expect(await storage.keys()).toEqual(["a", "b"]);
    await storage.removeItem("a");
    expect(await storage.keys()).toEqual(["b"]);
  });

  it("survives a remove of an absent key", async () => {
    const storage = createWebStorage(fakeWebStorage());
    await expect(storage.removeItem("nope")).resolves.toBeUndefined();
    expect(await storage.keys()).toEqual([]);
  });
});

describe("platform fallbacks", () => {
  it("createBrowserStorage degrades to memory with no localStorage (Node)", async () => {
    const storage = createBrowserStorage();
    await storage.setItem("k", "v");
    expect(await storage.getItem("k")).toBe("v");
    expect(await storage.keys()).toEqual(["k"]);
  });

  it("createIndexedDbStorage degrades to memory with no factory", async () => {
    const storage = createIndexedDbStorage({ factory: undefined });
    await storage.setItem("k", "v");
    expect(await storage.getItem("k")).toBe("v");
  });
});

describe("the canonical mutations key", () => {
  it("is the cache's namespaced key, not a parallel one", () => {
    expect(OFFLINE_MUTATIONS_KEY).toBe(`${OFFLINE_CACHE_PREFIX}mutations`);
    expect(OFFLINE_MUTATIONS_KEY).toBe("@offline-cache/mutations");
  });

  it("writes the cache's schema envelope under that key", async () => {
    const storage = createMemoryStorage();
    const backend = createOfflineBackend(storage);
    await backend.write([]);
    const raw = await storage.getItem(OFFLINE_MUTATIONS_KEY);
    expect(raw).toContain('"schemaVersion":1');
    expect(raw).toContain('"mutations":[]');
  });

  it("reads null for a fresh install and for a malformed record", async () => {
    const missing = createOfflineBackend(createMemoryStorage());
    expect(await missing.read()).toBeNull();

    const corrupt = createMemoryStorage({ [OFFLINE_MUTATIONS_KEY]: "{not json" });
    expect(await createOfflineBackend(corrupt).read()).toBeNull();

    const wrongVersion = createMemoryStorage({
      [OFFLINE_MUTATIONS_KEY]: JSON.stringify({ schemaVersion: 99, mutations: [] }),
    });
    expect(await createOfflineBackend(wrongVersion).read()).toBeNull();
  });
});

describe("offline-store + offline-cache share one queue", () => {
  it("lets the cache read a queue enqueued through the store", async () => {
    const storage = createMemoryStorage();
    const cache = createOfflineCache(storage, { now: () => 1_000 });
    const store = createOfflineStore(createOfflineBackend(storage));

    const queued = await store.enqueue(draft({ id: "m1" }));
    expect(queued.seq).toBe(1);

    const seen = await cache.pendingMutations();
    expect(seen.map((mutation) => mutation.id)).toEqual(["m1"]);
    expect(seen[0].targetId).toBe("page:1");

    // Both engines agree on the same count.
    expect((await cache.stats()).pendingMutations).toBe(1);
    expect((await store.snapshot()).pending).toBe(1);
  });

  it("lets the store read a queue admitted through the cache", async () => {
    const storage = createMemoryStorage();
    const cache = createOfflineCache(storage, { now: () => 1_000 });
    const store = createOfflineStore(createOfflineBackend(storage));

    await cache.queueMutation({
      id: "c1",
      kind: "create",
      targetId: "page:2",
      payload: { title: "from cache" },
    });

    const pending = await store.pending();
    expect(pending.map((mutation) => mutation.id)).toEqual(["c1"]);
    expect(pending[0].payload).toEqual({ title: "from cache" });
  });

  it("drains a cache-admitted mutation through the store and back", async () => {
    const storage = createMemoryStorage();
    const cache = createOfflineCache(storage, { now: () => 1_000 });
    const store = createOfflineStore(createOfflineBackend(storage));

    await cache.queueMutation({ id: "c1", kind: "update", targetId: "page:2" });
    await store.drain(["c1"]);
    expect(await cache.pendingMutations()).toEqual([]);
    expect((await store.snapshot()).pending).toBe(0);
  });
});

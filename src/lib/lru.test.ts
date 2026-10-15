import { describe, expect, it } from "vitest";
import { createLru } from "./lru";

/**
 * LRU cache — the pure, in-memory least-recently-used map behind features that
 * want a bounded cache (mention search, link previews, the storage layer, …).
 *
 * Red-first: this file was written BEFORE `src/lib/lru.ts` existed, so every
 * import resolved to module-not-found and the suite failed to collect. It pins
 * the model callers lean on:
 *
 *  - `createLru({ capacity })` — an empty cache with a normalized capacity
 *    (a finite integer ≥ 1; anything else clamps to 1);
 *  - `get`/`set`/`has`/`delete`/`clear` — Map-shaped access where the most
 *    recently used entry is the last to be evicted;
 *  - `has` is a plain membership check and does NOT promote an entry;
 *  - `keys` lists entries most-recent → least-recent and is a fresh array;
 *  - `size` reports the number of held entries (never above capacity);
 *  - on overflow the least-recently-used entry is evicted.
 */
describe("createLru", () => {
  it("starts empty with the requested capacity", () => {
    const lru = createLru<string, number>({ capacity: 3 });

    expect(lru.capacity).toBe(3);
    expect(lru.size()).toBe(0);
    expect(lru.keys()).toEqual([]);
  });

  it("normalizes capacity to a finite integer ≥ 1", () => {
    expect(createLru({ capacity: 2.9 }).capacity).toBe(2);
    expect(createLru({ capacity: -5 }).capacity).toBe(1);
    expect(createLru({ capacity: Number.NaN }).capacity).toBe(1);
  });
});

describe("set + get", () => {
  it("stores, reads and overwrites values", () => {
    const lru = createLru<string, number>({ capacity: 4 });

    lru.set("a", 1);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("z")).toBeUndefined();

    lru.set("a", 10);

    expect(lru.get("a")).toBe(10);
    expect(lru.keys()).toEqual(["a"]);
  });

  it("supports non-string keys and object values", () => {
    const lru = createLru<number, { label: string }>({ capacity: 2 });
    lru.set(1, { label: "one" }).set(2, { label: "two" });

    expect(lru.get(1)).toEqual({ label: "one" });
    // `get(1)` promoted key 1, so it now leads the recency order.
    expect(lru.keys()).toEqual([1, 2]);
  });
});

describe("has / delete / clear", () => {
  it("gates membership without promoting", () => {
    const lru = createLru<string, number>({ capacity: 3 });
    lru.set("a", 1).set("b", 2).set("c", 3);

    expect(lru.has("a")).toBe(true);
    expect(lru.has("missing")).toBe(false);
    expect(lru.keys()).toEqual(["c", "b", "a"]);
  });

  it("deletes by key and reports whether anything was removed", () => {
    const lru = createLru<string, number>({ capacity: 3 });
    lru.set("a", 1).set("b", 2);

    expect(lru.delete("a")).toBe(true);
    expect(lru.delete("a")).toBe(false);
  });

  it("clears every entry", () => {
    const lru = createLru<string, number>({ capacity: 3 });
    lru.set("a", 1).set("b", 2);

    lru.clear();

    expect(lru.size()).toBe(0);
  });
});

describe("recency order", () => {
  it("lists keys most-recent first and promotes on get and set", () => {
    const lru = createLru<string, number>({ capacity: 5 });
    lru.set("a", 1).set("b", 2).set("c", 3);
    expect(lru.keys()).toEqual(["c", "b", "a"]);

    lru.get("a");
    expect(lru.keys()).toEqual(["a", "c", "b"]);

    lru.set("b", 2);
    expect(lru.keys()).toEqual(["b", "a", "c"]);
  });

  it("returns a fresh keys array that does not alias the cache", () => {
    const lru = createLru<string, number>({ capacity: 3 });
    lru.set("a", 1).set("b", 2);

    const keys = lru.keys();
    keys.pop();

    expect(lru.keys()).toEqual(["b", "a"]);
  });
});

describe("eviction", () => {
  it("evicts the least-recently-used entry on overflow", () => {
    const lru = createLru<string, number>({ capacity: 2 });
    lru.set("a", 1).set("b", 2);

    lru.set("c", 3);

    expect(lru.size()).toBe(2);
    expect(lru.has("a")).toBe(false);
    expect(lru.keys()).toEqual(["c", "b"]);
  });

  it("evicts by recency, not insertion order", () => {
    const lru = createLru<string, number>({ capacity: 2 });
    lru.set("a", 1).set("b", 2);
    lru.get("a"); // `a` is now the most recent, so `b` is the victim

    lru.set("c", 3);

    expect(lru.has("b")).toBe(false);
    expect(lru.keys()).toEqual(["c", "a"]);
  });

  it("honours a capacity of 1", () => {
    const lru = createLru<string, number>({ capacity: 1 });
    lru.set("a", 1);
    expect(lru.keys()).toEqual(["a"]);

    lru.set("b", 2);

    expect(lru.has("a")).toBe(false);
    expect(lru.keys()).toEqual(["b"]);
  });

  it("does not evict when overwriting an existing key at capacity", () => {
    const lru = createLru<string, number>({ capacity: 2 });
    lru.set("a", 1).set("b", 2);

    lru.set("b", 20);

    expect(lru.has("a")).toBe(true);
    expect(lru.get("b")).toBe(20);
  });
});

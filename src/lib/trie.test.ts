import { describe, expect, it } from "vitest";
import { buildTrie, complete, createTrie, has, insert, remove, startsWith } from "./trie";

/**
 * Prefix trie — pure, immutable autocomplete index.
 *
 * Red-first: this file was written BEFORE `src/lib/trie.ts` existed, so every
 * import resolved to module-not-found and the suite failed to collect. It pins
 * the model a mention/quick-find UI leans on:
 *
 *  - `createTrie` / `buildTrie` — an empty index, or one built from words;
 *  - `insert` / `remove` — add and delete a word, returning a fresh trie (the
 *    input is never mutated, and a no-op returns the same reference);
 *  - `has` — exact (whole-word) membership;
 *  - `startsWith` — whether any word has a prefix;
 *  - `complete` — the sorted completion list under a prefix, honouring a cap;
 *  - the `caseInsensitive` option — lookups fold case, but completions echo the
 *    casing a word was inserted with.
 */
describe("createTrie", () => {
  it("starts empty", () => {
    const trie = createTrie();

    expect(trie.size).toBe(0);
    expect(complete(trie, "")).toEqual([]);
  });
});

describe("insert + has", () => {
  it("adds words and tells a whole word from a prefix", () => {
    let trie = createTrie();
    trie = insert(trie, "cat");
    trie = insert(trie, "car");

    expect(has(trie, "cat")).toBe(true);
    expect(has(trie, "ca")).toBe(false);
  });

  it("is idempotent for a duplicate word and ignores the empty word", () => {
    const trie = insert(createTrie(), "cat");

    expect(insert(trie, "cat")).toBe(trie);
    expect(insert(trie, "").size).toBe(1);
  });

  it("does not mutate the input trie", () => {
    const base = buildTrie(["cat"]);
    const grown = insert(base, "car");

    expect(has(base, "car")).toBe(false);
    expect(has(grown, "car")).toBe(true);
  });
});

describe("startsWith", () => {
  it("detects prefixes, including a whole word", () => {
    const trie = buildTrie(["cat", "car", "cart"]);

    expect(startsWith(trie, "ca")).toBe(true);
    expect(startsWith(trie, "carts")).toBe(false);
  });

  it("treats the empty prefix as 'any word'", () => {
    expect(startsWith(createTrie(), "")).toBe(false);
    expect(startsWith(buildTrie(["a"]), "")).toBe(true);
  });
});

describe("complete", () => {
  it("returns sorted completions", () => {
    const trie = buildTrie(["cart", "car", "cat", "dog"]);

    expect(complete(trie, "ca")).toEqual(["car", "cart", "cat"]);
    expect(complete(trie, "")).toEqual(["car", "cart", "cat", "dog"]);
    expect(complete(trie, "z")).toEqual([]);
  });

  it("honours and normalizes the limit", () => {
    const trie = buildTrie(["a", "ab", "abc"]);

    expect(complete(trie, "a", { limit: 2 })).toEqual(["a", "ab"]);
    expect(complete(trie, "a", { limit: 0 })).toEqual([]);
    expect(complete(trie, "a", { limit: 2.9 })).toEqual(["a", "ab"]);
  });
});

describe("remove", () => {
  it("removes a word without disturbing shared branches", () => {
    const trie = remove(buildTrie(["car", "cart", "cat"]), "car");

    expect(has(trie, "car")).toBe(false);
    expect(has(trie, "cart")).toBe(true);
    expect(trie.size).toBe(2);
  });

  it("prunes branches that no longer hold words", () => {
    const trie = remove(buildTrie(["cat"]), "cat");

    expect(trie.size).toBe(0);
    expect(startsWith(trie, "cat")).toBe(false);
  });

  it("is a no-op for an absent word", () => {
    const trie = buildTrie(["cat"]);

    expect(remove(trie, "dog")).toBe(trie);
  });
});

describe("case-insensitive option", () => {
  it("folds case for lookup but echoes the inserted casing", () => {
    const trie = buildTrie(["Apple", "apricot"], { caseInsensitive: true });

    expect(has(trie, "APPLE")).toBe(true);
    expect(complete(trie, "ap")).toEqual(["Apple", "apricot"]);
    expect(complete(trie, "ap", { limit: 1 })).toEqual(["Apple"]);
  });

  it("dedupes words that differ only by case", () => {
    const trie = buildTrie(["Cat", "cat"], { caseInsensitive: true });

    expect(trie.size).toBe(1);
    expect(complete(trie, "cat")).toEqual(["Cat"]);
  });

  it("keeps case distinct when the option is off", () => {
    const trie = buildTrie(["Cat", "cat"]);

    expect(trie.size).toBe(2);
    expect(has(trie, "CAT")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  cacheSize,
  createFormulaCache,
  dependenciesOf,
  formulaCacheKey,
  getCached,
  hasCached,
  invalidateAll,
  invalidateByProperty,
  setCached,
} from "./formula-cache";

/**
 * O22.1 — formula result caching: a pure, dependency-aware value cache keyed by
 * `(expression, property values)`. `dependenciesOf` extracts the property
 * references a formula makes with a simple lexical scan; the cache uses that to
 * serve results and to drop exactly the entries a property change invalidates.
 * Spec: docs/specs/formula-engine.md (matrix `:328`, open question O22.1).
 */

describe("dependenciesOf (O22.1)", () => {
  it("reads no dependencies from a constant expression", () => {
    expect(dependenciesOf("")).toEqual([]);
    expect(dependenciesOf("1 + 2 * 3")).toEqual([]);
    expect(dependenciesOf('"hello"')).toEqual([]);
  });

  it("extracts prop() references", () => {
    expect(dependenciesOf('prop("Estimate")')).toEqual(["Estimate"]);
    expect(dependenciesOf('prop("Estimate") * 2')).toEqual(["Estimate"]);
  });

  it("extracts every distinct reference, sorted", () => {
    expect(dependenciesOf('prop("Status") + prop("Estimate")')).toEqual([
      "Estimate",
      "Status",
    ]);
    expect(dependenciesOf('prop("B") + prop("A")')).toEqual(["A", "B"]);
  });

  it("dedupes repeated references case-insensitively, keeping the first spelling", () => {
    expect(dependenciesOf('prop("Name") + prop("name")')).toEqual(["Name"]);
    expect(dependenciesOf('prop("Name") + Name')).toEqual(["Name"]);
  });

  it("treats bare identifiers as property references", () => {
    expect(dependenciesOf("Estimate * 2")).toEqual(["Estimate"]);
    expect(dependenciesOf("Due + Estimate")).toEqual(["Due", "Estimate"]);
  });

  it("does not confuse function names with property references", () => {
    expect(dependenciesOf('concat("x", "y")')).toEqual([]);
    expect(dependenciesOf("upper(Name)")).toEqual(["Name"]);
    expect(dependenciesOf('if(prop("Done"), "yes", "no")')).toEqual(["Done"]);
  });

  it("ignores identifiers that appear inside string literals", () => {
    expect(dependenciesOf('concat("Estimate and Status")')).toEqual([]);
    expect(dependenciesOf('"prop(\\"Ghost\\")"')).toEqual([]);
  });

  it("ignores reserved bare words (true/false/now/today)", () => {
    expect(dependenciesOf("true && now")).toEqual([]);
    expect(dependenciesOf("today")).toEqual([]);
    expect(dependenciesOf('if(prop("Done"), today, now)')).toEqual(["Done"]);
  });

  it("supports single-quoted prop names and embedded spaces", () => {
    expect(dependenciesOf("prop('Due Date')")).toEqual(["Due Date"]);
  });

  it("keeps escaped characters inside a prop name and skips empty names", () => {
    expect(dependenciesOf('prop("Say \\"Hi\\"")')).toEqual(['Say "Hi"']);
    expect(dependenciesOf('prop("")')).toEqual([]);
  });

  it("tolerates an unterminated string literal", () => {
    expect(dependenciesOf('concat("oops')).toEqual([]);
  });
});

describe("formulaCacheKey (O22.1)", () => {
  it("is stable for the same expression and dependency values", () => {
    expect(formulaCacheKey('prop("A")', { A: 1 })).toBe(formulaCacheKey('prop("A")', { A: 1 }));
  });

  it("changes when a referenced value changes", () => {
    expect(formulaCacheKey('prop("A")', { A: 1 })).not.toBe(formulaCacheKey('prop("A")', { A: 2 }));
  });

  it("ignores values the expression does not reference", () => {
    expect(formulaCacheKey('prop("A")', { A: 1, B: 2 })).toBe(
      formulaCacheKey('prop("A")', { A: 1, B: 99 }),
    );
    expect(formulaCacheKey("1 + 1", { A: 1 })).toBe(formulaCacheKey("1 + 1", { A: 2 }));
  });

  it("matches dependency value keys case-insensitively", () => {
    expect(formulaCacheKey('prop("Estimate")', { Estimate: 5 })).toBe(
      formulaCacheKey('prop("Estimate")', { estimate: 5 }),
    );
  });

  it("distinguishes a missing value from a present undefined", () => {
    expect(formulaCacheKey('prop("A")', {})).not.toBe(formulaCacheKey('prop("A")', { A: undefined }));
  });

  it("varies with the expression text", () => {
    expect(formulaCacheKey('prop("A") + 1', { A: 1 })).not.toBe(
      formulaCacheKey('prop("A") + 2', { A: 1 }),
    );
  });
});

describe("getCached / setCached / cacheSize (O22.1)", () => {
  it("misses before anything is stored", () => {
    const cache = createFormulaCache<number>();
    expect(getCached(cache, 'prop("A")', { A: 1 })).toBeUndefined();
    expect(hasCached(cache, 'prop("A")', { A: 1 })).toBe(false);
  });

  it("returns a stored value", () => {
    const cache = setCached(createFormulaCache<number>(), 'prop("A") * 2', { A: 3 }, 6);
    expect(getCached(cache, 'prop("A") * 2', { A: 3 })).toBe(6);
    expect(hasCached(cache, 'prop("A") * 2', { A: 3 })).toBe(true);
  });

  it("does not mutate the cache it was given", () => {
    const cache0 = createFormulaCache<number>();
    const cache = setCached(cache0, 'prop("A")', { A: 1 }, 1);
    expect(cacheSize(cache0)).toBe(0);
    expect(getCached(cache0, 'prop("A")', { A: 1 })).toBeUndefined();
    expect(cache).not.toBe(cache0);
    expect(cacheSize(cache)).toBe(1);
  });

  it("caches each set of dependency values independently", () => {
    let cache = createFormulaCache<number>();
    cache = setCached(cache, 'prop("A")', { A: 1 }, 10);
    cache = setCached(cache, 'prop("A")', { A: 2 }, 20);
    expect(getCached(cache, 'prop("A")', { A: 1 })).toBe(10);
    expect(getCached(cache, 'prop("A")', { A: 2 })).toBe(20);
    expect(cacheSize(cache)).toBe(2);
  });

  it("shares one entry across values the expression never reads", () => {
    const cache = setCached(createFormulaCache<number>(), "1 + 1", { Any: 1 }, 2);
    expect(getCached(cache, "1 + 1", { Any: 999 })).toBe(2);
    expect(cacheSize(cache)).toBe(1);
  });

  it("overwrites a key when the same expression and values are set again", () => {
    let cache = createFormulaCache<number>();
    cache = setCached(cache, 'prop("A")', { A: 1 }, 1);
    cache = setCached(cache, 'prop("A")', { A: 1 }, 2);
    expect(getCached(cache, 'prop("A")', { A: 1 })).toBe(2);
    expect(cacheSize(cache)).toBe(1);
  });

  it("distinguishes a cached undefined from a miss", () => {
    const cache = setCached(createFormulaCache<number | undefined>(), 'prop("A")', { A: 1 }, undefined);
    expect(hasCached(cache, 'prop("A")', { A: 1 })).toBe(true);
    expect(getCached(cache, 'prop("A")', { A: 1 })).toBeUndefined();
  });
});

describe("invalidateByProperty (O22.1)", () => {
  const seed = () => {
    let cache = createFormulaCache<number>();
    cache = setCached(cache, 'prop("A")', { A: 1 }, 1);
    cache = setCached(cache, 'prop("B")', { B: 1 }, 2);
    cache = setCached(cache, 'prop("A") + prop("B")', { A: 1, B: 1 }, 3);
    return cache;
  };

  it("drops every entry that depends on a property, keeping the rest", () => {
    const next = invalidateByProperty(seed(), "A");
    expect(getCached(next, 'prop("A")', { A: 1 })).toBeUndefined();
    expect(getCached(next, 'prop("A") + prop("B")', { A: 1, B: 1 })).toBeUndefined();
    expect(getCached(next, 'prop("B")', { B: 1 })).toBe(2);
    expect(cacheSize(next)).toBe(1);
  });

  it("matches the property name case-insensitively, ignoring surrounding whitespace", () => {
    const cache = setCached(createFormulaCache<number>(), 'prop("Estimate")', { Estimate: 1 }, 1);
    expect(cacheSize(invalidateByProperty(cache, "  estimate "))).toBe(0);
  });

  it("returns the same cache when no entry depends on the property", () => {
    const cache = setCached(createFormulaCache<number>(), 'prop("A")', { A: 1 }, 1);
    expect(invalidateByProperty(cache, "B")).toBe(cache);
  });

  it("invalidates bare-identifier dependencies too", () => {
    const cache = setCached(createFormulaCache<number>(), "Estimate * 2", { Estimate: 3 }, 6);
    expect(cacheSize(invalidateByProperty(cache, "estimate"))).toBe(0);
  });

  it("indexes an entry under each property it references", () => {
    const cache = setCached(
      createFormulaCache<number>(),
      'prop("A") + prop("B")',
      { A: 1, B: 1 },
      3,
    );
    const key = formulaCacheKey('prop("A") + prop("B")', { A: 1, B: 1 });
    expect(cache.dependents.get("a")?.has(key)).toBe(true);
    expect(cache.dependents.get("b")?.has(key)).toBe(true);
  });

  it("keeps the cache usable after invalidation and leaves no stale bookkeeping", () => {
    let cache = setCached(createFormulaCache<number>(), 'prop("A")', { A: 1 }, 1);
    cache = invalidateByProperty(cache, "A");
    expect(cache.dependents.size).toBe(0);
    cache = setCached(cache, 'prop("A")', { A: 1 }, 9);
    expect(getCached(cache, 'prop("A")', { A: 1 })).toBe(9);
  });
});

describe("invalidateAll (O22.1)", () => {
  it("empties every entry", () => {
    let cache = createFormulaCache<number>();
    cache = setCached(cache, 'prop("A")', { A: 1 }, 1);
    cache = setCached(cache, 'prop("B")', { B: 1 }, 2);
    const empty = invalidateAll(cache);
    expect(cacheSize(empty)).toBe(0);
    expect(getCached(empty, 'prop("A")', { A: 1 })).toBeUndefined();
  });

  it("leaves the original cache untouched", () => {
    const cache = setCached(createFormulaCache<number>(), 'prop("A")', { A: 1 }, 1);
    const empty = invalidateAll(cache);
    expect(empty).not.toBe(cache);
    expect(cacheSize(cache)).toBe(1);
  });
});

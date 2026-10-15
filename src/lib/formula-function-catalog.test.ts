import { describe, expect, it } from "vitest";

import {
  FORMULA_FUNCTIONS,
  FUNCTION_CATEGORIES,
  findFunction,
  searchFunctions,
  suggestFunctions,
  validateCall,
} from "./formula-function-catalog";

/**
 * F9 — the formula function catalog: a pure, side-effect-free description of
 * every function the formula language exposes (name, category, signature,
 * arity, description) plus lookup, search, completion and call validation.
 * The catalog is documentation metadata only; evaluation lives in
 * `./formula`, which this module never imports.
 */

const names = FORMULA_FUNCTIONS.map((entry) => entry.name);

describe("FORMULA_FUNCTIONS catalog (F9)", () => {
  it("exposes a non-trivial, uniquely-named catalog", () => {
    expect(FORMULA_FUNCTIONS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses only declared, non-duplicated categories", () => {
    const declared = new Set<string>(FUNCTION_CATEGORIES);
    expect(new Set(FUNCTION_CATEGORIES).size).toBe(FUNCTION_CATEGORIES.length);
    for (const entry of FORMULA_FUNCTIONS) {
      expect(declared.has(entry.category), entry.name).toBe(true);
    }
  });

  it("declares at least one function per category and every category is used", () => {
    for (const category of FUNCTION_CATEGORIES) {
      const count = FORMULA_FUNCTIONS.filter((entry) => entry.category === category).length;
      expect(count, category).toBeGreaterThan(0);
    }
  });

  it("gives every entry a signature that starts with its own name and a non-empty description", () => {
    for (const entry of FORMULA_FUNCTIONS) {
      expect(entry.signature.startsWith(`${entry.name}(`), entry.name).toBe(true);
      expect(entry.description.trim().length, entry.name).toBeGreaterThan(0);
    }
  });

  it("declares well-formed arity bounds", () => {
    for (const entry of FORMULA_FUNCTIONS) {
      expect(Number.isInteger(entry.arity.min), entry.name).toBe(true);
      expect(entry.arity.min, entry.name).toBeGreaterThanOrEqual(0);
      if (entry.arity.max !== undefined) {
        expect(entry.arity.max, entry.name).toBeGreaterThanOrEqual(entry.arity.min);
      }
    }
  });
});

describe("findFunction (F9)", () => {
  it("returns the entry for a known name", () => {
    expect(findFunction("abs")).toMatchObject({ name: "abs", category: "math" });
    expect(findFunction("formatdate")).toMatchObject({ category: "date" });
  });

  it("looks names up case-insensitively", () => {
    expect(findFunction("ABS")).toEqual(findFunction("abs"));
    expect(findFunction("FormatDate")).toBeDefined();
  });

  it("returns undefined for unknown or empty names", () => {
    expect(findFunction("nope")).toBeUndefined();
    expect(findFunction("")).toBeUndefined();
  });
});

describe("searchFunctions (F9)", () => {
  it("returns the whole catalog in order for an empty query", () => {
    expect(searchFunctions("")).toEqual(FORMULA_FUNCTIONS);
    expect(searchFunctions("   ")).toEqual(FORMULA_FUNCTIONS);
  });

  it("rank name-prefix matches ahead of name-substring matches", () => {
    const found = searchFunctions("join").map((entry) => entry.name);
    expect(found).toContain("join");
  });

  it("matches names case-insensitively", () => {
    expect(searchFunctions("DATE").map((entry) => entry.name)).toEqual(
      searchFunctions("date").map((entry) => entry.name),
    );
  });

  it("falls back to description matches", () => {
    expect(searchFunctions("exponent").map((entry) => entry.name)).toEqual(["pow"]);
  });

  it("honours the limit option", () => {
    expect(searchFunctions("", { limit: 3 })).toEqual(FORMULA_FUNCTIONS.slice(0, 3));
    expect(searchFunctions("a", { limit: 1 })).toHaveLength(1);
    expect(searchFunctions("a", { limit: 0 })).toEqual([]);
  });

  it("returns nothing for a query that matches no function", () => {
    expect(searchFunctions("zzzz")).toEqual([]);
  });
});

describe("suggestFunctions (F9)", () => {
  it("completes every function matching a prefix, alphabetically", () => {
    expect(suggestFunctions("date")).toEqual([
      "date",
      "dateadd",
      "datebetween",
      "datesubtract",
    ]);
  });

  it("returns all names for an empty prefix", () => {
    expect(suggestFunctions("")).toEqual([...names].sort());
  });

  it("is case-insensitive and returns nothing for an unknown prefix", () => {
    expect(suggestFunctions("DA")).toEqual(suggestFunctions("da"));
    expect(suggestFunctions("qqq")).toEqual([]);
  });
});

describe("validateCall (F9)", () => {
  it("accepts a call with the correct number of arguments", () => {
    expect(validateCall("abs", 1)).toEqual({ ok: true });
    expect(validateCall("if", 3)).toEqual({ ok: true });
  });

  it("is case-insensitive", () => {
    expect(validateCall("ABS", 1)).toEqual({ ok: true });
  });

  it("accepts optional and variadic arguments", () => {
    expect(validateCall("round", 1).ok).toBe(true);
    expect(validateCall("round", 2).ok).toBe(true);
    expect(validateCall("min", 1).ok).toBe(true);
    expect(validateCall("min", 9).ok).toBe(true);
  });

  it("rejects too few arguments with the function name and expectation", () => {
    const result = validateCall("if", 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("if");
      expect(result.error).toContain("3");
    }
  });

  it("rejects too many arguments for a fixed-arity function", () => {
    expect(validateCall("abs", 2).ok).toBe(false);
    expect(validateCall("round", 3).ok).toBe(false);
  });

  it("rejects unknown functions", () => {
    const result = validateCall("mystery", 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mystery");
  });
});

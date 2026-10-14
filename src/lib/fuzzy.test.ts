import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

/**
 * B43 — command palette fuzzy matcher (red-first).
 *
 * The palette must rank a word-start hit above a scattered one, treat an
 * empty query as "everything, in order", and drop non-matches entirely.
 * These are the three behaviours the UI keyboard-nav depends on.
 */
describe("fuzzyMatch", () => {
  it("returns null when a query character is missing or out of order", () => {
    expect(fuzzyMatch("xyz", "abc")).toBeNull();
    expect(fuzzyMatch("cb", "abc")).toBeNull();
    expect(fuzzyMatch("page", "pap e") ?? null).toBeNull();
  });

  it("matches an empty (or whitespace-only) query with a neutral score", () => {
    expect(fuzzyMatch("", "New page")).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch("   ", "New page")).toEqual({ score: 0, indices: [] });
  });

  it("matches case-insensitively and records the matched indices", () => {
    expect(fuzzyMatch("NP", "New page")).toEqual({ score: expect.any(Number), indices: [0, 4] });
    expect(fuzzyMatch("PAGE", "page")).toEqual({ score: expect.any(Number), indices: [0, 1, 2, 3] });
    expect(fuzzyMatch("page", "Page")).not.toBeNull();
  });

  it("scores a word-start hit above the same letters mid-word", () => {
    const wordStart = fuzzyMatch("ed", "Editor");
    const midWord = fuzzyMatch("ed", "Seedbed");
    expect(wordStart).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(wordStart!.score).toBeGreaterThan(midWord!.score);
  });

  it("scores a consecutive prefix above the same query scattered further in", () => {
    const prefix = fuzzyMatch("doc", "Document");
    const scattered = fuzzyMatch("doc", "Deep ocean cargo");
    expect(prefix).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(prefix!.score).toBeGreaterThan(scattered!.score);
  });

  it("scores an exact full-string match above a longer string it prefixes", () => {
    const exact = fuzzyMatch("page", "page");
    const prefix = fuzzyMatch("page", "page title");
    expect(exact).not.toBeNull();
    expect(prefix).not.toBeNull();
    expect(exact!.score).toBeGreaterThan(prefix!.score);
  });
});

describe("fuzzyFilter", () => {
  const items = ["Editor", "Seedbed", "Login wall"];

  it("returns every item in original order for an empty query", () => {
    const result = fuzzyFilter(["b", "a", "c"], "", (item) => item);
    expect(result.map((entry) => entry.item)).toEqual(["b", "a", "c"]);
    expect(result.every((entry) => entry.score === 0)).toBe(true);
    expect(result.every((entry) => entry.indices.length === 0)).toBe(true);
  });

  it("drops items that do not match the query", () => {
    expect(fuzzyFilter(items, "ed", (item) => item).map((entry) => entry.item)).toEqual([
      "Editor",
      "Seedbed",
    ]);
    expect(fuzzyFilter(items, "zzz", (item) => item)).toEqual([]);
  });

  it("orders matches by descending score", () => {
    const result = fuzzyFilter(["Seedbed", "Editor"], "ed", (item) => item);
    expect(result.map((entry) => entry.item)).toEqual(["Editor", "Seedbed"]);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it("keeps equal-score ties in their original relative order", () => {
    const result = fuzzyFilter(["ab", "ab"], "ab", (item) => item);
    expect(result.map((entry) => entry.item)).toEqual(["ab", "ab"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  MATH_CATEGORIES,
  MATH_SYMBOLS,
  SNIPPET_CURSOR,
  insertSnippet,
  isMathSymbol,
  searchMathSymbols,
  type MathCategory,
  type MathSymbol,
} from "@/lib/math-symbols";

/**
 * Math editor UX — symbol palette (`docs/MISSING_FEATURES` math editor).
 *
 * A pure, categorized LaTeX symbol catalog plus the search/validation/insert
 * helpers the in-editor palette needs. No React, no TipTap, no I/O: the data
 * and the lookups are testable in isolation.
 */

/** Catalog position, used to assert stable ordering without re-deriving it. */
const positionOf = (latex: string): number =>
  MATH_SYMBOLS.findIndex((symbol) => symbol.latex === latex);

/** The searchable text of one symbol (label + keywords), lower-cased. */
const haystack = (symbol: MathSymbol): string =>
  [symbol.label, ...symbol.keywords].join(" ").toLowerCase();

describe("math symbol catalog", () => {
  it("is a non-empty, uniquely-keyed, categorized list in MATH_CATEGORIES order", () => {
    expect(MATH_CATEGORIES).toEqual([
      "greek",
      "operators",
      "arrows",
      "relations",
      "sets",
      "big-ops",
      "accents",
    ]);
    expect(MATH_SYMBOLS.length).toBeGreaterThanOrEqual(50);

    const latex = new Set<string>();
    for (const symbol of MATH_SYMBOLS) {
      expect(symbol.latex.startsWith("\\") || symbol.latex.length === 1).toBe(true);
      expect(symbol.label.length).toBeGreaterThan(0);
      expect(symbol.keywords.length).toBeGreaterThan(0);
      expect(MATH_CATEGORIES).toContain(symbol.category);
      // No duplicate LaTeX commands: the palette and `isMathSymbol` key on it.
      expect(latex.has(symbol.latex), `duplicate latex: ${symbol.latex}`).toBe(false);
      latex.add(symbol.latex);
    }
  });

  it("populates every category, and groups them in declared order", () => {
    const counts = new Map<MathCategory, number>();
    for (const symbol of MATH_SYMBOLS) {
      counts.set(symbol.category, (counts.get(symbol.category) ?? 0) + 1);
    }
    for (const category of MATH_CATEGORIES) {
      expect(counts.get(category) ?? 0, `empty category: ${category}`).toBeGreaterThanOrEqual(2);
    }
    // Category blocks are contiguous and follow MATH_CATEGORIES.
    const seen: MathCategory[] = [];
    for (const symbol of MATH_SYMBOLS) {
      if (seen[seen.length - 1] !== symbol.category) seen.push(symbol.category);
    }
    expect(seen).toEqual([...MATH_CATEGORIES]);
  });
});

describe("searchMathSymbols", () => {
  it("returns the whole catalog (top-N) for a blank query", () => {
    expect(searchMathSymbols("")).toEqual([...MATH_SYMBOLS]);
    expect(searchMathSymbols("   ")).toEqual(searchMathSymbols("")); // blank == empty
    expect(searchMathSymbols("", { limit: 7 })).toEqual(MATH_SYMBOLS.slice(0, 7));
    expect(searchMathSymbols("", { limit: 0 })).toEqual([]);
    expect(searchMathSymbols("", { limit: -3 })).toEqual([]);
  });

  it("matches labels case-insensitively", () => {
    expect(searchMathSymbols("alpha")[0]?.latex).toBe("\\alpha");
    expect(searchMathSymbols("ALPHA")).toEqual(searchMathSymbols("alpha"));
    expect(searchMathSymbols("infinity").some((s) => s.latex === "\\infty")).toBe(true);
  });

  it("matches curated keywords beyond the label", () => {
    expect(searchMathSymbols("union").some((s) => s.latex === "\\cup")).toBe(true);
    expect(searchMathSymbols("del").some((s) => s.latex === "\\nabla")).toBe(true);
    expect(searchMathSymbols("integral").some((s) => s.latex === "\\int")).toBe(true);
    expect(searchMathSymbols("not equal").some((s) => s.latex === "\\neq")).toBe(true);
  });

  it("only returns genuine label/keyword matches, in stable catalog order", () => {
    const results = searchMathSymbols("a");
    expect(results.length).toBeGreaterThan(3);
    for (const symbol of results) expect(haystack(symbol)).toContain("a");
    for (let i = 1; i < results.length; i += 1) {
      expect(positionOf(results[i - 1]!.latex)).toBeLessThan(positionOf(results[i]!.latex));
    }
  });

  it("caps results at the limit while preserving order", () => {
    const all = searchMathSymbols("a");
    expect(searchMathSymbols("a", { limit: 3 })).toEqual(all.slice(0, 3));
    expect(searchMathSymbols("a", { limit: 3 })).toHaveLength(3);
    // A non-integer limit is treated as "no cap".
    expect(searchMathSymbols("a", { limit: 2.5 })).toEqual(all);
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchMathSymbols("zzznotasymbol")).toEqual([]);
    expect(searchMathSymbols("\u{1F984}")).toEqual([]);
  });
});

describe("isMathSymbol", () => {
  it("accepts curated LaTeX and rejects everything else", () => {
    expect(isMathSymbol("\\alpha")).toBe(true);
    expect(isMathSymbol("\\int")).toBe(true);
    expect(isMathSymbol("=")).toBe(true); // single-character symbols are curated too
    expect(isMathSymbol("alpha")).toBe(false); // missing the backslash
    expect(isMathSymbol("\\notacommand")).toBe(false);
    expect(isMathSymbol("")).toBe(false);
    expect(isMathSymbol(null)).toBe(false);
    expect(isMathSymbol(42)).toBe(false);
  });
});

describe("insertSnippet", () => {
  it("puts the caret at the end when the snippet has no placeholder", () => {
    expect(insertSnippet("\\alpha")).toEqual({ text: "\\alpha", cursor: 6 });
    expect(insertSnippet("=")).toEqual({ text: "=", cursor: 1 });
  });

  it("strips the cursor placeholder and reports its position", () => {
    expect(insertSnippet(`\\frac{${SNIPPET_CURSOR}}{}`)).toEqual({
      text: "\\frac{}{}",
      cursor: 6,
    });
    expect(insertSnippet(`\\sqrt{${SNIPPET_CURSOR}}`)).toEqual({
      text: "\\sqrt{}",
      cursor: 6,
    });
  });

  it("lets an explicit cursor override and clamp to the text bounds", () => {
    expect(insertSnippet("\\frac{}{}", { cursor: 3 })).toEqual({
      text: "\\frac{}{}",
      cursor: 3,
    });
    expect(insertSnippet(`\\frac{${SNIPPET_CURSOR}}{}`, { cursor: 0 })).toEqual({
      text: "\\frac{}{}",
      cursor: 0,
    });
    expect(insertSnippet("\\alpha", { cursor: 999 })).toEqual({ text: "\\alpha", cursor: 6 });
    expect(insertSnippet("\\alpha", { cursor: -4 })).toEqual({ text: "\\alpha", cursor: 0 });
  });

  it("composes with catalog symbols (the palette's click path)", () => {
    const symbol = MATH_SYMBOLS.find((s) => s.latex === "\\sum");
    expect(symbol).toBeDefined();
    expect(insertSnippet(symbol!.latex)).toEqual({ text: "\\sum", cursor: 4 });
  });
});

import { describe, expect, it } from "vitest";
import {
  INVALID_REGEX,
  buildFindPattern,
  buildSnippet,
  findInPage,
  nextIndex,
  prevIndex,
  rangesForBlock,
  splitHighlights,
  type FindBlock,
} from "@/lib/find-in-page";

/**
 * The matcher is the whole point of the find bar, so it is pinned exhaustively:
 * all three modes, wrapping navigation, the empty query, the injection-safe
 * regex failure, Unicode, and the highlight splitter. It is pure, so none of
 * this needs a DOM.
 */

const blocks: FindBlock[] = [
  { id: "b1", text: "The cat sat. The cat napped." },
  { id: "b2", text: "A CAT scan and a dog." },
];

describe("findInPage — literal mode", () => {
  it("matches case-insensitively by default, in block then offset order", () => {
    const result = findInPage(blocks, "cat");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches.map((m) => [m.blockId, m.start, m.end])).toEqual([
      ["b1", 4, 7],
      ["b1", 17, 20],
      ["b2", 2, 5],
    ]);
  });

  it("respects caseSensitive", () => {
    const sensitive = findInPage([{ id: "b", text: "cat Cat CAT" }], "Cat", {
      caseSensitive: true,
    });
    expect(sensitive.ok && sensitive.matches.map((m) => m.start)).toEqual([4]);

    const insensitive = findInPage([{ id: "b", text: "cat Cat CAT" }], "cat");
    expect(insensitive.ok && insensitive.matches.map((m) => m.start)).toEqual([0, 4, 8]);
  });

  it("treats regex metacharacters literally", () => {
    const result = findInPage([{ id: "b", text: "a.b axb" }], "a.b");
    expect(result.ok && result.matches.map((m) => [m.start, m.end])).toEqual([[0, 3]]);
  });

  it("requires whole words when wholeWord is set", () => {
    const text = "cat category concatenate cat.";
    const loose = findInPage([{ id: "b", text }], "cat");
    expect(loose.ok && loose.matches).toHaveLength(4);

    const strict = findInPage([{ id: "b", text }], "cat", { wholeWord: true });
    expect(strict.ok && strict.matches.map((m) => m.start)).toEqual([0, 25]);
  });
});

describe("findInPage — regex mode", () => {
  it("compiles the query as a pattern", () => {
    const result = findInPage([{ id: "b", text: "order 12 and 345" }], "\\d+", { regex: true });
    expect(result.ok && result.matches.map((m) => [m.start, m.end])).toEqual([
      [6, 8],
      [13, 16],
    ]);
  });

  it("supports Unicode property classes", () => {
    const result = findInPage([{ id: "b", text: "αβγ and abc" }], "\\p{Script=Greek}+", {
      regex: true,
    });
    expect(result.ok && result.matches.map((m) => [m.start, m.end])).toEqual([[0, 3]]);
  });

  it("combines regex with wholeWord", () => {
    const result = findInPage([{ id: "b", text: "cot concat" }], "c.t", {
      regex: true,
      wholeWord: true,
    });
    expect(result.ok && result.matches.map((m) => [m.start, m.end])).toEqual([[0, 3]]);
  });

  it("returns an error result — never a throw — for an invalid pattern", () => {
    expect(() => findInPage(blocks, "(unclosed", { regex: true })).not.toThrow();
    const result = findInPage(blocks, "(unclosed", { regex: true });
    expect(result).toEqual({ ok: false, error: INVALID_REGEX });
  });

  it("matches `a*` without looping forever on the zero-width matches", () => {
    const result = findInPage([{ id: "b", text: "baa" }], "a*", { regex: true });
    expect(result.ok && result.matches.map((m) => [m.start, m.end])).toEqual([[1, 3]]);
  });

  it("exposes the compiled pattern (or null for an empty query)", () => {
    const built = buildFindPattern("cat", { wholeWord: true });
    expect(built.ok && built.pattern?.source).toBe(
      "(?<![\\p{L}\\p{N}_])(?:cat)(?![\\p{L}\\p{N}_])",
    );
    expect(buildFindPattern("")).toEqual({ ok: true, pattern: null });
  });
});

describe("findInPage — edges", () => {
  it("returns no matches for an empty query", () => {
    expect(findInPage(blocks, "")).toEqual({ ok: true, matches: [] });
  });

  it("matches non-ASCII and astral Unicode", () => {
    const accents = findInPage([{ id: "b", text: "café ☕ café" }], "café");
    expect(accents.ok && accents.matches).toHaveLength(2);

    const emoji = findInPage([{ id: "b", text: "a😀b😀" }], "😀");
    expect(emoji.ok && emoji.matches.map((m) => [m.start, m.end])).toEqual([
      [1, 3],
      [4, 6],
    ]);
  });

  it("tolerates blocks with no text", () => {
    const result = findInPage([{ id: "empty", text: "" }, { id: "b", text: "cat" }], "cat");
    expect(result.ok && result.matches.map((m) => m.blockId)).toEqual(["b"]);
  });
});

describe("snippets", () => {
  it("surrounds a match with context and marks both clamped ends", () => {
    const text = `${"x".repeat(80)}needle${"y".repeat(80)}`;
    const snippet = buildSnippet(text, 80, 86);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
  });

  it("adds no ellipsis when the whole text fits", () => {
    expect(buildSnippet("a needle b", 2, 8)).toBe("a needle b");
  });

  it("carries a snippet on every match", () => {
    const result = findInPage(blocks, "cat");
    expect(result.ok && result.matches.every((m) => m.snippet.length > 0)).toBe(true);
  });
});

describe("nextIndex / prevIndex — wrapping helpers", () => {
  it("steps forward and wraps", () => {
    expect(nextIndex(-1, 3)).toBe(0);
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(1, 3)).toBe(2);
    expect(nextIndex(2, 3)).toBe(0);
    expect(nextIndex(5, 3)).toBe(0);
  });

  it("steps backward and wraps", () => {
    expect(prevIndex(-1, 3)).toBe(2);
    expect(prevIndex(0, 3)).toBe(2);
    expect(prevIndex(1, 3)).toBe(0);
    expect(prevIndex(2, 3)).toBe(1);
  });

  it("stays on the only match and reports an empty list as -1", () => {
    expect(nextIndex(0, 1)).toBe(0);
    expect(prevIndex(0, 1)).toBe(0);
    expect(nextIndex(0, 0)).toBe(-1);
    expect(prevIndex(0, 0)).toBe(-1);
  });
});

describe("splitHighlights", () => {
  it("splits a match at the head, middle and none", () => {
    expect(splitHighlights("hello world", [{ start: 0, end: 5 }])).toEqual([
      { text: "hello", match: true },
      { text: " world", match: false },
    ]);
    expect(splitHighlights("hello world", [{ start: 6, end: 11 }])).toEqual([
      { text: "hello ", match: false },
      { text: "world", match: true },
    ]);
    expect(splitHighlights("hello", [])).toEqual([{ text: "hello", match: false }]);
  });

  it("returns nothing for empty text", () => {
    expect(splitHighlights("", [{ start: 0, end: 1 }])).toEqual([]);
  });

  it("sorts disjoint ranges and produces one marker per match", () => {
    expect(splitHighlights("aXbXc", [{ start: 3, end: 4 }, { start: 1, end: 2 }])).toEqual([
      { text: "a", match: false },
      { text: "X", match: true },
      { text: "b", match: false },
      { text: "X", match: true },
      { text: "c", match: false },
    ]);
  });

  it("merges overlapping ranges and clamps out-of-range ones", () => {
    expect(splitHighlights("abcdef", [{ start: 0, end: 3 }, { start: 2, end: 5 }])).toEqual([
      { text: "abcde", match: true },
      { text: "f", match: false },
    ]);
    expect(splitHighlights("abc", [{ start: 1, end: 100 }])).toEqual([
      { text: "a", match: false },
      { text: "bc", match: true },
    ]);
  });
});

describe("rangesForBlock", () => {
  it("keeps only the ranges belonging to the block", () => {
    const result = findInPage(blocks, "cat");
    if (!result.ok) throw new Error("expected matches");
    expect(rangesForBlock(result.matches, "b1")).toEqual([
      { start: 4, end: 7 },
      { start: 17, end: 20 },
    ]);
    expect(rangesForBlock(result.matches, "b2")).toEqual([{ start: 2, end: 5 }]);
    expect(rangesForBlock(result.matches, "missing")).toEqual([]);
  });
});

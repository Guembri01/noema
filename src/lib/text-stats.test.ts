import { describe, expect, it } from "vitest";
import {
  characterCount,
  collectText,
  computeStats,
  countBlocksByType,
  formatReadingTime,
  wordCount,
  type TextBlock,
} from "./text-stats";

/**
 * Page text statistics (word/character counts + reading time) — pure logic,
 * red-first. The counting rules are deliberately documented in text-stats.ts
 * because each one is a product decision:
 *  - a "word" is a run of Unicode letters/digits with optional internal
 *    apostrophes (`don't` = 1); hyphens split (`well-known` = 2);
 *  - CJK ideographs/kana/hangul count one-by-one (no spaces to split on);
 *  - characters are counted as Unicode code points.
 */

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("wordCount — unicode-aware word counting", () => {
  it("counts whitespace-separated words", () => {
    expect(wordCount("hello world")).toBe(2);
    expect(wordCount("one")).toBe(1);
  });

  it("returns 0 for empty or punctuation-only text", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   \n\t ")).toBe(0);
    expect(wordCount("!!! ... ??? --")).toBe(0);
  });

  it("splits on hyphens but keeps internal apostrophes", () => {
    expect(wordCount("well-known")).toBe(2);
    expect(wordCount("don't")).toBe(1);
    expect(wordCount("it's a test")).toBe(3);
    expect(wordCount("'quoted'")).toBe(1);
    expect(wordCount("rock 'n' roll")).toBe(3);
  });

  it("counts accented and non-latin letters as words", () => {
    expect(wordCount("café naïve")).toBe(2);
    expect(wordCount("Über Café")).toBe(2);
    expect(wordCount("item 42")).toBe(2);
  });

  it("counts each CJK character individually", () => {
    expect(wordCount("你好世界")).toBe(4);
    expect(wordCount("こんにちは")).toBe(5);
    expect(wordCount("안녕하세요")).toBe(5);
    expect(wordCount("hello 世界")).toBe(3);
  });
});

describe("characterCount — with and without spaces", () => {
  it("counts every character when spaces are included", () => {
    expect(characterCount("ab cd")).toBe(5);
    expect(characterCount(" a b ")).toBe(5);
    expect(characterCount("")).toBe(0);
  });

  it("drops whitespace when includeSpaces is false", () => {
    expect(characterCount("ab cd", { includeSpaces: false })).toBe(4);
    expect(characterCount(" a b ", { includeSpaces: false })).toBe(2);
    expect(characterCount("a b\nc", { includeSpaces: false })).toBe(3);
  });

  it("counts Unicode code points, so an emoji is one character", () => {
    expect(characterCount("café")).toBe(4);
    expect(characterCount("😀a")).toBe(2);
  });
});

describe("collectText — flatten blocks to plain text", () => {
  it("joins sibling block text with single spaces", () => {
    const blocks: TextBlock[] = [
      { type: "paragraph", text: "Hello" },
      { type: "paragraph", text: "world" },
    ];
    expect(collectText(blocks)).toBe("Hello world");
  });

  it("recurses into nested children", () => {
    const blocks: TextBlock[] = [
      {
        type: "toggle",
        text: "Title",
        children: [{ type: "paragraph", text: "body text" }],
      },
    ];
    expect(collectText(blocks)).toBe("Title body text");
  });

  it("skips code by default but honours a custom skipTypes", () => {
    const blocks: TextBlock[] = [
      { type: "paragraph", text: "Hi" },
      { type: "code", text: "const x = 1" },
    ];
    expect(collectText(blocks)).toBe("Hi");
    expect(collectText(blocks, { skipTypes: [] })).toBe("Hi const x = 1");
    expect(collectText(blocks, { skipTypes: ["paragraph"] })).toBe("const x = 1");
  });

  it("strips rich-text objects (marks) down to their text", () => {
    const blocks: TextBlock[] = [
      { type: "paragraph", text: { text: "Bold", marks: [{ type: "bold" }] } },
      { type: "paragraph", text: [{ text: "Hello" }, { text: "world" }] },
    ];
    expect(collectText(blocks)).toBe("Bold Hello world");
  });

  it("collapses whitespace and trims; tolerates empty input", () => {
    expect(collectText([{ type: "paragraph", text: "  a   b  " }])).toBe("a b");
    expect(collectText([])).toBe("");
    expect(collectText([{ type: "divider" }])).toBe("");
  });
});

describe("formatReadingTime — rounding and label", () => {
  it("labels anything under a minute as 'less than a minute'", () => {
    expect(formatReadingTime(0)).toBe("less than a minute");
    expect(formatReadingTime(0.5)).toBe("less than a minute");
    expect(formatReadingTime(0.99)).toBe("less than a minute");
  });

  it("rounds to the nearest minute once at or above one", () => {
    expect(formatReadingTime(1)).toBe("1 min read");
    expect(formatReadingTime(1.4)).toBe("1 min read");
    expect(formatReadingTime(1.5)).toBe("2 min read");
    expect(formatReadingTime(3)).toBe("3 min read");
  });
});

describe("computeStats — whole-page stats", () => {
  it("returns zeroed stats for an empty document", () => {
    expect(computeStats([])).toEqual({
      words: 0,
      characters: 0,
      charactersNoSpaces: 0,
      readingTimeMinutes: 0,
      readingTimeLabel: "less than a minute",
    });
  });

  it("counts words and characters, ignoring code by default", () => {
    const stats = computeStats([
      { type: "paragraph", text: "one two" },
      { type: "paragraph", text: "ab cd" },
      { type: "code", text: "three four five six" },
    ]);
    expect(stats.words).toBe(4);
    expect(stats.characters).toBe(13);
    expect(stats.charactersNoSpaces).toBe(10);
  });

  it("rounds reading time up at 200 wpm by default", () => {
    expect(computeStats([{ type: "paragraph", text: words(200) }]).readingTimeMinutes).toBe(1);
    const over = computeStats([{ type: "paragraph", text: words(201) }]);
    expect(over.words).toBe(201);
    expect(over.readingTimeMinutes).toBe(2);
    expect(over.readingTimeLabel).toBe("2 min read");
  });

  it("respects a custom wordsPerMinute", () => {
    const stats = computeStats([{ type: "paragraph", text: words(150) }], {
      wordsPerMinute: 100,
    });
    expect(stats.readingTimeMinutes).toBe(2);
    expect(stats.readingTimeLabel).toBe("2 min read");
  });
});

describe("countBlocksByType — recursive tally", () => {
  it("counts blocks by type, including nested children", () => {
    const blocks: TextBlock[] = [
      { type: "paragraph", text: "a" },
      { type: "paragraph", text: "b" },
      {
        type: "toggle",
        text: "t",
        children: [
          { type: "code", text: "x" },
          { type: "paragraph", text: "c" },
        ],
      },
    ];
    expect(countBlocksByType(blocks)).toEqual({
      paragraph: 3,
      toggle: 1,
      code: 1,
    });
  });

  it("returns an empty tally for an empty document", () => {
    expect(countBlocksByType([])).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELLIPSIS,
  ellipsize,
  truncateEnd,
  truncateLines,
  truncateMiddle,
  truncateWords,
} from "./truncate";

/**
 * Smart truncation — pure, Unicode-surrogate-safe string cropping.
 *
 * Pinned product rules:
 *  - limits (`max`, `maxWords`, `maxLines`) count code points / words / lines;
 *  - text at or under the limit is returned *unchanged* (no gratuitous `…`);
 *  - the ellipsis shares the `max` budget, so output never exceeds `max`;
 *  - a surrogate pair (emoji, rare CJK) is never sliced in half.
 */

describe("ellipsize — code-point-safe hard cut with a marker", () => {
  it("returns text that already fits unchanged, including exactly at the limit", () => {
    expect(ellipsize("hello", 10)).toBe("hello");
    expect(ellipsize("hello", 5)).toBe("hello");
  });

  it("cuts to fit and appends the default ellipsis", () => {
    expect(ellipsize("hello world", 8)).toBe("hello w…");
    expect(DEFAULT_ELLIPSIS).toBe("…");
  });

  it("honours a custom ellipsis and a bare (empty) cut", () => {
    expect(ellipsize("hello world", 8, { ellipsis: "..." })).toBe("hello...");
    expect(ellipsize("hello world", 5, { ellipsis: "" })).toBe("hello");
  });

  it("returns an empty string for non-positive limits and empty input", () => {
    expect(ellipsize("hello", 0)).toBe("");
    expect(ellipsize("hello", -3)).toBe("");
    expect(ellipsize("", 5)).toBe("");
  });

  it("falls back to the marker when the limit is too small for any text", () => {
    expect(ellipsize("hello", 1)).toBe("…");
    expect(ellipsize("hello", 2, { ellipsis: "..." })).toBe("..");
  });

  it("never splits a surrogate pair", () => {
    expect(ellipsize("😀😀😀😀", 3)).toBe("😀😀…");
    expect(Array.from(ellipsize("😀😀😀😀", 3))).toHaveLength(3);
    expect(ellipsize("a😀b", 2)).toBe("a…");
  });
});

describe("truncateEnd — keep the head, trim the seam", () => {
  it("returns text that already fits unchanged, including exactly at the limit", () => {
    expect(truncateEnd("hello", 10)).toBe("hello");
    expect(truncateEnd("hello", 5)).toBe("hello");
  });

  it("keeps the head and appends a marker when it cuts", () => {
    expect(truncateEnd("hello world", 8)).toBe("hello w…");
    expect(truncateEnd("hello world", 8, { ellipsis: "…more" })).toBe("hel…more");
  });

  it("collapses whitespace left dangling at the cut", () => {
    expect(truncateEnd("hello  world", 7)).toBe("hello…");
  });

  it("returns an empty string for non-positive limits", () => {
    expect(truncateEnd("hello", 0)).toBe("");
  });

  it("never splits a surrogate pair", () => {
    expect(truncateEnd("😀😀😀", 2)).toBe("😀…");
  });
});

describe("truncateMiddle — keep the head and the tail", () => {
  it("returns text that already fits unchanged, including exactly at the limit", () => {
    expect(truncateMiddle("hello", 10)).toBe("hello");
    expect(truncateMiddle("hello", 5)).toBe("hello");
  });

  it("keeps head and tail around a single marker", () => {
    expect(truncateMiddle("abcdefghij", 7)).toBe("abc…hij");
    expect(truncateMiddle("hello world foo bar", 15)).toBe("hello w…foo bar");
  });

  it("trims whitespace at both sides of the seam", () => {
    expect(truncateMiddle("ab    cd", 6)).toBe("ab…cd");
  });

  it("returns an empty string for non-positive limits", () => {
    expect(truncateMiddle("hello", 0)).toBe("");
  });

  it("never splits a surrogate pair", () => {
    expect(truncateMiddle("😀😀😀😀😀", 3)).toBe("😀…😀");
  });
});

describe("truncateWords — keep the first N words", () => {
  it("returns text that already fits unchanged, including exactly at the limit", () => {
    expect(truncateWords("one two three", 5)).toBe("one two three");
    expect(truncateWords("one two three", 3)).toBe("one two three");
    expect(truncateWords("a\nb", 5)).toBe("a\nb");
  });

  it("keeps the first N words and marks the cut, collapsing inner whitespace", () => {
    expect(truncateWords("one two three four", 2)).toBe("one two…");
    expect(truncateWords("one   two\tthree", 2)).toBe("one two…");
  });

  it("counts any whitespace-free run (including CJK) as one word", () => {
    expect(truncateWords("你好世界 foo bar", 1)).toBe("你好世界…");
  });

  it("returns an empty string for non-positive limits and empty input", () => {
    expect(truncateWords("hello", 0)).toBe("");
    expect(truncateWords("", 3)).toBe("");
  });
});

describe("truncateLines — keep the first N lines", () => {
  it("returns text that already fits unchanged, including exactly at the limit", () => {
    expect(truncateLines("a\nb", 5)).toBe("a\nb");
    expect(truncateLines("a\nb\nc", 3)).toBe("a\nb\nc");
  });

  it("keeps the first N lines and marks the cut on the last kept line", () => {
    expect(truncateLines("a\nb\nc\nd", 2)).toBe("a\nb…");
  });

  it("normalises CRLF seams and counts a trailing newline as an empty line", () => {
    expect(truncateLines("a\r\nb\r\nc", 2)).toBe("a\nb…");
    expect(truncateLines("a\nb\n", 2)).toBe("a\nb…");
  });

  it("returns an empty string for non-positive limits and keeps empty input", () => {
    expect(truncateLines("a\nb", 0)).toBe("");
    expect(truncateLines("", 3)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAR_WIDTHS,
  classifyChar,
  estimateTextWidth,
  maxLineWidth,
  wrapText,
} from "./text-measure";

/**
 * Text width estimation — pure, deterministic, red-first.
 *
 * Widths are expressed in "em" units at `fontScale` 1, so the defaults pin the
 * char-class contract:
 *  - narrow glyphs (whitespace, `i`, punctuation like `.`/`,`) = 0.5;
 *  - wide glyphs (ordinary letters/digits) = 1;
 *  - CJK ideographs/kana/hangul (full-width) = 2;
 *  - emoji = 2.
 * A `fontScale` multiplies the whole measurement; `charWidths` overrides any
 * class. `wrapText` is greedy word wrap (a too-long word stays intact), and it
 * preserves explicit line breaks (a blank source line becomes an empty line).
 */

describe("classifyChar — glyph class by code point", () => {
  it("classifies whitespace and thin glyphs as narrow", () => {
    expect(classifyChar(" ")).toBe("narrow");
    expect(classifyChar("i")).toBe("narrow");
    expect(classifyChar(".")).toBe("narrow");
  });

  it("classifies ordinary letters/digits as wide", () => {
    expect(classifyChar("a")).toBe("wide");
    expect(classifyChar("M")).toBe("wide");
    expect(classifyChar("4")).toBe("wide");
  });

  it("classifies CJK and emoji as full-width classes", () => {
    expect(classifyChar("你")).toBe("cjk");
    expect(classifyChar("あ")).toBe("cjk");
    expect(classifyChar("😀")).toBe("emoji");
  });
});

describe("estimateTextWidth — summed char-class weights", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTextWidth("")).toBe(0);
  });

  it("measures wide letters at 1 em each", () => {
    expect(estimateTextWidth("abc")).toBe(3);
    expect(estimateTextWidth("42")).toBe(2);
  });

  it("measures narrow glyphs at 0.5 em each", () => {
    expect(estimateTextWidth("ill")).toBeCloseTo(1.5);
  });

  it("measures CJK and emoji at 2 em each", () => {
    expect(estimateTextWidth("你好")).toBe(4);
    expect(estimateTextWidth("😀")).toBe(2);
    expect(estimateTextWidth("a😀b")).toBe(4);
  });

  it("adds a half-width space between words", () => {
    expect(estimateTextWidth("ab cd")).toBeCloseTo(4.5);
  });

  it("scales the whole width by fontScale", () => {
    expect(estimateTextWidth("abc", { fontScale: 2 })).toBe(6);
    expect(estimateTextWidth("你好", { fontScale: 0.5 })).toBe(2);
  });

  it("falls back to fontScale 1 for non-finite or non-positive values", () => {
    expect(estimateTextWidth("abc", { fontScale: Number.NaN })).toBe(3);
    expect(estimateTextWidth("abc", { fontScale: -2 })).toBe(3);
  });

  it("honours a partial charWidths override and ignores bad values", () => {
    expect(estimateTextWidth("abc", { charWidths: { wide: 3 } })).toBe(9);
    expect(estimateTextWidth("ill", { charWidths: { narrow: 1 } })).toBe(3);
    expect(estimateTextWidth("abc", { charWidths: { wide: Number.NaN } })).toBe(3);
    expect(DEFAULT_CHAR_WIDTHS.cjk).toBe(2);
  });
});

describe("wrapText — greedy word wrap", () => {
  it("breaks between words that would overflow maxWidth", () => {
    expect(wrapText("aaa bbb ccc", { maxWidth: 3 })).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("packs as many words as fit into one line", () => {
    expect(wrapText("aaa bbb ccc", { maxWidth: 7 })).toEqual(["aaa bbb", "ccc"]);
  });

  it("keeps an over-long word intact on its own line", () => {
    expect(wrapText("abcdefgh", { maxWidth: 3 })).toEqual(["abcdefgh"]);
  });

  it("respects fontScale when deciding breaks", () => {
    expect(wrapText("aaa bbb", { maxWidth: 7 })).toEqual(["aaa bbb"]);
    expect(wrapText("aaa bbb", { maxWidth: 7, fontScale: 2 })).toEqual(["aaa", "bbb"]);
  });

  it("preserves explicit line breaks and blank lines", () => {
    expect(wrapText("aaa\nbbb", { maxWidth: 100 })).toEqual(["aaa", "bbb"]);
    expect(wrapText("a\n\nb", { maxWidth: 100 })).toEqual(["a", "", "b"]);
  });

  it("collapses runs of whitespace inside a line", () => {
    expect(wrapText("a   b", { maxWidth: 100 })).toEqual(["a b"]);
  });

  it("does not wrap without a finite maxWidth and yields one empty line for empty text", () => {
    expect(wrapText("aaa bbb")).toEqual(["aaa bbb"]);
    expect(wrapText("")).toEqual([""]);
  });
});

describe("maxLineWidth — widest visual line", () => {
  it("measures a single line", () => {
    expect(maxLineWidth("abc")).toBe(3);
  });

  it("returns the widest of several lines", () => {
    expect(maxLineWidth("abc\nab")).toBe(3);
    expect(maxLineWidth("你好\nab")).toBe(4);
  });

  it("returns 0 for empty text and scales with fontScale", () => {
    expect(maxLineWidth("")).toBe(0);
    expect(maxLineWidth("abc\n你好", { fontScale: 2 })).toBe(8);
  });
});

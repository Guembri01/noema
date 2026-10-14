import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_MAX,
  DISPLAY_SCALES,
  blocksToQuote,
  formatPullQuote,
  isPullQuoteSize,
  parsePullQuote,
  quoteToBlocks,
  validatePullQuote,
} from "./pull-quote";

describe("parsePullQuote", () => {
  it("accepts an object and normalises whitespace", () => {
    expect(parsePullQuote({ text: "  To be or not to be  " })).toEqual({
      ok: true,
      value: { text: "To be or not to be" },
    });
  });

  it("keeps an optional attribution and display size", () => {
    expect(
      parsePullQuote({ text: "Design is thinking made visual", attribution: " Saul Bass ", size: "large" }),
    ).toEqual({
      ok: true,
      value: { text: "Design is thinking made visual", attribution: "Saul Bass", size: "large" },
    });
  });

  it("treats a bare string as the quote text", () => {
    expect(parsePullQuote("  Simplicity is the ultimate sophistication  ")).toEqual({
      ok: true,
      value: { text: "Simplicity is the ultimate sophistication" },
    });
  });

  it("parses a JSON string of the object shape", () => {
    expect(parsePullQuote('{"text":"Talk is cheap","attribution":"Linus"}')).toEqual({
      ok: true,
      value: { text: "Talk is cheap", attribution: "Linus" },
    });
  });

  it("reports empty text and malformed input as errors", () => {
    expect(parsePullQuote({ text: "   " })).toEqual({ ok: false, error: "A pull quote needs text." });
    expect(parsePullQuote("")).toEqual({ ok: false, error: "A pull quote needs text." });
    expect(parsePullQuote(42)).toEqual({
      ok: false,
      error: "A pull quote must be an object or a JSON string.",
    });
  });

  it("rejects an unknown display size and a non-string attribution", () => {
    expect(parsePullQuote({ text: "Hi", size: "huge" })).toEqual({
      ok: false,
      error: '"huge" is not a display scale.',
    });
    expect(parsePullQuote({ text: "Hi", attribution: 7 })).toEqual({
      ok: false,
      error: "The attribution must be a string.",
    });
  });
});

describe("validatePullQuote", () => {
  it("accepts a non-empty quote", () => {
    expect(validatePullQuote({ text: "Stay hungry" })).toEqual({ ok: true });
  });

  it("requires text", () => {
    expect(validatePullQuote({ text: "  " })).toEqual({
      ok: false,
      errors: ["A pull quote needs text."],
    });
  });

  it("caps the attribution length", () => {
    const atCap = validatePullQuote({ text: "Hi", attribution: "x".repeat(ATTRIBUTION_MAX) });
    expect(atCap).toEqual({ ok: true });
    const tooLong = validatePullQuote({ text: "Hi", attribution: "x".repeat(ATTRIBUTION_MAX + 1) });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.errors[0]).toContain(String(ATTRIBUTION_MAX));
  });

  it("rejects non-objects", () => {
    expect(validatePullQuote(null).ok).toBe(false);
    expect(validatePullQuote("plain").ok).toBe(false);
  });
});

describe("formatPullQuote", () => {
  it("returns the text alone when there is no attribution", () => {
    expect(formatPullQuote({ text: "Less is more" })).toBe("Less is more");
  });

  it("appends an em-dashed attribution on its own line", () => {
    expect(formatPullQuote({ text: "Less is more", attribution: "  Mies  " })).toBe(
      "Less is more\n\u2014 Mies",
    );
  });

  it("omits a blank attribution", () => {
    expect(formatPullQuote({ text: "Less is more", attribution: "   " })).toBe("Less is more");
  });
});

describe("quoteToBlocks / blocksToQuote", () => {
  it("emits a blockquote and an attribution paragraph", () => {
    expect(quoteToBlocks({ text: "Make it simple", attribution: "Someone", size: "large" })).toEqual([
      {
        type: "blockquote",
        attrs: { size: "large" },
        content: [{ type: "text", text: "Make it simple" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "\u2014 Someone" }] },
    ]);
  });

  it("omits attribution and attrs for a default-scale quote", () => {
    expect(quoteToBlocks({ text: "Just the quote" })).toEqual([
      { type: "blockquote", content: [{ type: "text", text: "Just the quote" }] },
    ]);
  });

  it("round-trips a quote with attribution and size", () => {
    const quote = { text: "Fortune favours the bold", attribution: "Virgil", size: "large" as const };
    expect(blocksToQuote(quoteToBlocks(quote))).toEqual(quote);
  });

  it("round-trips a plain quote", () => {
    const quote = { text: "Move fast" };
    expect(blocksToQuote(quoteToBlocks(quote))).toEqual(quote);
  });

  it("reads a block pair, tolerating dash and bare paragraphs", () => {
    expect(
      blocksToQuote([
        { type: "paragraph", content: [{ type: "text", text: "Quote text" }] },
        { type: "paragraph", content: [{ type: "text", text: "- Attribution" }] },
      ]),
    ).toEqual({ text: "Quote text", attribution: "Attribution" });
  });

  it("returns an empty quote for no blocks", () => {
    expect(blocksToQuote([])).toEqual({ text: "" });
  });
});

describe("DISPLAY_SCALES", () => {
  it("lists the supported scales smallest first", () => {
    expect(DISPLAY_SCALES).toEqual(["default", "large"]);
    expect(isPullQuoteSize("large")).toBe(true);
    expect(isPullQuoteSize("huge")).toBe(false);
  });
});

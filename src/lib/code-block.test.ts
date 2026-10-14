import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPTION_MAX_LENGTH,
  formatCaption,
  normalizeLanguage,
  numberLines,
  validateCaption,
} from "@/lib/code-block";

/**
 * §1 code-block affordances — pure helpers only:
 *  - the line-number gutter maths (`numberLines`),
 *  - language canonicalisation shared with the picker (`normalizeLanguage`),
 *  - caption formatting / validation stored under a block.
 */
describe("code-block helpers", () => {
  describe("numberLines", () => {
    it("numbers lines from 1 by default", () => {
      expect(numberLines("const a = 1;\nconst b = 2;")).toEqual([
        { n: 1, text: "const a = 1;" },
        { n: 2, text: "const b = 2;" },
      ]);
    });

    it("honours a custom start number", () => {
      const rows = numberLines("a\nb\nc", { start: 10 });
      expect(rows.map((row) => row.n)).toEqual([10, 11, 12]);
    });

    it("treats an empty block as a single empty line", () => {
      expect(numberLines("")).toEqual([{ n: 1, text: "" }]);
    });

    it("drops a single trailing newline instead of adding a phantom line", () => {
      expect(numberLines("a\nb\n")).toEqual([
        { n: 1, text: "a" },
        { n: 2, text: "b" },
      ]);
      expect(numberLines("only\n")).toEqual([{ n: 1, text: "only" }]);
    });

    it("keeps genuinely blank interior lines", () => {
      expect(numberLines("a\n\nb")).toEqual([
        { n: 1, text: "a" },
        { n: 2, text: "" },
        { n: 3, text: "b" },
      ]);
    });

    it("normalises CRLF and lone CR line endings", () => {
      expect(numberLines("a\r\nb")).toEqual([
        { n: 1, text: "a" },
        { n: 2, text: "b" },
      ]);
      expect(numberLines("a\rb")).toEqual([
        { n: 1, text: "a" },
        { n: 2, text: "b" },
      ]);
    });

    it("caps the returned rows with max", () => {
      expect(numberLines("a\nb\nc", { max: 2 })).toEqual([
        { n: 1, text: "a" },
        { n: 2, text: "b" },
      ]);
      expect(numberLines("a\nb", { max: 99 })).toHaveLength(2);
      expect(numberLines("a\nb", { max: 0 })).toEqual([]);
    });

    it("soft-wraps long lines, blanking the continuation number", () => {
      expect(numberLines("abcdef", { wrap: 3 })).toEqual([
        { n: 1, text: "abc" },
        { n: null, text: "def" },
      ]);
    });

    it("numbers only the first wrapped segment of each line", () => {
      expect(numberLines("ab\ncdef", { wrap: 2 })).toEqual([
        { n: 1, text: "ab" },
        { n: 2, text: "cd" },
        { n: null, text: "ef" },
      ]);
    });

    it("leaves short lines unwrapped and keeps blank rows", () => {
      expect(numberLines("abc\n", { wrap: 2 })).toEqual([
        { n: 1, text: "ab" },
        { n: null, text: "c" },
      ]);
      expect(numberLines("", { wrap: 5 })).toEqual([{ n: 1, text: "" }]);
    });

    it("falls back to line 1 for a non-positive/non-integer start", () => {
      expect(numberLines("a", { start: 0 })[0].n).toBe(1);
      expect(numberLines("a", { start: -3 })[0].n).toBe(1);
      expect(numberLines("a", { start: 2.5 })[0].n).toBe(1);
    });
  });

  describe("normalizeLanguage", () => {
    it("resolves the common fence aliases to canonical slugs", () => {
      expect(normalizeLanguage("js")).toBe("javascript");
      expect(normalizeLanguage("ts")).toBe("typescript");
      expect(normalizeLanguage("py")).toBe("python");
    });

    it("trims and lowercases before resolving", () => {
      expect(normalizeLanguage("  JS ")).toBe("javascript");
      expect(normalizeLanguage("PYTHON")).toBe("python");
    });

    it("covers the wider alias set", () => {
      expect(normalizeLanguage("tsx")).toBe("typescript");
      expect(normalizeLanguage("sh")).toBe("shell");
      expect(normalizeLanguage("yml")).toBe("yaml");
      expect(normalizeLanguage("c++")).toBe("cpp");
      expect(normalizeLanguage("txt")).toBe("plaintext");
    });

    it("passes unknown languages through as a cleaned slug", () => {
      expect(normalizeLanguage("Dart")).toBe("dart");
      expect(normalizeLanguage("  Brainfuck ")).toBe("brainfuck");
    });

    it("maps blank/absent values to an empty slug", () => {
      expect(normalizeLanguage("")).toBe("");
      expect(normalizeLanguage("   ")).toBe("");
      expect(normalizeLanguage(null)).toBe("");
      expect(normalizeLanguage(undefined)).toBe("");
    });
  });

  describe("captions", () => {
    it("trims and collapses whitespace in formatCaption", () => {
      expect(formatCaption("  hello  ")).toBe("hello");
      expect(formatCaption("a\n  b\tc")).toBe("a b c");
      expect(formatCaption(null)).toBe("");
      expect(formatCaption(undefined)).toBe("");
    });

    it("accepts an empty caption and one within the limit", () => {
      expect(validateCaption("")).toEqual({ ok: true });
      expect(validateCaption("  ")).toEqual({ ok: true });
      expect(validateCaption("short", { maxLength: 10 })).toEqual({ ok: true });
      expect(validateCaption("exactly10!", { maxLength: 10 })).toEqual({ ok: true });
    });

    it("rejects a caption over the limit with a safe message", () => {
      const result = validateCaption("too long", { maxLength: 3 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("too long");
        expect(result.error).toContain("8 of 3");
      }
    });

    it("measures the formatted caption, not the raw whitespace", () => {
      // Trailing padding must not push a caption over its limit.
      expect(validateCaption("ab   ", { maxLength: 2 })).toEqual({ ok: true });
    });

    it("honours a strict maxLength of 0 and the default fallback", () => {
      expect(validateCaption("", { maxLength: 0 })).toEqual({ ok: true });
      expect(validateCaption("x", { maxLength: 0 }).ok).toBe(false);
      expect(DEFAULT_CAPTION_MAX_LENGTH).toBe(200);
      // An invalid limit falls back to the default (200), so this passes.
      expect(validateCaption("x".repeat(200), { maxLength: -1 })).toEqual({ ok: true });
    });
  });
});

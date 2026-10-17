import { describe, expect, it } from "vitest";

import { parseConfluenceExport } from "@/lib/import-confluence";
import { parseGoogleDoc } from "@/lib/import-gdocs";
import { sanitizeHtml } from "@/lib/html-sanitize";
import { HTML_MAX_NESTING } from "@/lib/html-nesting";

/**
 * B131 — the nesting limit of the HTML tokenizer.
 *
 * The tokenizer builds a tree, and the tree is walked further down
 * **recursively**. A document with deeply nested tags therefore overflows the
 * stack: 10 000 nested `<b>` (40 KB) are enough for a
 * `RangeError: Maximum call stack size exceeded`, and the Confluence import
 * does not catch it — the request answers 500.
 *
 * These tests pin the limit: a document that is nested far deeper than any
 * real markup is read without throwing, and the content of a document that
 * stays inside the limit is untouched.
 */

describe("the nesting limit of the HTML tokenizer", () => {
  it("reads a document with 10 000 nested tags without throwing", () => {
    const html = "<b>".repeat(10_000);
    expect(() => parseConfluenceExport({ html })).not.toThrow();
  });

  it("reads a document with 10 000 nested tags in the Google Docs parser", () => {
    const html = "<b>".repeat(10_000);
    expect(() => parseGoogleDoc({ html })).not.toThrow();
  });

  it("sanitizes a document with 10 000 nested tags without throwing", () => {
    const html = "<b>".repeat(10_000);
    expect(() => sanitizeHtml(html)).not.toThrow();
  });

  it("keeps the content of a document that stays inside the limit", () => {
    const depth = HTML_MAX_NESTING - 1;
    const html = "<b>".repeat(depth) + "text" + "</b>".repeat(depth);
    const out = sanitizeHtml(html);
    expect(out).toContain("text");
    expect(out.match(/<b>/g)?.length).toBe(depth);
  });

  it("unwraps the elements below the limit and keeps their content", () => {
    const html = "<b>".repeat(HTML_MAX_NESTING + 50) + "text";
    const out = sanitizeHtml(html);
    expect(out).toContain("text");
    // The elements below the limit are unwrapped — they become siblings, so
    // the *depth* of the output stays inside the limit.
    let depth = 0;
    let deepest = 0;
    for (const match of out.matchAll(/<b>|<\/b>/g)) {
      depth += match[0] === "<b>" ? 1 : -1;
      if (depth > deepest) deepest = depth;
    }
    expect(deepest).toBeLessThanOrEqual(HTML_MAX_NESTING);
  });
});

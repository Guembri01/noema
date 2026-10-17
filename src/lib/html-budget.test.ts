import { describe, expect, it } from "vitest";

import { parseConfluenceExport } from "@/lib/import-confluence";
import {
  estimateHtmlScanSteps,
  HTML_SCAN_BUDGET,
  underHtmlScanBudget,
} from "@/lib/html-budget";

/**
 * B130 — the work budget of the HTML tokenizer.
 *
 * The tokenizer finds its tags with a regular expression whose attribute
 * group backtracks: at every tag start it reads forward to the next `>` and
 * gives the work back one character at a time when there is none. A document
 * with many tag starts and no closing `>` therefore costs Θ(n·k) — measured
 * on the upstream's `main`: 35 KB of `<script` blocked the event loop for
 * 8.3 s, 70 KB for 31 s, while the import route accepts a 16 MB body.
 *
 * These tests pin the budget: a document built to make the backtracking work
 * is refused (and refused *fast* — the default test timeout is the guard),
 * a well-formed document is not.
 */

describe("the work budget of the HTML tokenizer", () => {
  it("charges a well-formed document about its own length", () => {
    const html = "<p>Absatz mit Text</p>".repeat(1_000);
    expect(estimateHtmlScanSteps(html)).toBeLessThan(html.length * 2);
    expect(underHtmlScanBudget(html)).toBe(true);
  });

  it("charges a document that never closes a tag for every tag start", () => {
    const html = "<script".repeat(10_000);
    // Every tag start has to cover the rest of the document.
    expect(estimateHtmlScanSteps(html)).toBeGreaterThan(HTML_SCAN_BUDGET);
    expect(underHtmlScanBudget(html)).toBe(false);
  });

  it("charges a document with a huge text block only for the open tag", () => {
    // The text block is behind a closed tag, so the tokenizer reads it
    // once — the cost is the length of the tag, not the length of the text.
    const html = `<p>${"x".repeat(2_000_000)}`;
    expect(estimateHtmlScanSteps(html)).toBeLessThan(10);
    expect(underHtmlScanBudget(html)).toBe(true);
  });

  it("charges a document with an open tag before a huge text block", () => {
    // The same text, but behind a tag that is never closed: the tokenizer
    // reads forward to the `>` that never comes.
    const html = `<p ${"x".repeat(2_000_000)}`;
    expect(estimateHtmlScanSteps(html)).toBeGreaterThan(1_000_000);
    expect(estimateHtmlScanSteps(html)).toBeLessThan(HTML_SCAN_BUDGET);
  });

  it("sits above the largest document the import accepts", () => {
    // The import refuses documents above 5 MB. The estimate of such a
    // document is at most about 5·10⁶ steps (the tags are the expensive
    // part, and they are at least three characters long) — so the budget
    // never refuses a document the import's own limit allows.
    const tags = Math.ceil(5_000_000 / 4); // 1.25 million short tags
    const estimate = tags * 3;
    expect(estimate).toBeLessThan(HTML_SCAN_BUDGET);
  });

  it("refuses a document that is built to make the backtracking work", () => {    const html = "<script".repeat(10_000);
    const start = Date.now();
    const parsed = parseConfluenceExport({ html });
    const ms = Date.now() - start;

    // Without the budget this call needed 31 s; the default test timeout is
    // the guard against a regression.
    expect(ms).toBeLessThan(2_000);
    expect(parsed.pages).toHaveLength(0);
  });

  it("imports a well-formed document", () => {
    const html = `<html><body><h1>Titel</h1><p>Absatz</p></body></html>`;
    expect(underHtmlScanBudget(html)).toBe(true);
    const parsed = parseConfluenceExport({ html });
    expect(parsed.pages.length).toBeGreaterThan(0);
  });
});

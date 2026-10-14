import { describe, expect, it } from "vitest";
import {
  applyBreakRules,
  BLOCK_SPACING,
  CHARS_PER_LINE,
  CODE_LINE_HEIGHT,
  DEFAULT_MARGIN_TOP,
  DEFAULT_PAGE_HEIGHT,
  estimateBlockHeight,
  LINE_HEIGHT,
  pageContentHeight,
  paginateBlocks,
  type BlockHeightInput,
  type PrintBlock,
} from "./print-layout";

/**
 * Red-first suite for print / PDF layout pagination (`src/lib/print-layout.ts`).
 *
 * The module owns the pure half of "Export PDF" (docs/specs/import-export.md;
 * FEATURE_MATRIX "Export PDF"): given measured blocks it decides page breaks
 * and block offsets without touching pdfkit, React or the DB.
 *
 * Three things are pinned here:
 *   1. `estimateBlockHeight` — the deterministic height model that feeds the
 *      measurement step;
 *   2. `applyBreakRules` — the keep-together policy (a heading stays with its
 *      following block; a list/quote is never orphaned from its lead-in);
 *   3. `paginateBlocks` — greedy flow that honours those rules, gives an
 *      over-tall block its own page, and resets `y` per page.
 */

const block = (id: string, type: string, height: number): PrintBlock => ({ id, type, height });

/** A fresh options object for every call — the functions never mutate it. */
const opts = (pageHeight: number, marginTop: number) => ({ pageHeight, marginTop });

describe("pageContentHeight", () => {
  it("subtracts the top margin from the page height", () => {
    expect(pageContentHeight(opts(100, 10))).toBe(90);
    expect(pageContentHeight(opts(1056, 72))).toBe(984);
  });

  it("falls back to the defaults for missing or non-finite options", () => {
    expect(pageContentHeight()).toBe(DEFAULT_PAGE_HEIGHT - DEFAULT_MARGIN_TOP);
    expect(pageContentHeight({ pageHeight: Number.NaN, marginTop: Number.NaN })).toBe(
      DEFAULT_PAGE_HEIGHT - DEFAULT_MARGIN_TOP,
    );
  });

  it("clamps a negative margin to zero and never returns a negative box", () => {
    expect(pageContentHeight(opts(100, -20))).toBe(100);
    expect(pageContentHeight(opts(100, 150))).toBe(0);
  });
});

describe("estimateBlockHeight", () => {
  const est = (input: BlockHeightInput): number => estimateBlockHeight(input);

  it("sizes a one-line paragraph and grows with wrapping", () => {
    expect(est({ type: "paragraph", text: "Hello" })).toBe(LINE_HEIGHT + BLOCK_SPACING);
    expect(est({ type: "paragraph", text: "x".repeat(CHARS_PER_LINE + 1) })).toBe(
      2 * LINE_HEIGHT + BLOCK_SPACING,
    );
    expect(est({ type: "paragraph", text: "x".repeat(3 * CHARS_PER_LINE) })).toBe(
      3 * LINE_HEIGHT + BLOCK_SPACING,
    );
  });

  it("counts explicit newlines as separate lines", () => {
    expect(est({ type: "paragraph", text: "a\nb" })).toBe(2 * LINE_HEIGHT + BLOCK_SPACING);
  });

  it("ranks heading levels: h1 > h2 > h3+", () => {
    const h1 = est({ type: "heading", level: 1 });
    const h2 = est({ type: "heading", level: 2 });
    const h3 = est({ type: "heading", level: 3 });
    expect(h1).toBeGreaterThan(h2);
    expect(h2).toBeGreaterThan(h3);
  });

  it("scales lists and tables with their item/row count", () => {
    expect(est({ type: "bulletList", count: 3 })).toBe(3 * LINE_HEIGHT + BLOCK_SPACING);
    expect(est({ type: "orderedList", count: 5 })).toBe(5 * LINE_HEIGHT + BLOCK_SPACING);
    // A missing/garbage count degrades to a single item.
    expect(est({ type: "taskList", count: -2 })).toBe(LINE_HEIGHT + BLOCK_SPACING);
  });

  it("uses the tighter code line height for code blocks", () => {
    expect(est({ type: "codeBlock", text: "a\nb\nc" })).toBe(
      3 * CODE_LINE_HEIGHT + BLOCK_SPACING + 24,
    );
  });

  it("honours an explicit media height and defaults images", () => {
    expect(est({ type: "image", height: 100 })).toBe(100 + BLOCK_SPACING);
    expect(est({ type: "image" })).toBe(240 + BLOCK_SPACING);
  });

  it("keeps a divider minimal and treats unknown types as paragraphs", () => {
    expect(est({ type: "horizontalRule" })).toBe(8 + BLOCK_SPACING);
    expect(est({ type: "callout", text: "hi" })).toBe(LINE_HEIGHT + BLOCK_SPACING + 24);
    expect(est({ type: "mystery", text: "hi" })).toBe(LINE_HEIGHT + BLOCK_SPACING);
  });

  it("is deterministic for the same input", () => {
    const input: BlockHeightInput = { type: "paragraph", text: "same" };
    expect(estimateBlockHeight(input)).toBe(estimateBlockHeight(input));
  });
});

describe("applyBreakRules — keep-together policy", () => {
  it("keeps a heading with the block that follows it", () => {
    expect(applyBreakRules(block("h", "heading", 20), block("p", "paragraph", 20))).toBe(true);
  });

  it("allows a break between two ordinary paragraphs", () => {
    expect(applyBreakRules(block("a", "paragraph", 20), block("b", "paragraph", 20))).toBe(false);
  });

  it("never orphans a list from its lead-in", () => {
    for (const type of ["bulletList", "orderedList", "taskList"]) {
      expect(applyBreakRules(block("p", "paragraph", 20), block("l", type, 20))).toBe(true);
    }
  });

  it("never orphans a quote from its lead-in", () => {
    expect(applyBreakRules(block("p", "paragraph", 20), block("q", "blockquote", 20))).toBe(true);
  });

  it("does not pin a list/quote to whatever follows it", () => {
    expect(applyBreakRules(block("l", "bulletList", 20), block("p", "paragraph", 20))).toBe(false);
    expect(applyBreakRules(block("q", "blockquote", 20), block("p", "paragraph", 20))).toBe(false);
  });

  it("fails open (no keep-together) for missing or unknown blocks", () => {
    expect(applyBreakRules(undefined, block("p", "paragraph", 20))).toBe(false);
    expect(applyBreakRules(block("p", "paragraph", 20), null)).toBe(false);
    expect(applyBreakRules(block("x", "mystery", 20), block("y", "mystery", 20))).toBe(false);
  });
});

describe("paginateBlocks — flow across pages", () => {
  it("returns no pages for no blocks", () => {
    expect(paginateBlocks([], opts(100, 10))).toEqual([]);
  });

  it("packs a page until the content box is full, then breaks", () => {
    const pages = paginateBlocks(
      [block("a", "paragraph", 40), block("b", "paragraph", 40), block("c", "paragraph", 40)],
      opts(100, 10), // content box = 90
    );
    expect(pages).toHaveLength(2);
    expect(pages[0].blocks.map((p) => p.id)).toEqual(["a", "b"]);
    expect(pages[0].used).toBe(80);
    expect(pages[0].remaining).toBe(10);
    expect(pages[1].blocks.map((p) => p.id)).toEqual(["c"]);
    expect(pages[1].used).toBe(40);
  });

  it("resets each block's y offset on a new page and preserves order", () => {
    const pages = paginateBlocks(
      [block("a", "paragraph", 50), block("b", "paragraph", 50), block("c", "paragraph", 50)],
      opts(100, 10),
    );
    expect(pages.map((page) => page.index)).toEqual([0, 1, 2]);
    expect(pages.map((page) => page.blocks.map((p) => p.y))).toEqual([[0], [0], [0]]);
    expect(pages.flatMap((page) => page.blocks.map((p) => p.id))).toEqual(["a", "b", "c"]);
  });

  it("records the content box on every page", () => {
    const pages = paginateBlocks([block("a", "paragraph", 10)], opts(100, 10));
    expect(pages[0].contentHeight).toBe(90);
  });

  it("moves a heading with its following block instead of orphaning it", () => {
    const pages = paginateBlocks(
      [
        block("f", "paragraph", 70),
        block("h", "heading", 15),
        block("p", "paragraph", 15),
      ],
      opts(100, 10), // 70 fits, but 70 + 15 + 15 = 100 > 90
    );
    // Without the rule the heading would end page 0 alone; instead the pair moves.
    expect(pages[0].blocks.map((p) => p.id)).toEqual(["f"]);
    expect(pages[1].blocks.map((p) => p.id)).toEqual(["h", "p"]);
    expect(pages[1].blocks.map((p) => p.y)).toEqual([0, 15]);
  });

  it("moves a list with its lead-in paragraph instead of orphaning it", () => {
    const pages = paginateBlocks(
      [block("f", "paragraph", 60), block("p", "paragraph", 20), block("l", "bulletList", 15)],
      opts(100, 10), // p alone fits after f, but the list would be left behind
    );
    expect(pages[0].blocks.map((p) => p.id)).toEqual(["f"]);
    expect(pages[1].blocks.map((p) => p.id)).toEqual(["p", "l"]);
  });

  it("gives an over-tall block its own page, never sharing it", () => {
    const pages = paginateBlocks(
      [block("a", "paragraph", 40), block("big", "image", 120), block("c", "paragraph", 40)],
      opts(100, 10), // content box = 90 < 120
    );
    expect(pages).toHaveLength(3);
    expect(pages[1].blocks.map((p) => p.id)).toEqual(["big"]);
    expect(pages[1].blocks[0].oversized).toBe(true);
    expect(pages[1].blocks[0].y).toBe(0);
    expect(pages[1].remaining).toBe(0);
    expect(pages[0].blocks.map((p) => p.id)).toEqual(["a"]);
    expect(pages[2].blocks.map((p) => p.id)).toEqual(["c"]);
  });

  it("gives an over-tall first block its own page", () => {
    const pages = paginateBlocks(
      [block("big", "image", 200), block("a", "paragraph", 40)],
      opts(100, 10),
    );
    expect(pages.map((page) => page.blocks.map((p) => p.id))).toEqual([["big"], ["a"]]);
  });

  it("normalises garbage heights to zero rather than throwing", () => {
    const pages = paginateBlocks(
      [
        block("x", "paragraph", -5),
        block("y", "paragraph", Number.NaN),
        block("z", "paragraph", Number.POSITIVE_INFINITY),
      ],
      opts(100, 10),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].blocks.map((p) => p.height)).toEqual([0, 0, 0]);
    expect(pages[0].used).toBe(0);
  });

  it("treats a non-positive content box as one page per block", () => {
    const pages = paginateBlocks(
      [block("a", "paragraph", 10), block("b", "paragraph", 10)],
      opts(100, 150),
    );
    expect(pages.map((page) => page.blocks.map((p) => p.id))).toEqual([["a"], ["b"]]);
  });

  it("is deterministic across repeated calls", () => {
    const blocks = [block("a", "heading", 20), block("b", "paragraph", 100)];
    const options = opts(100, 10);
    expect(paginateBlocks(blocks, options)).toEqual(paginateBlocks(blocks, options));
  });
});

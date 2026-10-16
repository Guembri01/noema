import { describe, expect, it } from "vitest";
import type { RichBlock } from "./markdown";
import {
  BLOCK_SPACING,
  buildPrintPlan,
  CALLOUT_PADDING,
  CODE_LINE_HEIGHT,
  CODE_PADDING,
  collectAssets,
  estimateBlockHeight,
  exportFilename,
  LANDSCAPE_MIN_COLUMNS,
  LINE_HEIGHT,
  printStyles,
  QUOTE_PADDING,
  ROW_HEIGHT,
  tableToPrintGrid,
  toMarkdownFidelity,
  type PrintDoc,
} from "./pdf-export";

/**
 * Red-first suite for the PDF export planning engine (`src/lib/pdf-export.ts`).
 *
 * `pdf-export.ts` is the pure, headless-browser-free half of "Export PDF"
 * (docs/specs/import-export.md §12) plus the nested-content fidelity report
 * that guards "Export Markdown". Given editor blocks it decides page breaks,
 * estimates block heights, builds the print plan, emits print CSS, derives a
 * download filename, lists the assets a renderer must embed, and reports the
 * nested features a Markdown export would flatten.
 *
 * Everything under test is pure and deterministic: no pdfkit, no React, no DB.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const para = (text: string): RichBlock => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const heading = (level: number, text: string): RichBlock => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const code = (text: string): RichBlock => ({
  type: "codeBlock",
  content: [{ type: "text", text }],
});
const table = (rows: string[][], header = true): RichBlock => ({
  type: "table",
  content: rows.map((cells, rowIndex) => ({
    type: "tableRow",
    content: cells.map((cell) => ({
      type: header && rowIndex === 0 ? "tableHeader" : "tableCell",
      content: [para(cell)],
    })),
  })),
});
const doc = (blocks: RichBlock[], title = "Page"): PrintDoc => ({ title, blocks });

/** A short page: letter 816x1056 with a 900px top + 12px bottom inset. */
const SHORT_PAGE = {
  pageSize: "letter" as const,
  margins: { top: 900, bottom: 12, left: 0, right: 0 },
};
/** Content box of SHORT_PAGE: 144px tall, 816px wide. */
const SHORT_CONTENT_HEIGHT = 144;
const SHORT_CHARS_PER_LINE = Math.floor(816 / 8);

const NOW = new Date("2026-10-15T13:45:30Z");
const STAMP = "20261015-134530";

// ---------------------------------------------------------------------------
// estimateBlockHeight
// ---------------------------------------------------------------------------

describe("estimateBlockHeight", () => {
  it("sizes a one-line paragraph as one line plus spacing", () => {
    expect(estimateBlockHeight(para("Hello"))).toBe(LINE_HEIGHT + BLOCK_SPACING);
  });

  it("wraps long text: a narrower width produces a taller block", () => {
    const block = para("x".repeat(200));
    const wide = estimateBlockHeight(block, { widthPx: 650 });
    const narrow = estimateBlockHeight(block, { widthPx: 200 });
    expect(narrow).toBeGreaterThan(wide);
  });

  it("counts explicit newlines as separate lines", () => {
    expect(estimateBlockHeight(para("a\nb"))).toBe(2 * LINE_HEIGHT + BLOCK_SPACING);
  });

  it("uses the tighter code line height, with no soft wrapping", () => {
    expect(estimateBlockHeight(code("a\nb"))).toBe(
      2 * CODE_LINE_HEIGHT + CODE_PADDING + BLOCK_SPACING,
    );
    // A very long code line is a single, unwrapped line.
    expect(estimateBlockHeight(code("x".repeat(5000)))).toBe(
      CODE_LINE_HEIGHT + CODE_PADDING + BLOCK_SPACING,
    );
  });

  it("ranks heading levels h1 > h2 > h3+", () => {
    const h1 = estimateBlockHeight(heading(1, "A"));
    const h2 = estimateBlockHeight(heading(2, "A"));
    const h3 = estimateBlockHeight(heading(3, "A"));
    expect(h1).toBeGreaterThan(h2);
    expect(h2).toBeGreaterThan(h3);
  });

  it("scales tables with their row count", () => {
    expect(estimateBlockHeight(table([["a"], ["b"], ["c"]]))).toBe(
      3 * ROW_HEIGHT + BLOCK_SPACING,
    );
  });

  it("honours an explicit image height and defaults a missing one", () => {
    expect(estimateBlockHeight({ type: "image", attrs: { height: 100 } })).toBe(
      100 + BLOCK_SPACING,
    );
    expect(estimateBlockHeight({ type: "image" })).toBe(240 + BLOCK_SPACING);
  });

  it("pads callouts and quotes like paragraphs plus their padding", () => {
    expect(estimateBlockHeight({ type: "callout", content: [{ type: "text", text: "hi" }] })).toBe(
      LINE_HEIGHT + CALLOUT_PADDING + BLOCK_SPACING,
    );
    expect(
      estimateBlockHeight({ type: "blockquote", content: [{ type: "text", text: "hi" }] }),
    ).toBe(LINE_HEIGHT + QUOTE_PADDING + BLOCK_SPACING);
  });

  it("sizes a columns block by its tallest column, not the sum of columns", () => {
    const column = (n: number): RichBlock => ({
      type: "column",
      content: Array.from({ length: n }, () => para("one line")),
    });
    const columns: RichBlock = { type: "columns", content: [column(3), column(1)] };
    const tall = estimateBlockHeight(columns);
    // Tallest column: 3 paragraphs, plus the block's own spacing.
    expect(tall).toBe(3 * (LINE_HEIGHT + BLOCK_SPACING) + BLOCK_SPACING);
    // Stacked instead of side-by-side it would be twice as tall.
    expect(tall).toBeLessThan(6 * (LINE_HEIGHT + BLOCK_SPACING));
  });

  it("degrades malformed input to a single-line paragraph instead of throwing", () => {
    expect(estimateBlockHeight(null)).toBe(LINE_HEIGHT + BLOCK_SPACING);
    expect(estimateBlockHeight({ type: "mystery", text: "hi" })).toBe(
      LINE_HEIGHT + BLOCK_SPACING,
    );
  });
});

// ---------------------------------------------------------------------------
// tableToPrintGrid
// ---------------------------------------------------------------------------

describe("tableToPrintGrid", () => {
  it("extracts a rectangular grid with header row count", () => {
    const grid = tableToPrintGrid(table([["H1", "H2"], ["a", "b"]]));
    expect(grid.rows).toEqual([["H1", "H2"], ["a", "b"]]);
    expect(grid.columns).toBe(2);
    expect(grid.headerRows).toBe(1);
  });

  it("normalises ragged rows to the widest row", () => {
    const grid = tableToPrintGrid(table([["a"], ["b", "c", "d"]], false));
    expect(grid.columns).toBe(3);
    expect(grid.rows).toEqual([["a", "", ""], ["b", "c", "d"]]);
    expect(grid.headerRows).toBe(0);
  });

  it("flattens a multi-paragraph cell to newline-joined text", () => {
    const cell: RichBlock = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [para("first"), para("second")],
            },
          ],
        },
      ],
    };
    expect(tableToPrintGrid(cell).rows).toEqual([["first\nsecond"]]);
  });

  it("returns an empty grid for a missing or malformed table", () => {
    expect(tableToPrintGrid(null)).toEqual({ rows: [], columns: 0, headerRows: 0 });
    expect(tableToPrintGrid({ type: "table", content: [] })).toEqual({
      rows: [],
      columns: 0,
      headerRows: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// buildPrintPlan — pagination
// ---------------------------------------------------------------------------

describe("buildPrintPlan — shape and determinism", () => {
  it("returns no pages for an empty document", () => {
    const plan = buildPrintPlan(doc([]));
    expect(plan.pages).toEqual([]);
    expect(plan.meta.pageCount).toBe(0);
    expect(plan.meta.blockCount).toBe(0);
  });

  it("places a short document on a single page", () => {
    const plan = buildPrintPlan(doc([para("Hello")]));
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].blocks).toHaveLength(1);
    expect(plan.pages[0].estimatedHeight).toBe(LINE_HEIGHT + BLOCK_SPACING);
  });

  it("is deterministic for the same input", () => {
    const input = doc([heading(1, "Title"), para("body"), table([["a", "b"]])]);
    const first = JSON.stringify(buildPrintPlan(input));
    const second = JSON.stringify(buildPrintPlan(input));
    expect(first).toBe(second);
  });

  it("preserves block order across page breaks", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => para(`p${i}`.padEnd(205, "x")));
    const plan = buildPrintPlan(doc(blocks), SHORT_PAGE);
    const flattened = plan.pages
      .flatMap((page) => page.blocks)
      .map((p) => p.block.content?.[0]?.text ?? "");
    expect(flattened).toEqual(blocks.map((_, i) => `p${i}`.padEnd(205, "x")));
    expect(plan.meta.blockCount).toBe(6);
  });

  it("reports geometry and margins on meta", () => {
    expect(buildPrintPlan(doc([]), { pageSize: "letter" }).meta.width).toBe(816);
    expect(buildPrintPlan(doc([])).meta.width).toBe(794);
    const plan = buildPrintPlan(doc([]), { margins: 40 });
    expect(plan.meta.contentWidth).toBe(794 - 80);
    expect(plan.meta.margins).toEqual({ top: 40, right: 40, bottom: 40, left: 40 });
  });
});

describe("buildPrintPlan — keep-with-next", () => {
  it("moves a heading with the block that follows when the pair does not fit", () => {
    // 3-line paragraph takes 84px of the 144px box; heading(52) fits the
    // remaining 60px but heading(52) + para(36) does not, so the pair moves.
    const blocks = [
      para("x".repeat(3 * SHORT_CHARS_PER_LINE)),
      heading(1, "Title"),
      para("y"),
    ];
    const plan = buildPrintPlan(doc(blocks), SHORT_PAGE);
    expect(plan.pages).toHaveLength(2);
    expect(plan.pages[0].blocks.map((p) => p.type)).toEqual(["paragraph"]);
    expect(plan.pages[1].blocks.map((p) => p.type)).toEqual(["heading", "paragraph"]);
  });

  it("keeps a heading on the same page as its following block when it fits", () => {
    const plan = buildPrintPlan(doc([heading(2, "Title"), para("body")]), SHORT_PAGE);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].blocks.map((p) => p.type)).toEqual(["heading", "paragraph"]);
  });
});

describe("buildPrintPlan — code blocks", () => {
  it("never splits a code block that fits one page", () => {
    // p1 leaves 108px; the 126px code block does not fit there but is under
    // the 144px box, so it moves whole to page 2 instead of being split.
    const plan = buildPrintPlan(doc([para("intro"), code("a\nb\nc\nd\ne")]), SHORT_PAGE);
    expect(plan.pages).toHaveLength(2);
    const codeBlocks = plan.pages.flatMap((page) => page.blocks).filter((p) => p.type === "codeBlock");
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].part).toBeUndefined();
  });

  it("splits a code block that is taller than a page into contiguous parts", () => {
    const lines = Array.from({ length: 13 }, (_, i) => `line ${i}`);
    const plan = buildPrintPlan(doc([code(lines.join("\n"))]), SHORT_PAGE);
    const parts = plan.pages.flatMap((page) => page.blocks).filter((p) => p.type === "codeBlock");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.part)).toEqual(parts.map((_, i) => i));
    const reconstructed = plan.pages
      .flatMap((page) => page.blocks)
      .filter((p) => p.type === "codeBlock")
      .map((p) => (p.block.content?.[0]?.text ?? ""))
      .join("\n");
    expect(reconstructed).toBe(lines.join("\n"));
  });
});

describe("buildPrintPlan — landscape tables", () => {
  const wideTable = table([
    Array.from({ length: LANDSCAPE_MIN_COLUMNS }, (_, i) => `col${i}`),
    Array.from({ length: LANDSCAPE_MIN_COLUMNS }, (_, i) => `v${i}`),
  ]);

  it("widens a page for a wide table", () => {
    const plan = buildPrintPlan(doc([para("before"), wideTable]));
    expect(plan.pages).toHaveLength(2);
    const wide = plan.pages[1];
    expect(wide.orientation).toBe("landscape");
    expect(wide.width).toBeGreaterThan(wide.height);
    expect(wide.contentWidth).toBe(1123 - 144);
  });

  it("keeps a narrow table on a portrait page", () => {
    const plan = buildPrintPlan(doc([table([["a", "b", "c"], ["1", "2", "3"]])]));
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].orientation).toBe("portrait");
    expect(plan.pages[0].width).toBeLessThan(plan.pages[0].height);
  });
});

describe("buildPrintPlan — table of contents and meta", () => {
  it("prepends a TOC page and reports heading locations", () => {
    const plan = buildPrintPlan(
      doc([heading(1, "Intro"), para("body"), heading(2, "Detail")]),
      { includeToc: true },
    );
    expect(plan.pages).toHaveLength(2);
    expect(plan.pages[0].blocks[0].type).toBe("toc");
    expect(plan.meta.toc).toEqual([
      { level: 1, text: "Intro", pageIndex: 1 },
      { level: 2, text: "Detail", pageIndex: 1 },
    ]);
    expect(plan.meta.includeToc).toBe(true);
    expect(plan.meta.pageCount).toBe(2);
  });

  it("omits the TOC page when there are no headings", () => {
    const plan = buildPrintPlan(doc([para("body")]), { includeToc: true });
    expect(plan.pages).toHaveLength(1);
    expect(plan.meta.toc).toEqual([]);
  });

  it("records the page-number option on meta", () => {
    expect(buildPrintPlan(doc([para("x")]), { includePageNumbers: true }).meta.includePageNumbers).toBe(
      true,
    );
    expect(buildPrintPlan(doc([para("x")])).meta.includePageNumbers).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// printStyles
// ---------------------------------------------------------------------------

describe("printStyles", () => {
  it("emits an A4 portrait @page rule with default margins", () => {
    const css = printStyles();
    expect(css).toContain("@page");
    expect(css).toContain("size: A4 portrait");
    expect(css).toContain("margin: 72px");
    expect(css).toContain("border-collapse: collapse");
  });

  it("honours page size, margins and orientation", () => {
    const css = printStyles({ pageSize: "letter", margins: 40, orientation: "landscape" });
    expect(css).toContain("size: Letter landscape");
    expect(css).toContain("margin: 40px");
  });

  it("includes the page-number rule only when asked", () => {
    expect(printStyles({ includePageNumbers: true })).toContain(".print-page-number");
    expect(printStyles({ includePageNumbers: false })).not.toContain(".print-page-number");
  });
});

// ---------------------------------------------------------------------------
// exportFilename
// ---------------------------------------------------------------------------

describe("exportFilename", () => {
  it("slugifies the title and stamps the time", () => {
    expect(exportFilename("My Page Title", { ext: "pdf", now: NOW })).toBe(
      `my-page-title-${STAMP}.pdf`,
    );
  });

  it("falls back to `untitled` for an empty or blank title", () => {
    expect(exportFilename("", { now: NOW })).toBe(`untitled-${STAMP}.pdf`);
    expect(exportFilename("   ", { now: NOW })).toBe(`untitled-${STAMP}.pdf`);
    expect(exportFilename(null, { now: NOW })).toBe(`untitled-${STAMP}.pdf`);
  });

  it("strips diacritics and collapses punctuation runs", () => {
    expect(exportFilename("Café — Déjà Vu", { now: NOW })).toBe(`cafe-deja-vu-${STAMP}.pdf`);
    expect(exportFilename("Hello,   World!!!", { now: NOW })).toBe(`hello-world-${STAMP}.pdf`);
  });

  it("keeps non-Latin letters instead of discarding them", () => {
    expect(exportFilename("Привет мир", { now: NOW })).toBe(`привет-мир-${STAMP}.pdf`);
  });

  it("trims leading/trailing separators", () => {
    expect(exportFilename("-foo-", { now: NOW })).toBe(`foo-${STAMP}.pdf`);
  });

  it("normalises the extension", () => {
    expect(exportFilename("Doc", { ext: ".md", now: NOW })).toBe(`doc-${STAMP}.md`);
    expect(exportFilename("Doc", { ext: "HTM!", now: NOW })).toBe(`doc-${STAMP}.htm`);
    expect(exportFilename("Doc", { ext: "  ", now: NOW })).toBe(`doc-${STAMP}.pdf`);
  });

  it("caps a very long slug without a trailing separator", () => {
    const name = exportFilename("Word ".repeat(40), { now: NOW });
    const slug = name.replace(new RegExp(`-${STAMP}\\.pdf$`), "");
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).not.toMatch(/-$/);
  });
});

// ---------------------------------------------------------------------------
// collectAssets
// ---------------------------------------------------------------------------

describe("collectAssets", () => {
  it("lists unique image sources with their alt text, in document order", () => {
    const blocks: RichBlock[] = [
      { type: "image", attrs: { src: "/api/files/w/a.png", alt: "A" } },
      {
        type: "columns",
        content: [
          {
            type: "column",
            content: [
              { type: "image", attrs: { src: "/api/files/w/b.png", alt: "B" } },
              { type: "image", attrs: { src: "/api/files/w/a.png", alt: "dup" } },
            ],
          },
        ],
      },
    ];
    const assets = collectAssets(doc(blocks));
    expect(assets.images).toEqual([
      { src: "/api/files/w/a.png", alt: "A", kind: "image" },
      { src: "/api/files/w/b.png", alt: "B", kind: "image" },
    ]);
    expect(assets.count).toBe(2);
  });

  it("collects font families referenced by blocks and marks", () => {
    const blocks: RichBlock[] = [
      { type: "paragraph", attrs: { fontFamily: "Georgia" }, content: [{ type: "text", text: "x" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "y", marks: [{ type: "textStyle", attrs: { fontFamily: "Courier" } }] },
        ],
      },
    ];
    expect(collectAssets(doc(blocks)).fonts).toEqual(["Courier", "Georgia"]);
  });

  it("returns nothing for an empty document", () => {
    expect(collectAssets(doc([]))).toEqual({ images: [], fonts: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// toMarkdownFidelity
// ---------------------------------------------------------------------------

describe("toMarkdownFidelity", () => {
  it("reports a flattened columns layout", () => {
    const report = toMarkdownFidelity(
      doc([{ type: "columns", content: [{ type: "column", content: [para("a")] }] }]),
    );
    expect(report.warnings.map((w) => w.code)).toContain("COLUMNS");
    expect(report.lossless).toBe(false);
  });

  it("reports block content nested inside a table cell", () => {
    const nested: RichBlock = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                para("cell"),
                { type: "bulletList", content: [{ type: "listItem", content: [para("item")] }] },
              ],
            },
          ],
        },
      ],
    };
    const report = toMarkdownFidelity(doc([nested]));
    expect(report.warnings.map((w) => w.code)).toContain("TABLE_NESTED");
  });

  it("reports embeds and page embeds that degrade to links", () => {
    const report = toMarkdownFidelity(
      doc([
        { type: "embed", attrs: { url: "https://example.com" } },
        { type: "pageEmbed", attrs: { title: "Other page" } },
      ]),
    );
    const codes = report.warnings.map((w) => w.code);
    expect(codes).toContain("EMBED");
    expect(codes).toContain("PAGE_EMBED");
  });

  it("is lossless for plain text, headings and simple tables", () => {
    const report = toMarkdownFidelity(
      doc([heading(1, "Title"), para("body"), table([["h1", "h2"], ["a", "b"]])]),
    );
    expect(report.warnings).toEqual([]);
    expect(report.lossless).toBe(true);
  });
});

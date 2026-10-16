import { describe, expect, it } from "vitest";
import {
  HEADER_FOOTER_RATIO,
  assembleDoc,
  columnAwareOrder,
  describeImport,
  detectHeadings,
  pagesToBlocks,
  parsePdfPages,
  type PdfBlock,
  type PdfLine,
  type PdfWarning,
} from "./pdf-import";

/**
 * PDF text-layer import engine (docs/FEATURE_MATRIX.md §12 "Import PDF —
 * text-layer only first"; docs/specs/import-export.md).
 *
 * Red-first: the engine operates on text/lines an upstream extractor already
 * produced (`{ pageNumber, text, lines? }`). There is no binary parsing and no
 * third-party dependency here — only pure, deterministic structure recovery:
 * normalisation, running header/footer + page-number stripping, hyphen joins,
 * heading inference, two-column reordering, block assembly and a summary.
 */

/** Build a normalised line with optional layout hints. */
const line = (text: string, extra: Partial<PdfLine> = {}): PdfLine => ({ text, ...extra });

/** Non-empty line texts of a page, in order. */
const texts = (lines: readonly PdfLine[]): string[] =>
  lines.map((l) => l.text).filter((t) => t !== "");

const codes = (warnings: readonly PdfWarning[]): string[] => warnings.map((w) => w.code);

/** A page whose only repeated line is a running header. */
const headerPage = (word: string): string[] => [`ACME Confidential`, `Body ${word}`];

describe("parsePdfPages — normalisation", () => {
  it("pins the header/footer repeat ratio at 60%", () => {
    expect(HEADER_FOOTER_RATIO).toBe(0.6);
  });

  it("numbers pages from the input, defaulting to the 1-based index", () => {
    const { pages } = parsePdfPages([{ text: "a" }, { text: "b", pageNumber: 5 }]);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 5]);
  });

  it("splits `text` into lines when `lines` is absent", () => {
    const { pages } = parsePdfPages([{ pageNumber: 1, text: "one\ntwo\nthree" }]);
    expect(texts(pages[0].lines)).toEqual(["one", "two", "three"]);
  });

  it("accepts a plain string array for `lines`", () => {
    const { pages } = parsePdfPages([{ pageNumber: 1, lines: ["alpha", "beta"] }]);
    expect(texts(pages[0].lines)).toEqual(["alpha", "beta"]);
  });

  it("preserves x/size/font layout hints", () => {
    const { pages } = parsePdfPages([
      { pageNumber: 1, lines: [line("hinted", { x: 42, size: 11, font: "Arial" })] },
    ]);
    expect(pages[0].lines[0]).toMatchObject({ text: "hinted", x: 42, size: 11, font: "Arial" });
  });

  it("trims trailing whitespace but keeps blank lines as paragraph separators", () => {
    const { pages } = parsePdfPages([
      { pageNumber: 1, text: "first   \n\nsecond  " },
    ]);
    expect(pages[0].lines.map((l) => l.text)).toEqual(["first", "", "second"]);
  });
});

describe("parsePdfPages — hyphen joins", () => {
  it("joins a line break after a lowercase hyphen", () => {
    const { pages } = parsePdfPages([{ pageNumber: 1, text: "inter-\nnational law" }]);
    expect(texts(pages[0].lines)).toEqual(["international law"]);
  });

  it("does not join when the continuation is capitalised", () => {
    const { pages } = parsePdfPages([{ pageNumber: 1, text: "pre-\nExisting state" }]);
    expect(texts(pages[0].lines)).toEqual(["pre-", "Existing state"]);
  });

  it("does not join a line that does not end in a hyphen", () => {
    const { pages } = parsePdfPages([{ pageNumber: 1, text: "well\nknown" }]);
    expect(texts(pages[0].lines)).toEqual(["well", "known"]);
  });

  it("joins hyphenation chains across several lines", () => {
    const { pages } = parsePdfPages([{ pageNumber: 1, text: "hy-\nphen-\nation" }]);
    expect(texts(pages[0].lines)).toEqual(["hyphenation"]);
  });
});

describe("parsePdfPages — page numbers", () => {
  it("strips bare, decorated and 'Page N of M' numbering", () => {
    const { pages, warnings } = parsePdfPages([
      {
        pageNumber: 1,
        lines: ["1", "The start", "12", "Page 3", "- 4 -", "3 / 10", "body text"],
      },
    ]);
    expect(texts(pages[0].lines)).toEqual(["The start", "body text"]);
    expect(codes(warnings)).toContain("PAGE_NUMBER_STRIPPED");
  });

  it("keeps short lines that are not page numbers", () => {
    const { pages } = parsePdfPages([
      { pageNumber: 1, lines: ["Fig 3", "See appendix"] },
    ]);
    expect(texts(pages[0].lines)).toEqual(["Fig 3", "See appendix"]);
  });
});

describe("parsePdfPages — running headers/footers", () => {
  it("strips a header that repeats on every page", () => {
    const input = ["a", "b", "c", "d", "e"].map((w, i) => ({
      pageNumber: i + 1,
      lines: headerPage(w),
    }));
    const { pages, warnings } = parsePdfPages(input);
    for (const page of pages) expect(texts(page.lines)).not.toContain("ACME Confidential");
    expect(codes(warnings)).toContain("RUNNING_HEADER_STRIPPED");
  });

  it("strips a footer that repeats above the ratio", () => {
    const input = ["alpha", "bravo", "charlie", "delta"].map((w, i) => ({
      pageNumber: i + 1,
      lines: [`Body ${w}`, "© 2024 ACME"],
    }));
    const { pages, warnings } = parsePdfPages(input);
    for (const page of pages) expect(texts(page.lines)).not.toContain("© 2024 ACME");
    expect(codes(warnings)).toContain("RUNNING_FOOTER_STRIPPED");
  });

  it("normalises digits so 'Page 1', 'Page 2' … match as one header", () => {
    const input = ["alpha", "bravo", "charlie", "delta"].map((w, i) => ({
      pageNumber: i + 1,
      lines: [`Page ${i + 1}`, `Body ${w}`],
    }));
    const { pages } = parsePdfPages(input);
    for (const page of pages) expect(texts(page.lines).some((t) => /^Page /.test(t))).toBe(false);
  });

  it("keeps a header that only appears on a minority of pages", () => {
    const input = [
      { pageNumber: 1, lines: ["Chapter opener", "Body alpha"] },
      { pageNumber: 2, lines: ["Body bravo", "More bravo"] },
      { pageNumber: 3, lines: ["Body charlie", "More charlie"] },
    ];
    const { pages, warnings } = parsePdfPages(input);
    expect(texts(pages[0].lines)).toContain("Chapter opener");
    expect(codes(warnings)).not.toContain("RUNNING_HEADER_STRIPPED");
  });

  it("warns that a page produced no text", () => {
    const { warnings } = parsePdfPages([{ pageNumber: 1, lines: ["", "   "] }]);
    expect(codes(warnings)).toContain("EMPTY_PAGE");
  });
});

describe("detectHeadings", () => {
  it("ranks larger font sizes as heading levels", () => {
    const levels = detectHeadings([
      line("Title", { size: 24 }),
      line("Subtitle", { size: 18 }),
      line("Body text here", { size: 12 }),
      line("More body", { size: 12 }),
    ]);
    expect(levels).toEqual([1, 2, 0, 0]);
  });

  it("infers levels from hierarchical numbering patterns", () => {
    const levels = detectHeadings([
      line("1. Introduction"),
      line("1.1 Scope"),
      line("2.3.1 Detail"),
      line("1.4.5.6 Too deep is clamped"),
    ]);
    expect(levels).toEqual([1, 2, 3, 3]);
  });

  it("treats a consecutive numbered run as a list, not headings", () => {
    expect(detectHeadings([line("1. First item"), line("2. Second item")])).toEqual([0, 0]);
  });

  it("never mistakes bullets for headings", () => {
    expect(detectHeadings([line("• One"), line("- Two")])).toEqual([0, 0]);
  });

  it("falls back to a short bold line as a level-3 heading", () => {
    expect(
      detectHeadings([
        line("Overview", { font: "Helvetica-Bold" }),
        line("Body text here.", { font: "Helvetica" }),
      ]),
    ).toEqual([3, 0]);
  });

  it("returns level 0 for blank lines", () => {
    expect(detectHeadings([line("")])).toEqual([0]);
  });
});

describe("pagesToBlocks", () => {
  const page = (lines: PdfLine[], pageNumber = 1) => ({ pageNumber, lines });

  it("emits headings and merges body lines into one paragraph", () => {
    const blocks = pagesToBlocks([
      page([line("Big Title", { size: 20 }), line("Body one.", { size: 10 }), line("Body two.", { size: 10 })]),
    ]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1, text: "Big Title" });
    expect(blocks[1]).toMatchObject({ type: "paragraph", text: "Body one. Body two." });
  });

  it("splits paragraphs on blank lines", () => {
    const blocks = pagesToBlocks([page([line("First part."), line(""), line("Second part.")])]);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("emits unordered list items for bullet runs", () => {
    const blocks = pagesToBlocks([page([line("• Apples"), line("• Bananas")])]);
    expect(blocks).toEqual([
      expect.objectContaining({ type: "listItem", ordered: false, text: "Apples" }),
      expect.objectContaining({ type: "listItem", ordered: false, text: "Bananas" }),
    ]);
  });

  it("emits ordered list items for numbered runs", () => {
    const blocks = pagesToBlocks([page([line("1. First"), line("2. Second")])]);
    expect(blocks.every((b) => b.type === "listItem" && b.ordered)).toBe(true);
  });

  it("groups monospace runs into a code block", () => {
    const blocks = pagesToBlocks([
      page([line("const a = 1;", { font: "Courier" }), line("const b = 2;", { font: "Courier" })]),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "code", text: "const a = 1;\nconst b = 2;" });
  });

  it("detects a table-ish run of aligned columns", () => {
    const blocks = pagesToBlocks([page([line("Name    Age"), line("Ada     36")])]);
    expect(blocks[0]).toMatchObject({
      type: "table",
      rows: [
        ["Name", "Age"],
        ["Ada", "36"],
      ],
    });
  });

  it("scores every block within [0, 1]", () => {
    const blocks = pagesToBlocks([
      page([line("Title", { size: 20 }), line("• item"), line("body text")]),
    ]);
    for (const block of blocks) {
      expect(block.confidence).toBeGreaterThanOrEqual(0);
      expect(block.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("columnAwareOrder", () => {
  it("is the identity when no x hints exist", () => {
    const lines = [line("a"), line("b"), line("c")];
    expect(columnAwareOrder(lines)).toEqual(lines);
  });

  it("is the identity for a single column even when x varies a little", () => {
    const lines = [line("a", { x: 0 }), line("b", { x: 2 }), line("c", { x: 1 })];
    expect(columnAwareOrder(lines).map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("reorders a two-column page left-then-right, stable within columns", () => {
    const lines = [line("L1", { x: 0 }), line("R1", { x: 300 }), line("L2", { x: 2 }), line("R2", { x: 302 })];
    expect(columnAwareOrder(lines).map((l) => l.text)).toEqual(["L1", "L2", "R1", "R2"]);
  });

  it("honours the threshold: a gap below it stays in reading order", () => {
    const lines = [line("L1", { x: 0 }), line("L2", { x: 1 }), line("R1", { x: 100 }), line("R2", { x: 101 })];
    expect(columnAwareOrder(lines, { threshold: 0.5 }).map((l) => l.text)).toEqual([
      "L1",
      "L2",
      "R1",
      "R2",
    ]);
    expect(columnAwareOrder(lines, { threshold: 0.99 })).toEqual(lines);
  });
});

describe("assembleDoc", () => {
  it("uses the first heading as the title", () => {
    const doc = assembleDoc([
      { pageNumber: 1, lines: [line("Report Title", { size: 20 }), line("Body text.", { size: 10 })] },
    ]);
    expect(doc.title).toBe("Report Title");
    expect(doc.blocks.some((b) => b.type === "heading")).toBe(true);
  });

  it("falls back to the first paragraph when there is no heading", () => {
    const doc = assembleDoc([{ pageNumber: 1, lines: [line("Just some body text.")] }]);
    expect(doc.title).toBe("Just some body text.");
  });

  it("truncates an over-long title and surfaces import warnings", () => {
    const long =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec";
    const doc = assembleDoc([{ pageNumber: 1, lines: [line(long)] }]);
    expect(doc.title.length).toBeLessThanOrEqual(81);
    expect(doc.title.endsWith("…")).toBe(true);
  });

  it("propagates header/footer warnings from parsing", () => {
    const input = ["a", "b", "c", "d", "e"].map((w, i) => ({
      pageNumber: i + 1,
      lines: headerPage(w),
    }));
    const doc = assembleDoc(input);
    expect(codes(doc.warnings)).toContain("RUNNING_HEADER_STRIPPED");
  });

  it("warns when no text could be recovered and defaults the title", () => {
    const doc = assembleDoc([{ pageNumber: 1, lines: ["", "  "] }]);
    expect(doc.title).toBe("Imported PDF");
    expect(codes(doc.warnings)).toContain("NO_TEXT");
  });

  it("warns on empty input", () => {
    const doc = assembleDoc([]);
    expect(doc).toMatchObject({ title: "Imported PDF", blocks: [] });
    expect(codes(doc.warnings)).toEqual(["NO_PAGES"]);
  });
});

describe("describeImport", () => {
  it("summarises block counts by type and warning count", () => {
    const blocks: PdfBlock[] = [
      { type: "heading", level: 1, text: "Title", confidence: 0.95 },
      { type: "paragraph", text: "two words", confidence: 0.9 },
      { type: "listItem", ordered: false, text: "item", confidence: 0.9 },
      { type: "code", text: "const x = 1;", confidence: 0.7 },
      { type: "table", rows: [["a", "b"], ["c", "d"]], confidence: 0.6 },
    ];
    const warnings: PdfWarning[] = [
      { code: "PAGE_NUMBER_STRIPPED", message: "…" },
      { code: "RUNNING_HEADER_STRIPPED", message: "…" },
    ];
    const summary = describeImport({ title: "Title", blocks, warnings });
    expect(summary).toMatchObject({
      title: "Title",
      blocks: 5,
      headings: 1,
      paragraphs: 1,
      lists: 1,
      code: 1,
      tables: 1,
      warnings: 2,
    });
    expect(summary.words).toBeGreaterThan(0);
  });
});

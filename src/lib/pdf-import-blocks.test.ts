import { describe, expect, it } from "vitest";
import { assembleDoc, describeImport, type PdfBlock } from "./pdf-import";
import { extractedTextToPages, pdfBlocksToRichNodes } from "./pdf-import-blocks";

/**
 * PDF text-layer import — the input ⇄ engine ⇄ editor-block mapping.
 *
 * `pdf-import.ts` is the pure engine; `pdf-import-blocks.ts` adapts extracted
 * text into its `PdfPageInput[]` and its `PdfBlock[]` out into the
 * TipTap/ProseMirror `RichNode[]` a page stores. These tests pin both adapters
 * and the end-to-end `extracted text → assembleDoc → RichNode[]` path the
 * sidebar preview and the server action rely on.
 */

const text = (node: { content?: Array<{ text?: string }> } | undefined): string | undefined =>
  node?.content?.[0]?.text;

describe("extractedTextToPages", () => {
  it("returns no pages for empty or whitespace-only input", () => {
    expect(extractedTextToPages("")).toEqual([]);
    expect(extractedTextToPages("   \n\t ")).toEqual([]);
  });

  it("treats text without a form feed as a single page", () => {
    const pages = extractedTextToPages("line one\nline two");
    expect(pages).toEqual([{ pageNumber: 1, text: "line one\nline two" }]);
  });

  it("splits pages on form feeds and numbers them from 1", () => {
    const pages = extractedTextToPages("page one\fpage two\fpage three");
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(pages.map((p) => p.text)).toEqual(["page one", "page two", "page three"]);
  });

  it("drops a trailing form feed instead of adding a phantom page", () => {
    const pages = extractedTextToPages("only page\f");
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toBe("only page");
  });

  it("keeps an interior blank page so the engine can warn about it", () => {
    const pages = extractedTextToPages("first\f\fthird");
    expect(pages).toHaveLength(3);
    expect(pages[1].text).toBe("");
  });

  it("normalises CRLF line endings", () => {
    expect(extractedTextToPages("a\r\nb")[0].text).toBe("a\nb");
  });
});

describe("pdfBlocksToRichNodes", () => {
  it("maps a heading with its level", () => {
    const nodes = pdfBlocksToRichNodes([
      { type: "heading", level: 2, text: "Scope", confidence: 0.9 },
    ]);
    expect(nodes).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Scope" }] },
    ]);
  });

  it("maps a paragraph with inline text", () => {
    const nodes = pdfBlocksToRichNodes([
      { type: "paragraph", text: "Hello world.", confidence: 0.9 },
    ]);
    expect(nodes).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Hello world." }] },
    ]);
  });

  it("groups consecutive unordered items into one bulletList", () => {
    const nodes = pdfBlocksToRichNodes([
      { type: "listItem", ordered: false, text: "one", confidence: 0.9 },
      { type: "listItem", ordered: false, text: "two", confidence: 0.9 },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "bulletList" });
    expect(nodes[0].content).toHaveLength(2);
    expect(nodes[0].content?.[0]).toEqual({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
    });
  });

  it("flushes the list when the ordering style changes", () => {
    const nodes = pdfBlocksToRichNodes([
      { type: "listItem", ordered: false, text: "bullet", confidence: 0.9 },
      { type: "listItem", ordered: true, text: "step", confidence: 0.9 },
    ]);
    expect(nodes.map((node) => node.type)).toEqual(["bulletList", "orderedList"]);
  });

  it("maps a code block", () => {
    const nodes = pdfBlocksToRichNodes([
      { type: "code", text: "const x = 1;\nreturn x;", confidence: 0.7 },
    ]);
    expect(nodes).toEqual([
      { type: "codeBlock", content: [{ type: "text", text: "const x = 1;\nreturn x;" }] },
    ]);
  });

  it("maps a table with a header row and body rows", () => {
    const nodes = pdfBlocksToRichNodes([
      { type: "table", rows: [["Name", "Role"], ["Ada", "Eng"]], confidence: 0.6 },
    ]);
    expect(nodes).toHaveLength(1);
    const table = nodes[0];
    expect(table.type).toBe("table");
    expect(table.content).toHaveLength(2);
    expect(table.content?.[0].content?.[0].type).toBe("tableHeader");
    expect(text(table.content?.[0].content?.[0].content?.[0])).toBe("Name");
    expect(table.content?.[1].content?.[0].type).toBe("tableCell");
    expect(text(table.content?.[1].content?.[1].content?.[0])).toBe("Eng");
  });

  it("skips a table block that carries no rows", () => {
    expect(pdfBlocksToRichNodes([{ type: "table", rows: [], confidence: 0.4 }])).toEqual([]);
  });
});

describe("extracted text → engine → editor blocks", () => {
  const page = [
    "1 Introduction",
    "Body paragraph one.",
    "",
    "- alpha",
    "- beta",
    "",
    "| Name | Role |",
    "| Ada | Eng |",
  ].join("\n");

  it("recovers headings, paragraphs, lists and tables end to end", () => {
    const doc = assembleDoc(extractedTextToPages(page));
    const nodes = pdfBlocksToRichNodes(doc.blocks);

    expect(doc.title).toBe("1 Introduction");
    expect(nodes[0]).toEqual({
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "1 Introduction" }],
    });
    expect(nodes[1]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Body paragraph one." }],
    });
    expect(nodes[2]).toMatchObject({ type: "bulletList" });
    expect(nodes[2].content).toHaveLength(2);
    expect(nodes[3]).toMatchObject({ type: "table" });
    expect(nodes[3].content?.[0].content?.[0].type).toBe("tableHeader");
  });

  it("reports matching counts through describeImport", () => {
    const doc = assembleDoc(extractedTextToPages(page));
    const summary = describeImport(doc);
    // The engine emits one block per recovered item, so the two bullet lines
    // count as two `blocks` even though they group into a single editor list.
    expect(summary).toMatchObject({
      blocks: 5,
      headings: 1,
      paragraphs: 1,
      lists: 2,
      tables: 1,
      code: 0,
    });
    expect(summary.words).toBeGreaterThan(0);
  });

  it("warns and yields no blocks for empty input", () => {
    const doc = assembleDoc(extractedTextToPages(""));
    expect(doc.blocks).toEqual([]);
    expect(doc.warnings.map((warning) => warning.code)).toContain("NO_PAGES");
    expect(pdfBlocksToRichNodes(doc.blocks)).toEqual([]);
  });
});

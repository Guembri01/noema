import { describe, expect, it } from "vitest";
import {
  buildMarkdownExport,
  buildPrintExport,
  contentDisposition,
  docBlocks,
  engineForFormat,
  exportEngineHeaders,
  renderPrintDocument,
  representationFor,
  type ExportEngine,
} from "@/lib/page-export";

/**
 * Wiring test for `page-export.ts` — the seam that makes the two previously
 * unreachable engines reachable from the export route:
 *
 *   • `markdown-fidelity.ts` (`docToMarkdownFidelity` / `fidelityReport`)
 *   • `pdf-export.ts` (`buildPrintPlan` / `printStyles` / `exportFilename`)
 *
 * Everything under test is pure: no DB, no auth, no pdfkit.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Node = {
  type?: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
  content?: Node[];
};

const doc = (...content: Node[]): { type: "doc"; content: Node[] } => ({
  type: "doc",
  content,
});
const para = (text: string): Node => ({ type: "paragraph", content: [{ type: "text", text }] });
const heading = (level: number, text: string): Node => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});

/** A document with content `docToMarkdown` (`blocks.ts`) flattens. */
const NESTED = doc({
  type: "bulletList",
  content: [
    {
      type: "listItem",
      content: [
        para("alpha"),
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [para("beta")] }],
        },
      ],
    },
  ],
});

const NOW = new Date("2026-10-15T13:45:30Z");

// ---------------------------------------------------------------------------
// Query ⇄ engine mapping
// ---------------------------------------------------------------------------

describe("engineForFormat", () => {
  const cases: [string, ExportEngine][] = [
    ["md", "markdown-fidelity"],
    ["json", "json-snapshot"],
    ["html", "html-export"],
    ["pdf", "print-plan"],
  ];
  it.each(cases)("maps %s → %s", (format, engine) => {
    expect(engineForFormat(format)).toBe(engine);
  });

  it("returns null for an unknown format rather than defaulting", () => {
    expect(engineForFormat("docx")).toBeNull();
    expect(engineForFormat("MD")).toBeNull();
  });
});

describe("representationFor", () => {
  const params = (query: string) => new URLSearchParams(query);
  it("defaults to a download", () => {
    expect(representationFor(params(""))).toBe("download");
    expect(representationFor(params("print=0"))).toBe("download");
    expect(representationFor(params("print=yes"))).toBe("download");
  });
  it("opts into the print-ready HTML for exact 1/html", () => {
    expect(representationFor(params("print=1"))).toBe("print-html");
    expect(representationFor(params("print=html"))).toBe("print-html");
  });
});

// ---------------------------------------------------------------------------
// Markdown export (markdown-fidelity engine)
// ---------------------------------------------------------------------------

describe("buildMarkdownExport", () => {
  it("routes through docToMarkdownFidelity, preserving nested lists", () => {
    const result = buildMarkdownExport("Nested", NESTED, { frontMatter: undefined });
    expect(result.engine).toBe("markdown-fidelity");
    expect(result.body).toContain("- alpha\n  - beta");
  });

  it("emits frontmatter when asked and a title by default", () => {
    const withTitle = buildMarkdownExport("Nested", NESTED);
    expect(withTitle.body.startsWith("---\ntitle: Nested\n---")).toBe(true);

    const custom = buildMarkdownExport("Nested", NESTED, {
      frontMatter: { title: "Nested", exportedAt: "2026-10-15T00:00:00.000Z" },
    });
    expect(custom.body).toContain('exportedAt: "2026-10-15T00:00:00.000Z"');
  });

  it("prefixes relative image sources with imageBase", () => {
    const withImage = doc({ type: "image", attrs: { src: "pic.png", alt: "p" } });
    const result = buildMarkdownExport("Img", withImage, {
      frontMatter: undefined,
      imageBase: "https://cdn.test/assets/",
    });
    expect(result.body).toContain("![p](https://cdn.test/assets/pic.png)");
  });

  it("reports the losses the serializer cannot avoid", () => {
    const lossy = doc(
      {
        type: "paragraph",
        content: [
          { type: "text", text: "hi", marks: [{ type: "color", attrs: { color: "#f00" } }] },
        ],
      },
      { type: "mysteryBlock", content: [para("?")] },
    );
    const result = buildMarkdownExport("Lossy", lossy);
    const kinds = result.fidelity.lost.map((loss) => loss.kind);
    expect(kinds).toContain("color");
    expect(kinds).toContain("mysteryBlock");
  });

  it("is lossless for plain prose", () => {
    const result = buildMarkdownExport("Plain", doc(para("hello")));
    expect(result.fidelity).toEqual({ lost: [], approximated: [] });
  });
});

// ---------------------------------------------------------------------------
// Print export (print-plan engine)
// ---------------------------------------------------------------------------

describe("buildPrintExport", () => {
  const content = doc(heading(1, "Doc"), para("body"));

  it("plans the pages and derives both filenames via exportFilename", () => {
    const print = buildPrintExport("My Page", content, { now: NOW });
    expect(print.engine).toBe("print-plan");
    expect(print.plan.meta.blockCount).toBe(2);
    expect(print.plan.pages.length).toBeGreaterThanOrEqual(1);
    expect(print.filename).toBe("my-page-20261015-134530.pdf");
    expect(print.htmlFilename).toBe("my-page-20261015-134530.html");
  });

  it("builds the print stylesheet and embeds it in the print-ready HTML", () => {
    const print = buildPrintExport("My Page", content, { now: NOW });
    expect(print.styles).toContain("@page { size: A4 portrait;");
    expect(print.html.startsWith("<!doctype html>")).toBe(true);
    expect(print.html).toContain(print.styles);
    expect(print.html).toContain('<section class="print-page" data-page="1">');
    expect(print.html).toContain("<h1>Doc</h1>");
  });

  it("includes a TOC page when asked and reports heading locations", () => {
    const print = buildPrintExport("My Page", content, { now: NOW, includeToc: true });
    expect(print.plan.meta.includeToc).toBe(true);
    expect(print.plan.meta.toc).toEqual([{ level: 1, text: "Doc", pageIndex: 1 }]);
  });

  it("warns when the document has nested content Markdown would flatten", () => {
    const withColumns = doc({
      type: "columns",
      content: [
        { type: "column", content: [para("left")] },
        { type: "column", content: [para("right")] },
      ],
    });
    const print = buildPrintExport("Cols", withColumns, { now: NOW });
    expect(print.fidelity.lossless).toBe(false);
    expect(print.fidelity.warnings.map((w) => w.code)).toContain("COLUMNS");
  });
});

describe("renderPrintDocument", () => {
  it("marks a landscape page and escapes the title", () => {
    const wide: Node = {
      type: "table",
      content: Array.from({ length: 2 }, (_, rowIndex) => ({
        type: "tableRow",
        content: Array.from({ length: 5 }, (_, colIndex) => ({
          type: rowIndex === 0 ? "tableHeader" : "tableCell",
          content: [para(`c${colIndex}`)],
        })),
      })),
    };
    const print = buildPrintExport("A < B", doc(wide), { now: NOW });
    expect(print.plan.pages[0].orientation).toBe("landscape");
    const html = renderPrintDocument("A < B", print.plan, print.styles);
    expect(html).toContain("<title>A &lt; B</title>");
    expect(html).toContain("<h1>A &lt; B</h1>");
    expect(html).toContain('<section class="print-page print-landscape" data-page="1">');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("docBlocks", () => {
  it("tolerates junk instead of throwing", () => {
    expect(docBlocks(null)).toEqual([]);
    expect(docBlocks("nope")).toEqual([]);
    expect(docBlocks({ type: "doc" })).toEqual([]);
    expect(docBlocks({ type: "doc", content: [null, 1, { type: "paragraph" }] })).toEqual([
      { type: "paragraph" },
    ]);
  });
});

describe("contentDisposition", () => {
  it("keeps an ASCII fallback plus the RFC 5987 encoded name", () => {
    const header = contentDisposition("café-20261015.pdf");
    expect(header).toContain('filename="caf_-20261015.pdf"');
    expect(header).toContain("filename*=UTF-8''caf%C3%A9-20261015.pdf");
  });
});

describe("exportEngineHeaders", () => {
  const base = { engine: "print-plan" as const };

  it("exposes page/block counts and the filename (URL-encoded)", () => {
    const print = buildPrintExport("My Page", doc(para("x")), { now: NOW });
    const headers = exportEngineHeaders({ ...base, filename: print.filename, plan: print.plan });
    expect(headers["x-export-engine"]).toBe("print-plan");
    expect(headers["x-export-plan-pages"]).toBe("1");
    expect(headers["x-export-plan-blocks"]).toBe("1");
    expect(headers["x-export-filename"]).toBe("my-page-20261015-134530.pdf");
  });

  it("turns fidelity losses into countable, decodable headers", () => {
    const result = buildMarkdownExport("Lossy", doc({
      type: "paragraph",
      content: [
        { type: "text", text: "hi", marks: [{ type: "color", attrs: { color: "#f00" } }] },
      ],
    }));
    const headers = exportEngineHeaders({ engine: result.engine, fidelity: result.fidelity });
    expect(headers["x-export-fidelity-losses"]).toBe("1");
    expect(headers["x-export-fidelity-approximated"]).toBe("0");
    const decoded = JSON.parse(decodeURIComponent(headers["x-export-fidelity"]));
    expect(decoded.lost[0].kind).toBe("color");
  });
});

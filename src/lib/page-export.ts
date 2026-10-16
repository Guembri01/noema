/**
 * Page-export wiring (docs/MISSING_FEATURES.md §12 "Export Markdown — nested
 * content partial", "Export PDF — headless render").
 *
 * Two engines already shipped with full test suites but were never reachable
 * from the export route:
 *
 *   • `markdown-fidelity.ts` — `docToMarkdownFidelity` / `fidelityReport`,
 *     the round-trip-safe replacement for the lossy `blocks.ts#docToMarkdown`;
 *   • `pdf-export.ts` — `buildPrintPlan` / `printStyles` / `exportFilename`,
 *     the pure "plan the pages" half of a PDF render.
 *
 * This module is the seam that makes both reachable. It owns the pure
 * **format ⇄ engine** and **query ⇄ representation** mappings, assembles the
 * Markdown and print payloads (the print payload is a complete, print-ready
 * HTML document that embeds `printStyles`), and exposes the engines' fidelity
 * findings as response headers so a loss is visible to the caller instead of
 * being silently swallowed.
 *
 * Everything here is pure and deterministic (no DB, no React, no pdfkit): the
 * route passes a page's stored document in and gets a transport-agnostic
 * payload out, so the mapping is unit-testable without a database or a server.
 */

import { blocksToHtml, escapeHtml } from "./html-export";
import {
  docToMarkdownFidelity,
  fidelityReport,
  type FidelityOptions,
  type FidelityReport as MarkdownFidelityReport,
} from "./markdown-fidelity";
import type { RichBlock } from "./markdown";
import {
  buildPrintPlan,
  exportFilename,
  printStyles,
  toMarkdownFidelity,
  type FidelityReport as PlanFidelityReport,
  type PrintPlan,
} from "./pdf-export";

// ---------------------------------------------------------------------------
// Query ⇄ engine mapping
// ---------------------------------------------------------------------------

/** The four `?format=` values the page route accepts. */
export type PageExportFormat = "md" | "json" | "html" | "pdf";

/** The pure engine a format is routed through. */
export type ExportEngine =
  | "markdown-fidelity"
  | "json-snapshot"
  | "html-export"
  | "print-plan";

const ENGINE_BY_FORMAT: Record<PageExportFormat, ExportEngine> = {
  md: "markdown-fidelity",
  json: "json-snapshot",
  html: "html-export",
  pdf: "print-plan",
};

/** The engine for a validated format, or `null` for an unknown one. */
export function engineForFormat(format: string): ExportEngine | null {
  return (ENGINE_BY_FORMAT as Record<string, ExportEngine | undefined>)[format] ?? null;
}

/**
 * How a payload is represented. `download` is the default (a file body);
 * `print-html` is the opt-in `?print=1`/`?print=html` representation, a
 * complete print-ready HTML document that a browser can print to PDF.
 */
export type ExportRepresentation = "download" | "print-html";

/** Map `?print=` onto a representation. Only exact `1`/`html` opt in. */
export function representationFor(params: URLSearchParams): ExportRepresentation {
  const raw = params.get("print");
  return raw === "1" || raw === "html" ? "print-html" : "download";
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Pull the block array out of a stored page document, tolerating junk: a
 * missing/non-object root or a non-array `content` yields `[]` rather than a
 * throw. Elements are filtered to objects so the pure engines only ever see
 * block-shaped nodes.
 */
export function docBlocks(content: unknown): RichBlock[] {
  if (!content || typeof content !== "object") return [];
  const inner = (content as { content?: unknown }).content;
  if (!Array.isArray(inner)) return [];
  return inner.filter(
    (node): node is RichBlock => Boolean(node) && typeof node === "object",
  );
}

/** Longest fidelity blob we echo in a header, so a huge doc cannot blow it up. */
const MAX_HEADER_VALUE = 3500;

function encodeJson(value: unknown): string {
  let encoded = "";
  try {
    encoded = encodeURIComponent(JSON.stringify(value ?? null));
  } catch {
    encoded = "";
  }
  return encoded.length > MAX_HEADER_VALUE ? encoded.slice(0, MAX_HEADER_VALUE) : encoded;
}

/**
 * An ASCII-safe `Content-Disposition` for an arbitrary (possibly non-Latin)
 * filename: an ASCII fallback plus the RFC 5987 `filename*` so the real name
 * survives in every browser. Header values must be a ByteString, so an
 * `exportFilename` containing CJK, say, would otherwise throw.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------------------------------
// Response headers (fidelity visibility)
// ---------------------------------------------------------------------------

export type ExportHeaderInput = {
  engine: ExportEngine;
  /** Nested-content Markdown report (`markdown-fidelity.ts#fidelityReport`). */
  fidelity?: MarkdownFidelityReport;
  /** Print-plan Markdown-fidelity report (`pdf-export.ts#toMarkdownFidelity`). */
  planFidelity?: PlanFidelityReport;
  /** The print plan, exposed as page/block counts. */
  plan?: PrintPlan;
  /** Download filename the engine chose. */
  filename?: string;
};

/**
 * The `x-export-*` headers describing *which* engine ran and *what it lost*.
 * Counts are human-readable; the full report rides along URL-encoded (ASCII).
 * A caller can therefore surface "3 losses" without parsing the body — the
 * export being lossy is no longer invisible.
 */
export function exportEngineHeaders(input: ExportHeaderInput): Record<string, string> {
  const headers: Record<string, string> = { "x-export-engine": input.engine };
  if (input.filename) headers["x-export-filename"] = encodeURIComponent(input.filename);
  if (input.plan) {
    headers["x-export-plan-pages"] = String(input.plan.meta.pageCount);
    headers["x-export-plan-blocks"] = String(input.plan.meta.blockCount);
    headers["x-export-plan-orientation"] = input.plan.meta.orientation;
  }
  if (input.fidelity) {
    headers["x-export-fidelity-losses"] = String(input.fidelity.lost.length);
    headers["x-export-fidelity-approximated"] = String(input.fidelity.approximated.length);
    headers["x-export-fidelity"] = encodeJson(input.fidelity);
  }
  if (input.planFidelity) {
    headers["x-export-plan-warnings"] = String(input.planFidelity.warnings.length);
    headers["x-export-plan-fidelity"] = encodeJson(input.planFidelity);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Markdown payload (markdown-fidelity engine)
// ---------------------------------------------------------------------------

export type MarkdownExportOptions = {
  /** Options forwarded verbatim to `docToMarkdownFidelity`. */
  frontMatter?: FidelityOptions["frontMatter"];
  imageBase?: string;
  gfm?: boolean;
};

export type MarkdownExport = {
  engine: "markdown-fidelity";
  body: string;
  fidelity: MarkdownFidelityReport;
};

/**
 * Serialise a page through the fidelity serializer and report what it lost.
 * The stored document is passed through untouched (`docToMarkdownFidelity`
 * already tolerates a bare block, an array or a full `doc` root).
 */
export function buildMarkdownExport(
  title: string,
  content: unknown,
  options: MarkdownExportOptions = {},
): MarkdownExport {
  const body = docToMarkdownFidelity(content, {
    frontMatter: options.frontMatter ?? { title },
    imageBase: options.imageBase,
    gfm: options.gfm,
  });
  return { engine: "markdown-fidelity", body, fidelity: fidelityReport(content) };
}

// ---------------------------------------------------------------------------
// Print payload (print-plan engine)
// ---------------------------------------------------------------------------

export type PrintExportOptions = {
  pageSize?: "a4" | "letter";
  includeToc?: boolean;
  includePageNumbers?: boolean;
  /** Injectable clock for a deterministic filename in tests. */
  now?: Date | number | string;
};

export type PrintExport = {
  engine: "print-plan";
  /** `<slug>-<stamp>.pdf` for the PDF representation. */
  filename: string;
  /** `<slug>-<stamp>.html` for the print-ready HTML representation. */
  htmlFilename: string;
  plan: PrintPlan;
  /** The `@page`/typography CSS the print document injects. */
  styles: string;
  /** A complete, print-ready `<!doctype html>` document. */
  html: string;
  /** Nested features a Markdown export would flatten (`pdf-export.ts`). */
  fidelity: PlanFidelityReport;
};

/**
 * A block's DOM for the print document. `blocksToHtml` already owns escaped,
 * sanitised block rendering, so the plan just decides *where* blocks land.
 */
function renderPlacedBlocks(plan: PrintPlan, pageIndex: number): string {
  const page = plan.pages[pageIndex];
  if (!page) return "";
  return blocksToHtml(page.blocks.map((placed) => placed.block));
}

/** Extra print rules layered on top of `printStyles` for the page sections. */
const PRINT_PAGE_RULES = [
  ".print-page { padding: 0; }",
  ".print-page + .print-page { page-break-before: always; }",
  ".print-page .print-page-number { display: block; text-align: right; font-size: .8em; color: #787774; }",
].join("\n");

/**
 * Wrap a print plan in a standalone, print-ready HTML document: charset,
 * escaped title, the engine's `printStyles` (plus the page-section rules), and
 * one `<section>` per planned page so the pagination the engine decided is what
 * the browser prints.
 */
export function renderPrintDocument(title: string, plan: PrintPlan, styles: string): string {
  const safeTitle = title?.trim() || "Untitled";
  const sections = plan.pages
    .map((page, index) => {
      const body = renderPlacedBlocks(plan, index);
      const number = plan.meta.includePageNumbers
        ? `<span class="print-page-number">${index + 1} / ${plan.meta.pageCount}</span>`
        : "";
      const cls = page.orientation === "landscape" ? "print-page print-landscape" : "print-page";
      return `<section class="${cls}" data-page="${index + 1}">${body}${number}</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(safeTitle)}</title>
<style>
${styles}
${PRINT_PAGE_RULES}
</style>
</head>
<body>
<h1>${escapeHtml(safeTitle)}</h1>
${sections}
</body>
</html>
`;
}

/**
 * Run a page through the print-plan engine: paginate it, build the print CSS,
 * derive the download names and render the print-ready HTML. `buildPrintPlan`
 * (page breaks, keep-with-next, landscape tables) and `printStyles` are both
 * consumed here, so the plan is not merely computed — it is the document.
 */
export function buildPrintExport(
  title: string,
  content: unknown,
  options: PrintExportOptions = {},
): PrintExport {
  const blocks = docBlocks(content);
  const plan = buildPrintPlan(
    { title, blocks },
    {
      pageSize: options.pageSize,
      includeToc: options.includeToc,
      includePageNumbers: options.includePageNumbers,
    },
  );
  const styles = printStyles({
    pageSize: plan.meta.pageSize,
    margins: plan.meta.margins,
    includePageNumbers: options.includePageNumbers,
  });
  return {
    engine: "print-plan",
    filename: exportFilename(title, { ext: "pdf", now: options.now }),
    htmlFilename: exportFilename(title, { ext: "html", now: options.now }),
    plan,
    styles,
    html: renderPrintDocument(title, plan, styles),
    fidelity: toMarkdownFidelity({ title, blocks }),
  };
}

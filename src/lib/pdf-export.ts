/**
 * PDF export planning engine — the pure, headless-browser-free half of
 * "Export PDF" (docs/specs/import-export.md §12, R23.15) plus the
 * nested-content fidelity report that guards "Export Markdown".
 *
 * `pdf.ts` hands blocks to pdfkit and lets it flow text; that leaves no way to
 * reason about *where* pages break, keep a heading with the paragraph it
 * introduces, or avoid splitting a code block. This module adds that planning
 * layer above the same editor block JSON (`RichBlock`) `html-export.ts` maps:
 *
 *   • `estimateBlockHeight(block, { widthPx })` — deterministic height model;
 *   • `tableToPrintGrid(block)` — a table's rectangular text grid;
 *   • `buildPrintPlan(doc, opts)` — paginate blocks into pages, honouring
 *     keep-with-next for headings, never splitting a code block that fits one
 *     page, and widening a page to landscape for a wide table;
 *   • `printStyles(opts)` — the print-CSS string a renderer injects;
 *   • `exportFilename(title, { ext, now })` — slugified, timestamped name;
 *   • `collectAssets(doc)` — images/fonts a renderer must embed;
 *   • `toMarkdownFidelity(doc)` — nested features a Markdown export flattens.
 *
 * Everything here is pure and deterministic — no pdfkit, no React, no DB — and
 * all input is normalised at the boundary so a malformed block or a
 * non-finite option degrades to a default instead of throwing.
 */

import type { RichBlock } from "./markdown";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Height of one wrapped line of body text, in CSS pixels. */
export const LINE_HEIGHT = 24;
/** Vertical gap after a block, before the next one. */
export const BLOCK_SPACING = 12;
/** Height of one line inside a code block. */
export const CODE_LINE_HEIGHT = 18;
/** Vertical padding inside a code block. */
export const CODE_PADDING = 24;
/** Vertical padding inside a blockquote. */
export const QUOTE_PADDING = 16;
/** Vertical padding inside a callout. */
export const CALLOUT_PADDING = 24;
/** Height of one table row. */
export const ROW_HEIGHT = 32;
/** Height of a divider rule. */
export const DIVIDER_HEIGHT = 8;
/** Default rendered image height. */
export const DEFAULT_IMAGE_HEIGHT = 240;
/** Approximate width of one character, used to estimate wrapping. */
export const CHAR_WIDTH = 8;
/** Default page margin (0.75in) in CSS pixels. */
export const DEFAULT_MARGIN = 72;
/** Default content width (A4 portrait minus default margins). */
export const DEFAULT_CONTENT_WIDTH = 650;
/** A table at least this many columns wide gets a landscape page. */
export const LANDSCAPE_MIN_COLUMNS = 5;

/** Nominal page dimensions at 96dpi, in CSS pixels. */
export const PAGE_SIZES = {
  a4: { width: 794, height: 1123 },
  letter: { width: 816, height: 1056 },
} as const;

const PAGE_SIZE_CSS: Record<PageSize, string> = { a4: "A4", letter: "Letter" };

const HEADING_BASE = { h1: 40, h2: 32, h3: 26 } as const;

/** Block-level node types, used to join text runs with newlines. */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "divider",
  "callout",
  "toggle",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "image",
  "blockMath",
  "columns",
  "column",
  "bookmark",
  "embed",
  "pageEmbed",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PageSize = "a4" | "letter";

export type MarginInput =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number };

export type ResolvedMargins = { top: number; right: number; bottom: number; left: number };

/** The document shape every planner entry point accepts. */
export type PrintDoc = { title?: string; blocks?: readonly RichBlock[] };

export type PrintPlanOptions = {
  pageSize?: PageSize;
  margins?: MarginInput;
  includeToc?: boolean;
  includePageNumbers?: boolean;
};

export type BlockHeightOptions = { widthPx?: number };

/** One block placed on a page, with the height used to place it. */
export type PrintPlacedBlock = {
  block: RichBlock;
  type: string;
  height: number;
  /** Index of the source block in `doc.blocks` (`-1` for a generated TOC). */
  index: number;
  /** 0-based part number when a tall code block had to be split. */
  part?: number;
  /** True when the block is taller than a page's content box. */
  oversized?: boolean;
};

export type PrintPlanPage = {
  /** Zero-based index, in document order. */
  index: number;
  orientation: "portrait" | "landscape";
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  blocks: PrintPlacedBlock[];
  /** Sum of the placed block heights. */
  estimatedHeight: number;
};

export type TocEntry = { level: number; text: string; pageIndex: number };

export type PrintMeta = {
  title: string;
  pageSize: PageSize;
  orientation: "portrait";
  width: number;
  height: number;
  margins: ResolvedMargins;
  contentWidth: number;
  contentHeight: number;
  pageCount: number;
  blockCount: number;
  includeToc: boolean;
  includePageNumbers: boolean;
  toc: TocEntry[];
};

export type PrintPlan = { pages: PrintPlanPage[]; meta: PrintMeta };

export type PrintGrid = { rows: string[][]; columns: number; headerRows: number };

export type PrintAsset = { src: string; alt: string; kind: "image" };

export type CollectedAssets = { images: PrintAsset[]; fonts: string[]; count: number };

export type PrintStyleOptions = {
  pageSize?: PageSize;
  margins?: MarginInput;
  includePageNumbers?: boolean;
  orientation?: "portrait" | "landscape";
};

export type ExportFilenameOptions = { ext?: string; now?: Date | number | string };

export type FidelityWarning = {
  code: "COLUMNS" | "TABLE_NESTED" | "EMBED" | "PAGE_EMBED";
  blockType: string;
  message: string;
  /** Slash-delimited index path to the offending block. */
  path: string;
};

export type FidelityReport = { warnings: FidelityWarning[]; lossless: boolean };

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is RichBlock {
  return typeof value === "object" && value !== null;
}

function isPageSize(value: unknown): value is PageSize {
  return value === "a4" || value === "letter";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Flatten a block's readable text. Inline runs concatenate; block-level
 * children join with a newline, so a list's items or a quote's paragraphs keep
 * their line structure.
 */
function collectText(node: RichBlock | null | undefined): string {
  if (!isObject(node)) return "";
  const kids = Array.isArray(node.content) ? node.content : [];
  if (kids.length === 0) return typeof node.text === "string" ? node.text : "";
  let out = "";
  for (const kid of kids) {
    if (!isObject(kid)) continue;
    const text = collectText(kid);
    if (text === "") continue;
    const isBlock = typeof kid.type === "string" && BLOCK_TYPES.has(kid.type);
    out += isBlock && out !== "" ? `\n${text}` : text;
  }
  return out;
}

/** Characters per line for a given content width. */
function charsPerLine(widthPx: number): number {
  const width = isFiniteNumber(widthPx) && widthPx > 0 ? widthPx : DEFAULT_CONTENT_WIDTH;
  return Math.max(1, Math.floor(width / CHAR_WIDTH));
}

/** Wrapped-line count: explicit newlines plus soft wrapping. */
function wrappedLines(text: string, perLine: number): number {
  if (text === "") return 1;
  let lines = 0;
  for (const part of text.split("\n")) lines += Math.max(1, Math.ceil(part.length / perLine));
  return lines;
}

function headingLevel(block: RichBlock | null | undefined): number {
  const raw = Number(block?.attrs?.level);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(Math.max(Math.floor(raw), 1), 6);
}

function resolveMargins(
  margins: MarginInput | undefined,
  dims: { width: number; height: number },
): ResolvedMargins {
  const base: { top?: number; right?: number; bottom?: number; left?: number } =
    typeof margins === "number"
      ? { top: margins, right: margins, bottom: margins, left: margins }
      : margins ?? {};
  const side = (value: unknown, max: number): number => {
    const n = isFiniteNumber(value) ? value : DEFAULT_MARGIN;
    return Math.min(Math.max(n, 0), max);
  };
  return {
    top: side(base.top, dims.height),
    right: side(base.right, dims.width),
    bottom: side(base.bottom, dims.height),
    left: side(base.left, dims.width),
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Estimate a block's rendered height from its shape alone.
 *
 * Text wraps against `widthPx` at `CHAR_WIDTH` per character, headings are
 * ranked by level, lists scale with their items, code uses the tighter
 * `CODE_LINE_HEIGHT` and never soft-wraps, tables scale with their rows, and
 * images use an explicit `attrs.height` (or a default). Unknown types degrade
 * to a paragraph so a new block type never measures as zero. Deterministic for
 * a given input, and total: malformed input yields a one-line paragraph.
 */
export function estimateBlockHeight(
  block: RichBlock | null | undefined,
  options: BlockHeightOptions = {},
): number {
  const type = isObject(block) && typeof block.type === "string" ? block.type : "";
  const perLine = charsPerLine(options.widthPx ?? DEFAULT_CONTENT_WIDTH);
  const text = collectText(block);
  const lines = wrappedLines(text, perLine);
  switch (type) {
    case "heading": {
      const level = headingLevel(block);
      const base =
        level <= 1 ? HEADING_BASE.h1 : level === 2 ? HEADING_BASE.h2 : HEADING_BASE.h3;
      return base + (lines - 1) * LINE_HEIGHT + BLOCK_SPACING;
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const items = isObject(block) && Array.isArray(block.content) ? block.content : [];
      if (items.length === 0) return LINE_HEIGHT + BLOCK_SPACING;
      let height = 0;
      for (const item of items) {
        height += Math.max(LINE_HEIGHT, wrappedLines(collectText(item), perLine) * LINE_HEIGHT);
      }
      return height + BLOCK_SPACING;
    }
    case "codeBlock": {
      // Code never soft-wraps: one explicit newline per rendered line.
      const codeLines = text === "" ? 1 : text.split("\n").length;
      return codeLines * CODE_LINE_HEIGHT + CODE_PADDING + BLOCK_SPACING;
    }
    case "blockquote":
      return lines * LINE_HEIGHT + QUOTE_PADDING + BLOCK_SPACING;
    case "callout":
      return lines * LINE_HEIGHT + CALLOUT_PADDING + BLOCK_SPACING;
    case "table": {
      const rows = Math.max(1, tableToPrintGrid(block).rows.length);
      return rows * ROW_HEIGHT + BLOCK_SPACING;
    }
    case "image": {
      const explicit = isObject(block) ? block.attrs?.height : undefined;
      const height = isFiniteNumber(explicit) && explicit > 0 ? explicit : DEFAULT_IMAGE_HEIGHT;
      return height + BLOCK_SPACING;
    }
    case "horizontalRule":
    case "divider":
      return DIVIDER_HEIGHT + BLOCK_SPACING;
    case "columns": {
      const cols = isObject(block) && Array.isArray(block.content) ? block.content : [];
      if (cols.length === 0) return BLOCK_SPACING;
      const colWidth = Math.max(120, Math.floor((options.widthPx ?? DEFAULT_CONTENT_WIDTH) / cols.length));
      let tallest = 0;
      for (const col of cols) {
        if (!isObject(col)) continue;
        const children = Array.isArray(col.content) ? col.content : [];
        let height = 0;
        for (const child of children) height += estimateBlockHeight(child, { widthPx: colWidth });
        if (height > tallest) tallest = height;
      }
      return tallest + BLOCK_SPACING;
    }
    default:
      return lines * LINE_HEIGHT + BLOCK_SPACING;
  }
}

/**
 * Reduce a table block to a rectangular grid of cell text.
 *
 * Rows are padded to the widest row so every row has the same column count,
 * and `headerRows` counts rows that contain a `tableHeader` cell. A missing or
 * malformed table yields an empty grid rather than throwing.
 */
export function tableToPrintGrid(node: RichBlock | null | undefined): PrintGrid {
  const source = isObject(node) && Array.isArray(node.content) ? node.content : [];
  const rows: string[][] = [];
  let columns = 0;
  let headerRows = 0;
  for (const row of source) {
    if (!isObject(row)) continue;
    const cells = Array.isArray(row.content) ? row.content.filter(isObject) : [];
    if (cells.some((cell) => cell.type === "tableHeader")) headerRows += 1;
    const values = cells.map((cell) => collectText(cell));
    rows.push(values);
    if (values.length > columns) columns = values.length;
  }
  for (const row of rows) {
    while (row.length < columns) row.push("");
  }
  return { rows, columns, headerRows };
}

// ---------------------------------------------------------------------------
// Print plan
// ---------------------------------------------------------------------------

type PageState = {
  orientation: "portrait" | "landscape";
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  placed: PrintPlacedBlock[];
  used: number;
};

function makePageState(
  pageSize: PageSize,
  orientation: "portrait" | "landscape",
  margins: MarginInput | undefined,
): PageState {
  const dims = PAGE_SIZES[pageSize];
  const width = orientation === "landscape" ? dims.height : dims.width;
  const height = orientation === "landscape" ? dims.width : dims.height;
  const m = resolveMargins(margins, { width, height });
  return {
    orientation,
    width,
    height,
    contentWidth: Math.max(0, width - m.left - m.right),
    contentHeight: Math.max(0, height - m.top - m.bottom),
    placed: [],
    used: 0,
  };
}

function toPage(state: PageState, index: number): PrintPlanPage {
  return {
    index,
    orientation: state.orientation,
    width: state.width,
    height: state.height,
    contentWidth: state.contentWidth,
    contentHeight: state.contentHeight,
    blocks: state.placed,
    estimatedHeight: state.used,
  };
}

/** A page is widened to landscape when it holds a table this wide or wider. */
function needsLandscape(block: RichBlock | null | undefined): boolean {
  return isObject(block) && block.type === "table" && tableToPrintGrid(block).columns >= LANDSCAPE_MIN_COLUMNS;
}

/** Split an over-tall code block into page-sized, contiguous parts. */
function splitCodeBlock(
  block: RichBlock,
  contentHeight: number,
): { block: RichBlock; height: number }[] {
  const lines = collectText(block).split("\n");
  const usable = Math.max(CODE_LINE_HEIGHT, contentHeight - CODE_PADDING - BLOCK_SPACING);
  const perPart = Math.max(1, Math.floor(usable / CODE_LINE_HEIGHT));
  const parts: { block: RichBlock; height: number }[] = [];
  for (let start = 0; start < lines.length; start += perPart) {
    const chunk = lines.slice(start, start + perPart);
    parts.push({
      block: {
        type: "codeBlock",
        attrs: { ...(block.attrs ?? {}), part: parts.length + 1 },
        content: [{ type: "text", text: chunk.join("\n") }],
      },
      height: chunk.length * CODE_LINE_HEIGHT + CODE_PADDING + BLOCK_SPACING,
    });
  }
  return parts;
}

/**
 * Paginate a document into print pages.
 *
 * Greedy and deterministic: blocks are placed in order until a content box
 * fills, then a new page starts. A `heading` keeps with the block that follows
 * it — the pair travels together when it does not fit where the heading alone
 * would. A `codeBlock` that fits one page is never split (it moves whole); one
 * taller than a page is split into contiguous parts. A `table` with
 * `LANDSCAPE_MIN_COLUMNS` or more columns gets its own landscape page, so its
 * rows can breathe. With `includeToc`, a TOC page is prepended and `meta.toc`
 * records each heading's final page.
 */
export function buildPrintPlan(
  doc: PrintDoc | null | undefined,
  options: PrintPlanOptions = {},
): PrintPlan {
  const pageSize: PageSize = isPageSize(options.pageSize) ? options.pageSize : "a4";
  const margins = options.margins;
  const includeToc = options.includeToc === true;
  const includePageNumbers = options.includePageNumbers === true;
  const title = typeof doc?.title === "string" && doc.title.trim() !== "" ? doc.title.trim() : "Untitled";
  const blocks: RichBlock[] = Array.isArray(doc?.blocks) ? doc.blocks.filter(isObject) : [];

  const base = makePageState(pageSize, "portrait", margins);
  const { contentWidth, contentHeight } = base;

  const pages: PrintPlanPage[] = [];
  let current: PageState | null = null;

  const flush = (): void => {
    if (current && current.placed.length > 0) pages.push(toPage(current, pages.length));
    current = null;
  };
  const ensure = (): PageState => {
    if (!current) current = makePageState(pageSize, "portrait", margins);
    return current;
  };
  // Reads `current` through a call so the control-flow analyser does not narrow
  // it to `null` (it is only ever reassigned inside the closures above).
  const peek = (): PageState | null => current;

  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    const type = typeof block.type === "string" ? block.type : "";

    // A wide table owns a landscape page so its columns stay readable.
    if (needsLandscape(block)) {
      flush();
      const state = makePageState(pageSize, "landscape", margins);
      const height = estimateBlockHeight(block, { widthPx: state.contentWidth });
      state.placed.push({
        block,
        type,
        height,
        index: i,
        oversized: height > state.contentHeight,
      });
      state.used = height;
      pages.push(toPage(state, pages.length));
      i += 1;
      continue;
    }

    const height = estimateBlockHeight(block, { widthPx: contentWidth });

    // An over-tall code block is split into contiguous page-sized parts.
    if (type === "codeBlock" && height > contentHeight) {
      flush();
      const parts = splitCodeBlock(block, contentHeight);
      for (let p = 0; p < parts.length; p += 1) {
        const piece = parts[p];
        const open = ensure();
        if (open.placed.length > 0 && open.used + piece.height > contentHeight) flush();
        const target = ensure();
        target.placed.push({
          block: piece.block,
          type: "codeBlock",
          height: piece.height,
          index: i,
          part: p,
        });
        target.used += piece.height;
      }
      i += 1;
      continue;
    }

    // Grow a keep-with-next group while the pair stays glued and fits one box.
    const group: { block: RichBlock; height: number; index: number }[] = [
      { block, height, index: i },
    ];
    let groupHeight = height;
    let j = i;
    while (j + 1 < blocks.length) {
      const prevType = typeof blocks[j].type === "string" ? blocks[j].type : "";
      if (prevType !== "heading") break;
      const next = blocks[j + 1];
      if (needsLandscape(next)) break;
      const nextHeight = estimateBlockHeight(next, { widthPx: contentWidth });
      if (nextHeight > contentHeight) break;
      if (groupHeight + nextHeight > contentHeight) break;
      group.push({ block: next, height: nextHeight, index: j + 1 });
      groupHeight += nextHeight;
      j += 1;
    }
    if (groupHeight > contentHeight) {
      // A group taller than a page cannot be kept together — place the first
      // block alone and let the rest flow normally.
      group.length = 0;
      group.push({ block, height, index: i });
      groupHeight = height;
      j = i;
    }

    const open = peek();
    if (open && open.placed.length > 0 && open.used + groupHeight > contentHeight) flush();
    const target = ensure();
    for (const member of group) {
      target.placed.push({
        block: member.block,
        type: typeof member.block.type === "string" ? member.block.type : "",
        height: member.height,
        index: member.index,
        oversized: member.height > contentHeight,
      });
      target.used += member.height;
    }
    i = j + 1;
  }
  flush();

  // Optional table of contents as the first page.
  const hasHeadings = blocks.some((block) => block.type === "heading");
  let ordered = pages;
  if (includeToc && hasHeadings) {
    const entries = pages.flatMap((page) =>
      page.blocks
        .filter((placed) => placed.type === "heading")
        .map((placed) => ({ level: headingLevel(placed.block), text: collectText(placed.block) })),
    );
    const tocBlock: RichBlock = {
      type: "toc",
      attrs: { entries },
      content: entries.map((entry) => ({
        type: "paragraph",
        content: [{ type: "text", text: entry.text }],
      })),
    };
    const tocHeight = entries.length * LINE_HEIGHT + CALLOUT_PADDING + BLOCK_SPACING;
    const tocState = makePageState(pageSize, "portrait", margins);
    tocState.placed.push({ block: tocBlock, type: "toc", height: tocHeight, index: -1 });
    tocState.used = tocHeight;
    ordered = [toPage(tocState, 0), ...pages];
  }
  const finalPages = ordered.map((page, index) => ({ ...page, index }));

  const toc: TocEntry[] = [];
  for (const page of finalPages) {
    for (const placed of page.blocks) {
      if (placed.type === "heading") {
        toc.push({
          level: headingLevel(placed.block),
          text: collectText(placed.block),
          pageIndex: page.index,
        });
      }
    }
  }

  const meta: PrintMeta = {
    title,
    pageSize,
    orientation: "portrait",
    width: base.width,
    height: base.height,
    margins: resolveMargins(margins, { width: base.width, height: base.height }),
    contentWidth,
    contentHeight,
    pageCount: finalPages.length,
    blockCount: blocks.length,
    includeToc,
    includePageNumbers,
    toc,
  };

  return { pages: finalPages, meta };
}

// ---------------------------------------------------------------------------
// Print CSS
// ---------------------------------------------------------------------------

/**
 * The print stylesheet for a PDF/print render. Emits the `@page` rule (size,
 * orientation, margins) plus minimal typography for headings, code, quotes,
 * tables, columns and images. Page-number styling is only emitted when
 * `includePageNumbers` is set.
 */
export function printStyles(options: PrintStyleOptions = {}): string {
  const pageSize: PageSize = isPageSize(options.pageSize) ? options.pageSize : "a4";
  const orientation = options.orientation === "landscape" ? "landscape" : "portrait";
  const m = resolveMargins(options.margins, PAGE_SIZES[pageSize]);
  const rules = [
    `@page { size: ${PAGE_SIZE_CSS[pageSize]} ${orientation}; margin: ${m.top}px ${m.right}px ${m.bottom}px ${m.left}px; }`,
    `* { box-sizing: border-box; }`,
    `body { font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #37352f; line-height: 1.65; margin: 0; }`,
    `h1 { font-size: 1.9rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.2rem; } h4, h5, h6 { font-size: 1rem; }`,
    `pre { background: #f1f1ef; padding: 12px; border-radius: 6px; overflow-wrap: anywhere; }`,
    `code { background: #f1f1ef; padding: 1px 4px; border-radius: 4px; font-size: .9em; }`,
    `blockquote, .callout { border-left: 3px solid #e9e9e7; padding-left: 12px; color: #55534e; }`,
    `table { border-collapse: collapse; width: 100%; }`,
    `th, td { border: 1px solid #d9d9d7; padding: 6px 8px; text-align: left; vertical-align: top; }`,
    `.columns { display: flex; gap: 16px; } .column { flex: 1; }`,
    `img { max-width: 100%; }`,
    `.todo-list { list-style: none; padding-left: 0; }`,
    `.print-toc { page-break-after: always; }`,
    `.print-landscape { page-break-before: always; }`,
  ];
  if (options.includePageNumbers === true) {
    rules.push(
      `.print-page-number { position: fixed; bottom: 24px; right: 24px; font-size: .8em; color: #787774; }`,
    );
  }
  return rules.join("\n");
}

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

const MAX_SLUG = 80;

// Letters/digits kept in a slug: ASCII, Latin extended, Greek, Cyrillic,
// Hebrew, Arabic, Devanagari, Thai, Kana, Hangul and CJK. Everything else
// becomes a separator. (No `u`-flag property escapes, so the module also
// compiles for the project's ES2017 target.)
const SLUG_SEPARATORS =
  /[^a-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]+/g;

function slugify(title: string): string {
  const base = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = base
    .toLowerCase()
    .replace(SLUG_SEPARATORS, "-")
    .replace(/^-+|-+$/g, "");
  const limited = slug.slice(0, MAX_SLUG).replace(/-+$/g, "");
  return limited || "untitled";
}

function toDate(now: Date | number | string | undefined): Date {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (isFiniteNumber(now)) return new Date(now);
  if (typeof now === "string") {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function timestamp(now: Date | number | string | undefined): string {
  const date = toDate(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * A slugified, timestamped download filename: `<slug>-<YYYYMMDD-HHmmss>.<ext>`.
 * The slug falls back to `untitled`, is capped at 80 characters (never ending
 * in a separator), and the extension defaults to `pdf`.
 */
export function exportFilename(
  title: string | null | undefined,
  options: ExportFilenameOptions = {},
): string {
  const slug = slugify(typeof title === "string" ? title : "");
  const rawExt =
    typeof options.ext === "string" && options.ext.trim() !== "" ? options.ext : "pdf";
  const ext = rawExt.trim().replace(/^\.+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "") || "pdf";
  return `${slug}-${timestamp(options.now)}.${ext}`;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * List the binary assets a print/PDF render must embed: every `image` block's
 * source (deduplicated, in document order, with its alt text) and every font
 * family referenced by a block or an inline mark.
 */
export function collectAssets(doc: PrintDoc | null | undefined): CollectedAssets {
  const images: PrintAsset[] = [];
  const seen = new Set<string>();
  const fonts = new Set<string>();

  const visit = (node: RichBlock | null | undefined): void => {
    if (!isObject(node)) return;
    if (node.type === "image") {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      if (src !== "" && !seen.has(src)) {
        seen.add(src);
        images.push({
          src,
          alt: typeof node.attrs?.alt === "string" ? node.attrs.alt : "",
          kind: "image",
        });
      }
    }
    const font = node.attrs?.fontFamily;
    if (typeof font === "string" && font.trim() !== "") fonts.add(font.trim());
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        const markFont = mark?.attrs?.fontFamily;
        if (typeof markFont === "string" && markFont.trim() !== "") fonts.add(markFont.trim());
      }
    }
    if (Array.isArray(node.content)) {
      for (const kid of node.content) visit(kid);
    }
  };

  for (const block of doc?.blocks ?? []) visit(block);

  const fontList = [...fonts].sort();
  return { images, fonts: fontList, count: images.length + fontList.length };
}

// ---------------------------------------------------------------------------
// Markdown fidelity
// ---------------------------------------------------------------------------

/**
 * Report the nested-content features a Markdown export cannot represent:
 * side-by-side `columns`, block content nested inside a table cell (Markdown
 * flattens it), and `embed`/`bookmark`/`pageEmbed` previews that degrade to a
 * plain link. A plain document of text, headings and simple pipe tables is
 * reported lossless.
 */
export function toMarkdownFidelity(doc: PrintDoc | null | undefined): FidelityReport {
  const warnings: FidelityWarning[] = [];

  const visit = (node: RichBlock | null | undefined, path: string): void => {
    if (!isObject(node)) return;
    if (node.type === "columns") {
      warnings.push({
        code: "COLUMNS",
        blockType: "columns",
        message: "Column layout is flattened to sequential content in Markdown.",
        path,
      });
    } else if (node.type === "embed" || node.type === "bookmark") {
      warnings.push({
        code: "EMBED",
        blockType: node.type,
        message: `${node.type} preview is reduced to a plain link in Markdown.`,
        path,
      });
    } else if (node.type === "pageEmbed") {
      warnings.push({
        code: "PAGE_EMBED",
        blockType: "pageEmbed",
        message: "A synced page embed is reduced to a plain link in Markdown.",
        path,
      });
    } else if (node.type === "table") {
      const rows = Array.isArray(node.content) ? node.content : [];
      for (const row of rows) {
        if (!isObject(row)) continue;
        const cells = Array.isArray(row.content) ? row.content : [];
        for (const cell of cells) {
          if (!isObject(cell)) continue;
          const kids = Array.isArray(cell.content) ? cell.content : [];
          const nested = kids.some(
            (kid) => isObject(kid) && typeof kid.type === "string" && kid.type !== "paragraph",
          );
          if (nested) {
            warnings.push({
              code: "TABLE_NESTED",
              blockType: "table",
              message: "A table cell contains block content Markdown flattens to plain text.",
              path,
            });
          }
        }
      }
    }
    if (Array.isArray(node.content)) {
      node.content.forEach((kid, index) => visit(kid, `${path}/${index}`));
    }
  };

  const blocks = doc?.blocks ?? [];
  blocks.forEach((block, index) => visit(block, String(index)));

  return { warnings, lossless: warnings.length === 0 };
}

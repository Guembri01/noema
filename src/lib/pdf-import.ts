/**
 * PDF text-layer import engine (docs/FEATURE_MATRIX.md §12 "Import PDF —
 * text-layer only first"; docs/specs/import-export.md).
 *
 * This module operates on text an upstream extractor already pulled out of a
 * PDF — a page is `{ pageNumber, text, lines? }` and each line may carry `x` /
 * `y` / `size` / `font` layout hints. There is deliberately **no binary
 * parsing and no third-party dependency** here: the job is deterministic,
 * testable structure recovery, not decoding.
 *
 * Pipeline: {@link parsePdfPages} normalises pages, strips page numbers and
 * running headers/footers and joins hyphenated line breaks; {@link
 * columnAwareOrder} reflows two-column pages; {@link detectHeadings} infers
 * `#`/`##`/`###` from size, font and numbering hints; {@link pagesToBlocks}
 * turns lines into editable blocks with a confidence score; {@link assembleDoc}
 * ties it together into `{ title, blocks, warnings }`; {@link describeImport}
 * reports counts. Every function is pure and returns fresh arrays, so callers
 * may run the stages independently.
 */

/** A running header/footer must repeat on at least this fraction of pages. */
export const HEADER_FOOTER_RATIO = 0.6;

/** Maximum length of an inferred document title, before an ellipsis. */
export const MAX_TITLE_LENGTH = 80;

/** Title used when nothing usable could be recovered. */
export const DEFAULT_TITLE = "Imported PDF";

/** A single text line with optional layout hints from the extractor. */
export type PdfLine = {
  text: string;
  /** Left edge in text-space units (points), when the extractor provides it. */
  x?: number;
  /** Top edge in text-space units (points), when the extractor provides it. */
  y?: number;
  /** Font size in points, when the extractor provides it. */
  size?: number;
  /** Font family/name, when the extractor provides it (used for mono/bold). */
  font?: string;
};

/** Raw page from the upstream extractor. */
export type PdfPageInput = {
  /** 1-based page number; defaults to the array index + 1. */
  pageNumber?: number;
  /** Whole-page text; split on line breaks when `lines` is absent. */
  text?: string;
  /** Pre-split lines, either plain strings or objects with layout hints. */
  lines?: ReadonlyArray<string | PdfLine>;
};

/** A normalised page. */
export type PdfPage = {
  pageNumber: number;
  lines: PdfLine[];
};

/** Machine-readable warning emitted anywhere in the pipeline. */
export type PdfWarningCode =
  | "NO_PAGES"
  | "NO_TEXT"
  | "EMPTY_PAGE"
  | "PAGE_NUMBER_STRIPPED"
  | "RUNNING_HEADER_STRIPPED"
  | "RUNNING_FOOTER_STRIPPED"
  | "TWO_COLUMN_ORDERED"
  | "LOW_CONFIDENCE";

export type PdfWarning = {
  code: PdfWarningCode;
  message: string;
  pageNumber?: number;
};

/** Result of {@link parsePdfPages}: normalised pages plus structural warnings. */
export type ParsedPdfPages = {
  pages: PdfPage[];
  warnings: PdfWarning[];
};

/** Heading depth inferred for a line; `0` means "not a heading". */
export type HeadingLevel = 0 | 1 | 2 | 3;

/** An editable document block recovered from the text layer. */
export type PdfBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string; confidence: number }
  | { type: "paragraph"; text: string; confidence: number }
  | { type: "listItem"; ordered: boolean; text: string; confidence: number }
  | { type: "code"; text: string; confidence: number }
  | { type: "table"; rows: string[][]; confidence: number };

/** Assembled result of {@link assembleDoc}. */
export type PdfDocument = {
  title: string;
  blocks: PdfBlock[];
  warnings: PdfWarning[];
};

/** Summary counts returned by {@link describeImport}. */
export type PdfImportSummary = {
  title: string;
  blocks: number;
  headings: number;
  paragraphs: number;
  lists: number;
  code: number;
  tables: number;
  words: number;
  warnings: number;
};

const UNORDERED_MARKER = /^[-*•◦▪‣·–—]\s+/;
const ORDERED_MARKER = /^\d{1,3}[.)]\s+/;
const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)[.)]?\s+\S/;
const PAGE_NUMBER_PATTERNS: readonly RegExp[] = [
  /^\d{1,5}$/,
  /^\d{1,5}\s*\/\s*\d{1,5}$/,
  /^[-–—]\s*\d{1,5}\s*[-–—]$/,
  /^\(\s*\d{1,5}\s*\)$/,
  /^page\s+\d{1,5}(\s*(?:\/|of)\s*\d{1,5})?$/i,
];

const MONO_FONT = /mono|courier|consolas|menlo/i;
const CODE_HINT = /(?:=>|[{}]|\b(?:function|const|let|var|import|export|return|class)\b)/;

/** Trim only the line's trailing whitespace; blank lines are meaningful. */
function normalizeLine(value: string | PdfLine): PdfLine {
  if (typeof value === "string") return { text: value.replace(/\s+$/, "") };
  const out: PdfLine = { text: String(value.text ?? "").replace(/\s+$/, "") };
  if (typeof value.x === "number" && Number.isFinite(value.x)) out.x = value.x;
  if (typeof value.y === "number" && Number.isFinite(value.y)) out.y = value.y;
  if (typeof value.size === "number" && Number.isFinite(value.size)) out.size = value.size;
  if (typeof value.font === "string" && value.font !== "") out.font = value.font;
  return out;
}

function pageNumberFor(raw: PdfPageInput, index: number): number {
  return typeof raw.pageNumber === "number" && Number.isFinite(raw.pageNumber) && raw.pageNumber > 0
    ? Math.floor(raw.pageNumber)
    : index + 1;
}

function linesFor(raw: PdfPageInput): PdfLine[] {
  if (raw.lines) return raw.lines.map(normalizeLine);
  if (typeof raw.text === "string") return raw.text.split(/\r?\n/).map(normalizeLine);
  return [];
}

/** True when a whole line is just a page number ("12", "Page 3 of 9", …). */
function isPageNumber(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && PAGE_NUMBER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Lower-case, whitespace-collapsed, digits-masked key for repeat detection. */
function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** Indices of non-blank lines, in order. */
function nonEmptyIndices(lines: readonly PdfLine[]): number[] {
  const indices: number[] = [];
  lines.forEach((line, index) => {
    if (line.text.trim() !== "") indices.push(index);
  });
  return indices;
}

/** Join a lowercase-hyphenated line break ("inter-" + "national"). */
function joinHyphenatedLines(lines: readonly PdfLine[]): PdfLine[] {
  const out: PdfLine[] = [];
  let i = 0;
  while (i < lines.length) {
    let current = lines[i];
    while (
      /[A-Za-z]-$/.test(current.text) &&
      i + 1 < lines.length &&
      /^[a-z]/.test(lines[i + 1].text.trimStart())
    ) {
      current = { ...current, text: current.text.slice(0, -1) + lines[i + 1].text.trimStart() };
      i += 1;
    }
    out.push(current);
    i += 1;
  }
  return out;
}

type RunningEntry = { text: string; count: number };

/** Keys that repeat in a page zone on ≥60% of pages (and on ≥2 pages). */
function collectRunning(pages: readonly PdfPage[], zone: "header" | "footer"): Map<string, RunningEntry> {
  const order: string[] = [];
  const byKey = new Map<string, RunningEntry>();
  const seen = new Map<string, Set<number>>();
  for (let p = 0; p < pages.length; p += 1) {
    const indices = nonEmptyIndices(pages[p].lines);
    const zoneCount = indices.length <= 3 ? 1 : 2;
    const picked = zone === "header" ? indices.slice(0, zoneCount) : indices.slice(-zoneCount);
    for (const index of picked) {
      const raw = pages[p].lines[index].text;
      const key = normalizeKey(raw);
      if (key === "") continue;
      let pagesWithKey = seen.get(key);
      if (!pagesWithKey) {
        pagesWithKey = new Set<number>();
        seen.set(key, pagesWithKey);
      }
      if (pagesWithKey.has(p)) continue;
      pagesWithKey.add(p);
      const entry = byKey.get(key);
      if (entry) entry.count += 1;
      else {
        byKey.set(key, { text: raw.trim(), count: 1 });
        order.push(key);
      }
    }
  }
  const running = new Map<string, RunningEntry>();
  for (const key of order) {
    const entry = byKey.get(key);
    if (entry && entry.count >= 2 && entry.count / pages.length >= HEADER_FOOTER_RATIO) {
      running.set(key, entry);
    }
  }
  return running;
}

function stripRunning(
  pages: readonly PdfPage[],
  headerKeys: ReadonlySet<string>,
  footerKeys: ReadonlySet<string>,
): PdfPage[] {
  return pages.map((page) => {
    const indices = nonEmptyIndices(page.lines);
    const zoneCount = indices.length <= 3 ? 1 : 2;
    const headerIndices = new Set(indices.slice(0, zoneCount));
    const footerIndices = new Set(indices.slice(-zoneCount));
    const lines = page.lines.filter((line, index) => {
      const key = normalizeKey(line.text);
      if (headerKeys.has(key) && headerIndices.has(index)) return false;
      if (footerKeys.has(key) && footerIndices.has(index)) return false;
      return true;
    });
    return { pageNumber: page.pageNumber, lines };
  });
}

/**
 * Normalise raw extractor pages: number pages, split text into lines, strip
 * page-number-only lines, remove running headers/footers repeating on ≥60% of
 * pages, and join hyphenated line breaks. Returns the pages plus warnings for
 * everything structural that was dropped.
 */
export function parsePdfPages(input: readonly PdfPageInput[]): ParsedPdfPages {
  const warnings: PdfWarning[] = [];
  let pages: PdfPage[] = input.map((raw, index) => ({
    pageNumber: pageNumberFor(raw, index),
    lines: linesFor(raw),
  }));

  let strippedNumbers = 0;
  pages = pages.map((page) => ({
    pageNumber: page.pageNumber,
    lines: page.lines.filter((line) => {
      if (isPageNumber(line.text)) {
        strippedNumbers += 1;
        return false;
      }
      return true;
    }),
  }));
  if (strippedNumbers > 0) {
    warnings.push({
      code: "PAGE_NUMBER_STRIPPED",
      message: `Stripped ${strippedNumbers} page-number line(s).`,
    });
  }

  if (pages.length >= 2) {
    const headers = collectRunning(pages, "header");
    const footers = collectRunning(pages, "footer");
    if (headers.size > 0 || footers.size > 0) {
      pages = stripRunning(pages, new Set(headers.keys()), new Set(footers.keys()));
    }
    for (const entry of headers.values()) {
      warnings.push({
        code: "RUNNING_HEADER_STRIPPED",
        message: `Removed running header "${entry.text}" (${entry.count}/${pages.length} pages).`,
      });
    }
    for (const entry of footers.values()) {
      warnings.push({
        code: "RUNNING_FOOTER_STRIPPED",
        message: `Removed running footer "${entry.text}" (${entry.count}/${pages.length} pages).`,
      });
    }
  }

  pages = pages.map((page) => ({
    pageNumber: page.pageNumber,
    lines: joinHyphenatedLines(page.lines),
  }));

  for (const page of pages) {
    if (nonEmptyIndices(page.lines).length === 0) {
      warnings.push({
        code: "EMPTY_PAGE",
        message: `Page ${page.pageNumber} produced no text.`,
        pageNumber: page.pageNumber,
      });
    }
  }

  return { pages, warnings };
}

type HeadingSignal = { level: HeadingLevel; confidence: number };

/** Most frequent rounded font size (ties resolve to the smaller size). */
function bodyFontSize(lines: readonly PdfLine[]): number | undefined {
  const counts = new Map<number, number>();
  for (const line of lines) {
    if (line.text.trim() !== "" && typeof line.size === "number" && Number.isFinite(line.size)) {
      const size = Math.round(line.size);
      counts.set(size, (counts.get(size) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return ranked[0][0];
}

/** Map of font size → heading level for sizes larger than the body size. */
function sizeLevels(lines: readonly PdfLine[], body: number | undefined): Map<number, HeadingLevel> {
  const levels = new Map<number, HeadingLevel>();
  if (body === undefined) return levels;
  const sizes = new Set<number>();
  for (const line of lines) {
    if (line.text.trim() !== "" && typeof line.size === "number" && Number.isFinite(line.size)) {
      sizes.add(Math.round(line.size));
    }
  }
  [...sizes]
    .filter((size) => size > body)
    .sort((a, b) => b - a)
    .forEach((size, index) => levels.set(size, Math.min(index + 1, 3) as HeadingLevel));
  return levels;
}

/** Indices that belong to a consecutive run of ≥2 ordered-list lines. */
function orderedRunIndices(lines: readonly PdfLine[]): Set<number> {
  const inRun = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    if (ORDERED_MARKER.test(lines[i].text.trim())) {
      let j = i;
      while (j + 1 < lines.length && ORDERED_MARKER.test(lines[j + 1].text.trim())) j += 1;
      if (j > i) for (let k = i; k <= j; k += 1) inRun.add(k);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return inRun;
}

function headingSignal(
  lines: readonly PdfLine[],
  index: number,
  body: number | undefined,
  sizeRank: ReadonlyMap<number, HeadingLevel>,
  orderedRun: ReadonlySet<number>,
): HeadingSignal {
  const text = lines[index].text.trim();
  if (text === "") return { level: 0, confidence: 0 };
  if (UNORDERED_MARKER.test(text)) return { level: 0, confidence: 0 };
  if (ORDERED_MARKER.test(text) && orderedRun.has(index)) return { level: 0, confidence: 0 };

  const size = lines[index].size;
  if (body !== undefined && typeof size === "number" && Number.isFinite(size)) {
    const level = sizeRank.get(Math.round(size));
    if (level) return { level, confidence: 0.95 };
  }

  const numbered = text.match(NUMBERED_HEADING);
  if (numbered) {
    const depth = numbered[1].split(".").length;
    return { level: Math.min(depth, 3) as HeadingLevel, confidence: 0.9 };
  }

  const font = lines[index].font;
  if (typeof font === "string" && /bold/i.test(font) && text.length <= MAX_TITLE_LENGTH && !/[.,;:!?]$/.test(text)) {
    return { level: 3, confidence: 0.6 };
  }

  return { level: 0, confidence: 0 };
}

function analyzeHeadings(lines: readonly PdfLine[]): HeadingSignal[] {
  const body = bodyFontSize(lines);
  const sizeRank = sizeLevels(lines, body);
  const orderedRun = orderedRunIndices(lines);
  return lines.map((_, index) => headingSignal(lines, index, body, sizeRank, orderedRun));
}

/**
 * Infer heading levels for each line from size/font hints or numbering
 * patterns. Returns an array parallel to `lines`; `0` marks body text (and
 * every bullet or ordered-list-run member, so lists are never headings).
 */
export function detectHeadings(lines: readonly PdfLine[]): HeadingLevel[] {
  return analyzeHeadings(lines).map((signal) => signal.level);
}

/** Split a line into table cells on `|` or a run of 2+ spaces, else `null`. */
function splitTableRow(text: string): string[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.includes("|")) {
    const cells = trimmed.split("|").map((cell) => cell.trim());
    const cleaned = cells.filter(
      (cell, index) => !(cell === "" && (index === 0 || index === cells.length - 1)),
    );
    if (cleaned.length >= 2) return cleaned;
  }
  const parts = trimmed
    .split(/\s{2,}/)
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
  return parts.length >= 2 ? parts : null;
}

function isMono(line: PdfLine): boolean {
  return typeof line.font === "string" && MONO_FONT.test(line.font);
}

function isCodeLine(line: PdfLine): boolean {
  if (isMono(line)) return true;
  const text = line.text.trim();
  return text.length >= 4 && CODE_HINT.test(text);
}

function paragraphConfidence(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  return /[.!?]$/.test(text) || words.length >= 6 ? 0.9 : 0.65;
}

/**
 * Convert normalised pages into editable blocks (`heading` / `paragraph` /
 * `listItem` / `code` / `table`), each carrying a confidence score in `[0, 1]`.
 * Consecutive body lines merge into one paragraph until a blank line or a
 * different block type interrupts them.
 */
export function pagesToBlocks(pages: readonly PdfPage[]): PdfBlock[] {
  const blocks: PdfBlock[] = [];

  for (const page of pages) {
    const signals = analyzeHeadings(page.lines);
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length === 0) return;
      const text = paragraph.join(" ").trim();
      if (text !== "") {
        blocks.push({ type: "paragraph", text, confidence: paragraphConfidence(text) });
      }
      paragraph = [];
    };

    let i = 0;
    while (i < page.lines.length) {
      const text = page.lines[i].text.trim();
      if (text === "") {
        flush();
        i += 1;
        continue;
      }

      const signal = signals[i];
      if (signal.level > 0) {
        const level: 1 | 2 | 3 = signal.level === 0 ? 1 : signal.level;
        flush();
        blocks.push({ type: "heading", level, text, confidence: signal.confidence });
        i += 1;
        continue;
      }

      if (UNORDERED_MARKER.test(text)) {
        flush();
        blocks.push({ type: "listItem", ordered: false, text: text.replace(UNORDERED_MARKER, "").trim(), confidence: 0.9 });
        i += 1;
        continue;
      }

      if (ORDERED_MARKER.test(text)) {
        flush();
        blocks.push({ type: "listItem", ordered: true, text: text.replace(ORDERED_MARKER, "").trim(), confidence: 0.9 });
        i += 1;
        continue;
      }

      if (isCodeLine(page.lines[i])) {
        flush();
        const codeLines: string[] = [text];
        let mono = isMono(page.lines[i]);
        i += 1;
        while (i < page.lines.length && isCodeLine(page.lines[i])) {
          codeLines.push(page.lines[i].text.trim());
          mono = mono || isMono(page.lines[i]);
          i += 1;
        }
        blocks.push({ type: "code", text: codeLines.join("\n"), confidence: mono ? 0.7 : 0.55 });
        continue;
      }

      const row = splitTableRow(page.lines[i].text);
      if (row) {
        const rows: string[][] = [row];
        let j = i + 1;
        while (j < page.lines.length) {
          const next = splitTableRow(page.lines[j].text);
          if (next && next.length === row.length) {
            rows.push(next);
            j += 1;
          } else {
            break;
          }
        }
        if (rows.length >= 2) {
          flush();
          const consistent = rows.every((candidate) => candidate.length === rows[0].length);
          blocks.push({ type: "table", rows, confidence: consistent ? 0.6 : 0.45 });
          i = j;
          continue;
        }
      }

      paragraph.push(text);
      i += 1;
    }
    flush();
  }

  return blocks;
}

function xOf(line: PdfLine, fallback: number): number {
  return typeof line.x === "number" && Number.isFinite(line.x) ? line.x : fallback;
}

/**
 * Reorder page lines for reading order. When `x` hints describe two columns
 * (separated by a gap of at least `threshold` × the page's horizontal span and
 * each column holding ≥2 lines) the left column is returned before the right;
 * otherwise the input order is preserved. Stable within each column and pure.
 */
export function columnAwareOrder(
  lines: readonly PdfLine[],
  options: { threshold?: number } = {},
): PdfLine[] {
  const threshold = options.threshold ?? 0.4;
  const hinted = lines.filter(
    (line) => typeof line.x === "number" && Number.isFinite(line.x),
  );
  if (hinted.length < 2) return [...lines];

  const xs = [...new Set(hinted.map((line) => line.x as number))].sort((a, b) => a - b);
  const span = xs[xs.length - 1] - xs[0];
  if (span <= 0) return [...lines];

  let bestGap = 0;
  let cut = 0;
  for (let i = 0; i + 1 < xs.length; i += 1) {
    const gap = xs[i + 1] - xs[i];
    if (gap > bestGap) {
      bestGap = gap;
      cut = (xs[i] + xs[i + 1]) / 2;
    }
  }
  if (bestGap / span < threshold) return [...lines];

  const min = xs[0];
  const left = lines.filter((line) => xOf(line, min) < cut);
  const right = lines.filter((line) => xOf(line, min) >= cut);
  if (left.length < 2 || right.length < 2) return [...lines];
  return [...left, ...right];
}

function truncateTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;
  const cut = trimmed.slice(0, MAX_TITLE_LENGTH);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

function inferTitle(blocks: readonly PdfBlock[]): string {
  const heading = blocks.find((block) => block.type === "heading");
  if (heading && heading.type === "heading") return truncateTitle(heading.text);
  const paragraph = blocks.find((block) => block.type === "paragraph");
  if (paragraph && paragraph.type === "paragraph") return truncateTitle(paragraph.text);
  return DEFAULT_TITLE;
}

/**
 * Assemble a raw extractor payload into `{ title, blocks, warnings }`: parse
 * and clean the pages, reflow two-column pages, convert to blocks, infer a
 * title and surface every structural caveat.
 */
export function assembleDoc(input: readonly PdfPageInput[]): PdfDocument {
  if (input.length === 0) {
    return {
      title: DEFAULT_TITLE,
      blocks: [],
      warnings: [{ code: "NO_PAGES", message: "No pages were provided to import." }],
    };
  }

  const parsed = parsePdfPages(input);
  const warnings: PdfWarning[] = [...parsed.warnings];

  const prepared = parsed.pages.map((page) => {
    const reordered = columnAwareOrder(page.lines);
    const changed = reordered.some((line, index) => line !== page.lines[index]);
    if (changed) {
      warnings.push({
        code: "TWO_COLUMN_ORDERED",
        message: `Reordered page ${page.pageNumber} as two columns.`,
        pageNumber: page.pageNumber,
      });
    }
    return { pageNumber: page.pageNumber, lines: reordered };
  });

  const blocks = pagesToBlocks(prepared);

  if (blocks.length === 0) {
    warnings.push({ code: "NO_TEXT", message: "No text layer was recovered from the input." });
  } else {
    const lowConfidence = blocks.filter((block) => block.confidence < 0.6).length;
    if (lowConfidence > 0) {
      warnings.push({
        code: "LOW_CONFIDENCE",
        message: `${lowConfidence} block(s) imported with low confidence.`,
      });
    }
  }

  return { title: inferTitle(blocks), blocks, warnings };
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Summarise an assembled import: counts per block type, words and warnings. */
export function describeImport(result: {
  title: string;
  blocks: readonly PdfBlock[];
  warnings: readonly PdfWarning[];
}): PdfImportSummary {
  const summary: PdfImportSummary = {
    title: result.title,
    blocks: result.blocks.length,
    headings: 0,
    paragraphs: 0,
    lists: 0,
    code: 0,
    tables: 0,
    words: 0,
    warnings: result.warnings.length,
  };

  for (const block of result.blocks) {
    switch (block.type) {
      case "heading":
        summary.headings += 1;
        summary.words += countWords(block.text);
        break;
      case "paragraph":
        summary.paragraphs += 1;
        summary.words += countWords(block.text);
        break;
      case "listItem":
        summary.lists += 1;
        summary.words += countWords(block.text);
        break;
      case "code":
        summary.code += 1;
        summary.words += countWords(block.text);
        break;
      case "table":
        summary.tables += 1;
        summary.words += block.rows.flat().reduce((total, cell) => total + countWords(cell), 0);
        break;
    }
  }

  return summary;
}

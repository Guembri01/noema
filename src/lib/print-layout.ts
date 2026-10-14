/**
 * Print / PDF layout pagination: the pure geometry behind "Export PDF"
 * (docs/specs/import-export.md; FEATURE_MATRIX "Export PDF" :489).
 *
 * `pdf.ts` asks pdfkit to flow text and lets it decide where columns end; that
 * is fine for a one-column text dump but leaves no way to reason about *where*
 * a page breaks, keep a heading with its paragraph, or stop a list from being
 * orphaned at the foot of a page. This module adds that missing layer: the
 * caller measures each block (or lets `estimateBlockHeight` estimate it),
 * `paginateBlocks` returns the pages and per-block `y` offsets, and a renderer
 * draws each page into its own PDF page at those offsets.
 *
 * Everything here is pure and deterministic — no pdfkit, no React, no DB — so
 * the break policy can be unit-tested without producing a single byte of PDF.
 * All input is normalised at the boundary: a malformed block or a non-finite
 * option degrades to a sensible default instead of throwing.
 *
 * The rules, in one place:
 *
 * - **Keep-together** (`applyBreakRules`): a `heading` never ends a page — it
 *   travels with the block that follows it; a list (`bulletList`,
 *   `orderedList`, `taskList`) or `blockquote` never starts a page apart from
 *   the block that introduces it.
 * - **No break inside an over-tall block**: a block taller than the page's
 *   content box is placed alone on its own page (`oversized`), flushing and
 *   closing the pages around it.
 * - A keep-together pair is honoured only while the group fits in one content
 *   box; a group taller than a page cannot be kept together, so it falls back
 *   to ordinary flow.
 */

/** Default page height in device-independent pixels (11in at 96dpi). */
export const DEFAULT_PAGE_HEIGHT = 1056;
/** Default top margin in device-independent pixels (0.75in). */
export const DEFAULT_MARGIN_TOP = 72;

/** Height of one wrapped line of body text. */
export const LINE_HEIGHT = 24;
/** Vertical gap after a block, before the next one. */
export const BLOCK_SPACING = 12;
/** Height of one line inside a code block. */
export const CODE_LINE_HEIGHT = 18;
/** Characters per line used to estimate wrapping. */
export const CHARS_PER_LINE = 72;

const HEADING_BASE = { h1: 40, h2: 32, h3: 26 } as const;
const QUOTE_PADDING = 16;
const CODE_PADDING = 24;
const ROW_HEIGHT = 32;
const DIVIDER_HEIGHT = 8;
const CALLOUT_PADDING = 24;
const DEFAULT_IMAGE_HEIGHT = 240;

/** List block types that must not be orphaned from their lead-in. */
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

/** The minimal, measured shape a paginator needs for one block. */
export type PrintBlock = {
  /** Stable block id; used to map a placement back to its source block. */
  id: string;
  /** Block type (e.g. `paragraph`, `heading`, `bulletList`). */
  type: string;
  /** Measured height in device-independent pixels. */
  height: number;
};

/** Page geometry: a page is `pageHeight` tall, content starts `marginTop` in. */
export type PrintLayoutOptions = {
  pageHeight?: number;
  marginTop?: number;
};

/** Where one block lands on its page. */
export type PageBlock = {
  id: string;
  type: string;
  height: number;
  /** Top offset from the start of the page's content box. */
  y: number;
  /** Zero-based page index this block was placed on. */
  page: number;
  /** True when the block is taller than the page's content box. */
  oversized: boolean;
};

/** One laid-out page. */
export type PrintPage = {
  /** Zero-based index, in document order. */
  index: number;
  /** Blocks on this page, in document order, with resolved `y` offsets. */
  blocks: PageBlock[];
  /** Sum of the placed block heights. */
  used: number;
  /** Unused content-box height (`contentHeight - used`, never negative). */
  remaining: number;
  /** The content-box height every page shares (`pageHeight - marginTop`). */
  contentHeight: number;
};

/** Input to `estimateBlockHeight`: a block known by shape, not yet measured. */
export type BlockHeightInput = {
  type: string;
  /** Plain text, used to estimate wrapped lines. */
  text?: string;
  /** Item/row count for lists and tables. */
  count?: number;
  /** Heading level (1 is largest). */
  level?: number;
  /** Explicit pixel height for media, e.g. an image's aspect-scaled height. */
  height?: number;
};

function isFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The usable content-box height shared by every page: `pageHeight - marginTop`.
 *
 * Total on any input — a missing/non-finite `pageHeight` or `marginTop` falls
 * back to the defaults, a negative margin clamps to `0`, and a margin larger
 * than the page clamps to the page so the result is never negative.
 */
export function pageContentHeight(options: PrintLayoutOptions = {}): number {
  const pageHeight =
    isFinite(options.pageHeight) && options.pageHeight > 0
      ? options.pageHeight
      : DEFAULT_PAGE_HEIGHT;
  let marginTop = isFinite(options.marginTop) ? options.marginTop : DEFAULT_MARGIN_TOP;
  if (marginTop < 0) marginTop = 0;
  if (marginTop > pageHeight) marginTop = pageHeight;
  return pageHeight - marginTop;
}

/** Wrapped-line count for a text run: explicit newlines plus soft wrapping. */
function estimateLines(text: string): number {
  if (text === "") return 1;
  let lines = 0;
  for (const raw of text.split("\n")) {
    lines += Math.max(1, Math.ceil(raw.length / CHARS_PER_LINE));
  }
  return lines;
}

/** A positive item/row count, or `1` for anything missing or malformed. */
function positiveCount(value: number | undefined): number {
  return isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

/**
 * Estimate a block's rendered height from its shape alone.
 *
 * This is the measurement step `paginateBlocks` consumes when a caller has no
 * real layout pass: text wraps at `CHARS_PER_LINE`, headings are ranked by
 * level, lists/tables scale with `count`, code uses the tighter
 * `CODE_LINE_HEIGHT`, and images use an explicit `height` (or a default).
 * Unknown types degrade to a paragraph so a new block type never measures as
 * zero. Deterministic for a given input.
 */
export function estimateBlockHeight(block: BlockHeightInput): number {
  const type = typeof block?.type === "string" ? block.type : "";
  const text = typeof block?.text === "string" ? block.text : "";
  const lines = estimateLines(text);
  switch (type) {
    case "heading": {
      const level = block.level;
      const base =
        isFinite(level) && level <= 1
          ? HEADING_BASE.h1
          : isFinite(level) && level === 2
            ? HEADING_BASE.h2
            : HEADING_BASE.h3;
      return base + BLOCK_SPACING;
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
      return positiveCount(block.count) * LINE_HEIGHT + BLOCK_SPACING;
    case "blockquote":
      return lines * LINE_HEIGHT + BLOCK_SPACING + QUOTE_PADDING;
    case "codeBlock":
      return lines * CODE_LINE_HEIGHT + BLOCK_SPACING + CODE_PADDING;
    case "table":
      return positiveCount(block.count) * ROW_HEIGHT + BLOCK_SPACING;
    case "image":
      return (isFinite(block.height) && block.height > 0 ? block.height : DEFAULT_IMAGE_HEIGHT) +
        BLOCK_SPACING;
    case "horizontalRule":
    case "divider":
      return DIVIDER_HEIGHT + BLOCK_SPACING;
    case "callout":
      return lines * LINE_HEIGHT + BLOCK_SPACING + CALLOUT_PADDING;
    default:
      return lines * LINE_HEIGHT + BLOCK_SPACING;
  }
}

function typeOf(block: PrintBlock | null | undefined): string {
  return block && typeof block.type === "string" ? block.type : "";
}

/**
 * Decide whether a page break is forbidden between two consecutive blocks.
 *
 * Returns `true` when `prev` and `next` must share a page (a break between
 * them would violate a keep-together rule) and `false` when a break is allowed.
 * The policy:
 *
 * - a `heading` keeps with the block that follows it;
 * - a list or `blockquote` keeps with the block that precedes it, so it is
 *   never orphaned at the top of a page away from its lead-in.
 *
 * Missing or unknown blocks fail open (`false`) — an unrecognised node never
 * silently glues two pages together.
 */
export function applyBreakRules(
  prev: PrintBlock | null | undefined,
  next: PrintBlock | null | undefined,
): boolean {
  const prevType = typeOf(prev);
  const nextType = typeOf(next);
  if (prevType === "heading") return true;
  if (LIST_TYPES.has(nextType) || nextType === "blockquote") return true;
  return false;
}

/** Coerce a raw block to a measured one, dropping non-objects and garbage. */
function normalizeBlocks(blocks: readonly PrintBlock[] | null | undefined): PrintBlock[] {
  if (!Array.isArray(blocks)) return [];
  const out: PrintBlock[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const height = isFinite(raw.height) && raw.height > 0 ? raw.height : 0;
    out.push({
      id: typeof raw.id === "string" ? raw.id : "",
      type: typeof raw.type === "string" ? raw.type : "",
      height,
    });
  }
  return out;
}

type PageState = { blocks: PageBlock[]; used: number };

/** Turn the in-progress page state into a finished `PrintPage`. */
function finishPage(index: number, state: PageState, contentHeight: number): PrintPage {
  return {
    index,
    blocks: state.blocks,
    used: state.used,
    remaining: Math.max(0, contentHeight - state.used),
    contentHeight,
  };
}

/**
 * Flow measured blocks into pages.
 *
 * Greedy and deterministic: blocks are placed in order until the content box
 * fills, then a new page starts. Before a break, `applyBreakRules` is consulted
 * so a heading travels with its following block and a list/quote travels with
 * its lead-in; such runs are treated as one atomic group and moved together
 * when they do not fit. A block taller than the content box is placed alone on
 * its own page (`oversized`) with the pages around it flushed and closed, which
 * is the "no break inside an over-tall block" rule.
 *
 * An empty input yields no pages. Every input is normalised first, so a
 * negative, `NaN` or infinite height counts as `0` rather than throwing.
 */
export function paginateBlocks(
  blocks: readonly PrintBlock[] | null | undefined,
  options: PrintLayoutOptions = {},
): PrintPage[] {
  const contentHeight = pageContentHeight(options);
  const normalized = normalizeBlocks(blocks);
  const pages: PrintPage[] = [];
  let current: PageState | null = null;

  const ensure = (): PageState => {
    if (!current) current = { blocks: [], used: 0 };
    return current;
  };
  const flush = (): void => {
    if (current && current.blocks.length > 0) {
      pages.push(finishPage(pages.length, current, contentHeight));
    }
    current = null;
  };

  let i = 0;
  while (i < normalized.length) {
    const block = normalized[i];

    if (block.height > contentHeight) {
      // Over-tall: close whatever is open, then give this block a page alone.
      flush();
      const index = pages.length;
      const placement: PageBlock = {
        id: block.id,
        type: block.type,
        height: block.height,
        y: 0,
        page: index,
        oversized: true,
      };
      pages.push(finishPage(index, { blocks: [placement], used: block.height }, contentHeight));
      current = null;
      i += 1;
      continue;
    }

    // Grow the keep-together group while the pair stays glued *and* fits one page.
    const group: PrintBlock[] = [block];
    let groupHeight = block.height;
    let j = i;
    while (
      j + 1 < normalized.length &&
      applyBreakRules(normalized[j], normalized[j + 1]) &&
      normalized[j + 1].height <= contentHeight &&
      groupHeight + normalized[j + 1].height <= contentHeight
    ) {
      groupHeight += normalized[j + 1].height;
      group.push(normalized[j + 1]);
      j += 1;
    }

    const open = ensure();
    if (open.blocks.length > 0 && open.used + groupHeight > contentHeight) {
      flush();
    }
    const target = ensure();
    for (const member of group) {
      target.blocks.push({
        id: member.id,
        type: member.type,
        height: member.height,
        y: target.used,
        page: pages.length,
        oversized: false,
      });
      target.used += member.height;
    }
    i = j + 1;
  }

  flush();
  return pages;
}

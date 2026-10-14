/**
 * Page description / teaser (MISSING_FEATURES §1).
 *
 * Derives a short, plain-text summary from a page's blocks so previews and
 * search results can show a snippet without embedding the editor or the DB.
 * Everything here is pure and structural: it reads the minimal block shape
 * (`{ type, text?, children?, marks? }`), tolerates unknown/future node types,
 * and never throws on junk.
 *
 * Not to be confused with `description.ts`, which normalises the *authored*
 * description doc (`Ticket.description`). This module only *reads* blocks and
 * produces a teaser; it writes nothing.
 */

/** Minimal block shape the summariser understands (extra keys are ignored). */
export type SummaryBlock = {
  type?: string;
  text?: string;
  children?: unknown[];
  marks?: unknown[];
};

export type SummarizeOptions = {
  /** Longest teaser to return, including the trailing ellipsis. Default 160. */
  maxLength?: number;
  /**
   * Block types to leave out entirely. Default `["code", "image", "divider"]`.
   * App aliases are normalised, so `codeBlock` and `horizontalRule` are
   * skipped by the defaults too.
   */
  skipTypes?: readonly string[];
};

/** Defaults, exported so callers and tests share one source of truth. */
export const DEFAULT_SUMMARY_LENGTH = 160;
export const DEFAULT_SKIP_TYPES = ["code", "image", "divider"] as const;

/** Shortest text that reads as a description rather than noise. */
export const MIN_DESCRIPTION_LENGTH = 8;

/**
 * Inline (text-carrying) node types. Anything else with children counts as a
 * block, so nested blocks (e.g. a paragraph inside a quote) stay separate.
 */
const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "br",
  "bold",
  "strong",
  "italic",
  "em",
  "strike",
  "del",
  "link",
  "underline",
  "highlight",
  "mark",
  "mention",
  "inlineMath",
  "ref",
]);

/** The app's block type names for the concept-level defaults. */
const TYPE_ALIASES: Record<string, string> = {
  codeBlock: "code",
  horizontalRule: "divider",
  hr: "divider",
};

function normalizeType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

function isNode(value: unknown): value is SummaryBlock {
  return !!value && typeof value === "object";
}

/** A node with a non-inline `type` is treated as a block (boundary + skippable). */
function isBlockNode(node: SummaryBlock): boolean {
  return typeof node.type === "string" && node.type !== "" && !INLINE_TYPES.has(node.type);
}

/** Collapse every whitespace run (spaces, tabs, newlines) to a single space. */
export function collapseWhitespace(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Collect a node's text. Inline children are concatenated verbatim (so a word
 * split across marks does not gain a space); nested block children are fenced
 * with newlines so their boundary survives the later whitespace collapse.
 */
function flattenNode(node: SummaryBlock, skip: ReadonlySet<string>, out: string[]): void {
  if (isBlockNode(node) && skip.has(normalizeType(node.type as string))) return;

  if (typeof node.text === "string") out.push(node.text);

  if (!Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (!isNode(child)) continue;
    if (isBlockNode(child)) {
      out.push("\n");
      flattenNode(child, skip, out);
      out.push("\n");
    } else {
      flattenNode(child, skip, out);
    }
  }
}

/** Plain text of one node, whitespace collapsed. */
function nodeText(node: SummaryBlock, skip: ReadonlySet<string>): string {
  const out: string[] = [];
  flattenNode(node, skip, out);
  return collapseWhitespace(out.join(""));
}

/**
 * Plain-text teaser for a page: block texts joined in document order, with
 * whitespace collapsed and configured block types omitted. Truncates at a word
 * boundary and appends `…` only when the text is longer than `maxLength`.
 */
export function summarizeBlocks(
  blocks: readonly SummaryBlock[] | null | undefined,
  options: SummarizeOptions = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_SUMMARY_LENGTH;
  const skip = new Set((options.skipTypes ?? DEFAULT_SKIP_TYPES).map(normalizeType));

  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (!isNode(block)) continue;
    if (isBlockNode(block) && skip.has(normalizeType(block.type as string))) continue;
    const text = nodeText(block, skip);
    if (text) parts.push(text);
  }

  return truncateAtWord(collapseWhitespace(parts.join("\n")), maxLength);
}

/**
 * Truncate `text` to at most `max` characters at a word boundary, appending a
 * single `…` only when something was actually dropped. Text of exactly `max`
 * characters (or less) is returned unchanged, so the ellipsis always means a
 * cut happened.
 */
export function truncateAtWord(text: string, max: number): string {
  const value = text ?? "";
  if (max <= 0) return "";
  if (value.length <= max) return value;

  const budget = max - 1; // one slot reserved for `…`
  if (budget <= 0) return "…";

  const slice = value.slice(0, budget);
  const lastBreak = Math.max(
    slice.lastIndexOf(" "),
    slice.lastIndexOf("\t"),
    slice.lastIndexOf("\n"),
  );
  const cut = (lastBreak > 0 ? slice.slice(0, lastBreak) : slice).trim();
  return cut ? `${cut}…` : "…";
}

/** Depth-first search for the first paragraph that yields non-empty text. */
function firstParagraph(node: SummaryBlock, skip: ReadonlySet<string>): string | null {
  if (node.type === "paragraph") {
    const text = nodeText(node, skip);
    return text || null;
  }
  if (!Array.isArray(node.children)) return null;
  for (const child of node.children) {
    if (!isNode(child)) continue;
    const found = firstParagraph(child, skip);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The page's description: the text of the first non-empty paragraph, or `null`
 * when the page has no paragraph with any content. Headings and other block
 * types are intentionally not eligible.
 */
export function extractDescription(
  blocks: readonly SummaryBlock[] | null | undefined,
): string | null {
  const skip: ReadonlySet<string> = new Set();
  for (const block of blocks ?? []) {
    if (!isNode(block)) continue;
    const found = firstParagraph(block, skip);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Heuristic: is this text substantial enough to show as a description?
 * Rejects empty/whitespace-only text, text shorter than
 * `MIN_DESCRIPTION_LENGTH`, letter-less strings (bare numbers, punctuation)
 * and lone URLs.
 */
export function isLikelyDescriptionWorthy(text: string): boolean {
  const clean = collapseWhitespace(text);
  if (clean.length < MIN_DESCRIPTION_LENGTH) return false;
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(clean)) return false;
  if (!/\p{L}/u.test(clean)) return false;
  return true;
}

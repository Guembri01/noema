/**
 * Markdown for AI output.
 *
 * Two pure, dependency-free halves:
 *   • `parseMarkdown`  — Markdown/GFM subset → a typed AST
 *   • `markdownToTipTap` — the same AST → TipTap/ProseMirror JSON
 *
 * Nothing here ever produces HTML strings, so answers can be rendered with
 * React elements only (no `dangerouslySetInnerHTML`, therefore no XSS surface).
 * `safeHref` is the single gate for link targets.
 *
 * Supported: headings, paragraphs, hard breaks, bold, italic, strikethrough,
 * inline code, fenced code, blockquotes, ordered/unordered/task lists with
 * nesting, GFM tables, horizontal rules, links, autolinks and bare URLs, plus
 * the app's `[[page:<id>|Title]]` note references.
 *
 * Import/export fidelity (MISSING_FEATURES §12/§1) adds the reverse
 * directions as further dependency-free halves:
 *   • `parseFrontmatter` — YAML-ish `---` head of a `.md` file → typed data
 *   • `blocksToMarkdown` / `selectionToMarkdown` / `blocksToMarkdownTree` —
 *     editor blocks → Markdown (nested content, copy, subpage export)
 *
 * Optional block variants survive the round trip too, reusing the editor's own
 * conventions rather than forking them: a pull quote is a blockquote carrying
 * `size: "large"` (see `pull-quote.ts`), and a code block may carry
 * `lineNumbers` / `caption` (see `code-block.ts`, whose `formatCaption`
 * normalises the text).
 */

import { formatCaption } from "./code-block";
import { DEFAULT_PULL_QUOTE_SIZE, isPullQuoteSize } from "./pull-quote";
import type { PullQuoteSize } from "./pull-quote";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "ref"; pageId: string; title: string }
  | { type: "br" };

export type ListItem = {
  content: Inline[];
  checked: boolean | null;
  children: ListBlock[];
};

export type ListBlock = { type: "list"; ordered: boolean; items: ListItem[] };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: Inline[] }
  | { type: "paragraph"; content: Inline[] }
  | { type: "code"; lang: string | null; value: string; lineNumbers?: boolean; caption?: string }
  | { type: "quote"; blocks: Block[]; size?: PullQuoteSize }
  | ListBlock
  | { type: "table"; align: (("left" | "center" | "right") | null)[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "hr" }
  | { type: "image"; src: string; alt: string; caption: string | null };

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Allow only hrefs we would happily follow; block `javascript:`, `data:`… */
export function safeHref(href: string): string | null {
  // B59/H2: mirror WHATWG URL normalisation first - control characters (tab,
  // LF and CR are stripped from inside schemes before parsing) go away, then
  // the ends are trimmed, so `java\nscript:` is seen as `javascript:` and
  // rejected. Protocol-relative `//host` (and its `\\` twin) is rejected too.
  const value = (href ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value) return null;
  if (/^[\\/]{2}/.test(value)) return null;
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (/^[/#]/.test(value)) return value; // relative or in-page
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
  return null;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const INLINE_RULES: {
  type: Inline["type"];
  re: RegExp;
  build: (match: RegExpExecArray) => Inline | null;
}[] = [
  {
    type: "code",
    re: /^`([^`]+)`/,
    build: (m) => ({ type: "code", value: m[1] }),
  },
  {
    type: "ref",
    re: /^\[\[page:([a-z0-9]+)\|([^\]]+)\]\]/i,
    build: (m) => ({ type: "ref", pageId: m[1], title: m[2] }),
  },
  {
    type: "strong",
    re: /^\*\*([\s\S]+?)\*\*/,
    build: (m) => ({ type: "strong", children: parseInline(m[1]) }),
  },
  {
    type: "strong",
    re: /^__([\s\S]+?)__/,
    build: (m) => ({ type: "strong", children: parseInline(m[1]) }),
  },
  {
    type: "del",
    re: /^~~([\s\S]+?)~~/,
    build: (m) => ({ type: "del", children: parseInline(m[1]) }),
  },
  {
    type: "link",
    re: /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/,
    build: (m) => {
      const href = safeHref(m[2]);
      if (!href) return { type: "text", value: m[0] };
      return { type: "link", href, children: parseInline(m[1] || m[2]) };
    },
  },
  {
    type: "link",
    re: /^<((?:https?|mailto):[^>\s]+)>/,
    build: (m) => ({ type: "link", href: m[1], children: [{ type: "text", value: m[1] }] }),
  },
  {
    type: "em",
    re: /^\*([^*\n][\s\S]*?)\*/,
    build: (m) => ({ type: "em", children: parseInline(m[1]) }),
  },
  {
    type: "em",
    re: /^_([^_\n][\s\S]*?)_/,
    build: (m) => ({ type: "em", children: parseInline(m[1]) }),
  },
  {
    type: "link",
    re: /^(https?:\/\/[^\s<>()]+[^\s<>().,;:])/,
    build: (m) => ({ type: "link", href: m[1], children: [{ type: "text", value: m[1] }] }),
  },
];

/** Parse inline Markdown. Nested emphasis works because rules recurse. */
export function parseInline(input: string): Inline[] {
  const nodes: Inline[] = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    if (buffer) {
      nodes.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  while (index < input.length) {
    const char = input[index];

    if (char === "\\" && index + 1 < input.length) {
      buffer += input[index + 1];
      index += 2;
      continue;
    }
    if (char === "\n") {
      flush();
      nodes.push({ type: "br" });
      index += 1;
      continue;
    }

    const rest = input.slice(index);
    let matched = false;
    for (const rule of INLINE_RULES) {
      const match = rule.re.exec(rest);
      if (!match) continue;
      const node = rule.build(match);
      if (!node) continue;
      flush();
      nodes.push(node);
      index += match[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      buffer += char;
      index += 1;
    }
  }
  flush();
  return nodes;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^(```+|~~~+)\s*([\w+#.-]*)\s*(?:\{([^}]*)\})?\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Recognise the optional `{lineNumbers caption="…"}` fence options the export
 * emits. Unknown tokens are ignored so a hand-written fence never fails to
 * parse; the caption is normalised with `code-block.ts`'s `formatCaption`.
 */
function parseFenceOptions(options: string | undefined): { lineNumbers?: boolean; caption?: string } {
  const parsed: { lineNumbers?: boolean; caption?: string } = {};
  if (!options) return parsed;
  if (/\blineNumbers\b/.test(options)) parsed.lineNumbers = true;
  const caption = /caption="((?:[^"\\]|\\.)*)"|caption=(\S+)/.exec(options);
  if (caption) {
    const raw = (caption[1] ?? caption[2] ?? "").replace(/\\(["\\])/g, "$1");
    const text = formatCaption(raw);
    if (text) parsed.caption = text;
  }
  return parsed;
}

/** A line that is exactly one image: `![alt](src)` or `![alt](src "caption")`. */
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/;

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/** Split one pipe-separated table row into trimmed cells (`\|` stays a pipe). */
export const splitTableRow = splitRow;

function parseList(
  lines: string[],
  start: number,
  indent: number,
  ordered: boolean,
): [ListItem[], number] {
  const items: ListItem[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    const match = LIST_ITEM.exec(line);
    if (!match) break;
    const lineIndent = match[1].replace(/\t/g, "  ").length;
    const isOrdered = /\d/.test(match[2]);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      // Deeper marker starts a nested list inside the previous item.
      if (items.length === 0) break;
      const [children, next] = parseList(lines, index, lineIndent, isOrdered);
      items[items.length - 1].children.push({ type: "list", ordered: isOrdered, items: children });
      index = next;
      continue;
    }
    if (isOrdered !== ordered && items.length > 0) break;

    const checked = match[3] ? /\[[xX]\]/.test(match[3]) : null;
    let text = match[4];
    index += 1;

    // Continuation lines (indented, not a new marker) belong to this item.
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === "") {
        const after = lines[index + 1] ?? "";
        if (after.trim() !== "" && (after.match(/^\s*/)?.[0].replace(/\t/g, "  ").length ?? 0) > indent) {
          text += "\n";
          index += 1;
          continue;
        }
        break;
      }
      const nested = LIST_ITEM.exec(next);
      const nextIndent = (next.match(/^\s*/)?.[0].replace(/\t/g, "  ").length ?? 0);
      if (nested) {
        if (nextIndent > indent) break;
        break;
      }
      if (nextIndent <= indent) break;
      text += ` ${next.trim()}`;
      index += 1;
    }

    items.push({ content: parseInline(text.trim()), checked, children: [] });
  }

  return [items, index];
}

/** Parse a Markdown document into blocks. */
export function parseMarkdown(input: string): Block[] {
  const lines = (input ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const content = parseInline(paragraph.join("\n").trim());
    if (content.length > 0) blocks.push({ type: "paragraph", content });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line.trim());
    if (fence) {
      flushParagraph();
      const marker = fence[1][0].repeat(3);
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      blocks.push({ type: "code", lang: fence[2] || null, value: body.join("\n"), ...parseFenceOptions(fence[3]) });
      continue;
    }

    if (HR.test(line) && paragraph.length === 0) {
      flushParagraph();
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: Math.min(heading[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6,
        content: parseInline(heading[2].trim()),
      });
      index += 1;
      continue;
    }

    const image = IMAGE.exec(line);
    if (image) {
      const src = safeHref(image[2].trim());
      if (src) {
        flushParagraph();
        blocks.push({
          type: "image",
          src,
          alt: image[1].trim(),
          caption: image[3]?.trim() || null,
        });
      }
      index += 1;
      continue;
    }

    // Table: a row of cells followed by a separator row.
    if (line.includes("|") && TABLE_SEP.test(lines[index + 1] ?? "")) {
      flushParagraph();
      const header = splitRow(line).map(parseInline);
      const align = splitRow(lines[index + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center" as const;
        if (right) return "right" as const;
        if (left) return "left" as const;
        return null;
      });
      index += 2;
      const rows: Inline[][][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        rows.push(splitRow(lines[index]).map(parseInline));
        index += 1;
      }
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const inner: string[] = [];
      while (index < lines.length) {
        const nested = QUOTE.exec(lines[index]);
        if (!nested) break;
        inner.push(nested[1]);
        index += 1;
      }
      // A leading `[!large]` marker (the markdown form of a pull quote, see
      // `pull-quote.ts`) sets the display scale; it is consumed, not quoted.
      const marker = inner.findIndex((text) => text.trim() !== "");
      const sized: { type: "quote"; blocks: Block[]; size?: PullQuoteSize } = {
        type: "quote",
        blocks: [],
      };
      if (marker !== -1 && /^\[!large\]$/i.test(inner[marker].trim())) {
        sized.size = "large";
        inner.splice(marker, 1);
      }
      sized.blocks = parseMarkdown(inner.join("\n"));
      blocks.push(sized);
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1].replace(/\t/g, "  ").length;
      const ordered = /\d/.test(item[2]);
      const [items, next] = parseList(lines, index, indent, ordered);
      if (items.length > 0) blocks.push({ type: "list", ordered, items });
      index = next > index ? next : index + 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

/** True when the text contains anything Markdown would change. */
export function hasMarkdown(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|)|(\*\*|__|~~|`|\[\[page:)/.test(
    text ?? "",
  );
}

// ---------------------------------------------------------------------------
// Frontmatter (Markdown import, MISSING_FEATURES §12)
// ---------------------------------------------------------------------------

/** What `parseFrontmatter` peels off the head of a `.md` file. */
export type FrontmatterResult = {
  /** YAML-ish `key: value` pairs with scalars coerced to plain JS values. */
  data: Record<string, unknown>;
  /** Everything after the frontmatter block, line endings normalised to `\n`. */
  body: string;
};

/** `key: value` at the start of a line; keys starting `-`, `#`, `*`… are not pairs. */
const FRONTMATTER_PAIR = /^([^\s#*+-][^:]*)\s*:\s*(.*)$/;
/** One sequence item of a block list (`- x` / `* x`, any indentation). */
const FRONTMATTER_ITEM = /^\s*[-*]\s+(.*)$/;
/** Plain YAML numbers (`3`, `-1.5`, `2e3`); dates and versions stay strings. */
const FRONTMATTER_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Split an inline list on top-level commas only (quotes/brackets nest). */
function splitFrontmatterList(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

/** Coerce one YAML-ish scalar: quotes → string, `true/false` → bool, digits → number. */
function frontmatterScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "") return null;
  const first = value[0];
  if (first === '"' || first === "'") {
    const close = value.indexOf(first, 1);
    // Quoted values are verbatim: no number/bool coercion, comments stay out.
    return close === -1 ? value : value.slice(1, close);
  }
  const plain = value.replace(/\s+#.*$/, "").trim(); // drop a trailing ` # comment`
  if (plain === "") return null;
  if (plain.startsWith("[") && plain.endsWith("]")) {
    const inner = plain.slice(1, -1).trim();
    return inner === "" ? [] : splitFrontmatterList(inner).map(frontmatterScalar);
  }
  if (/^(?:true|false)$/i.test(plain)) return plain.toLowerCase() === "true";
  if (FRONTMATTER_NUMBER.test(plain)) return Number(plain);
  return plain;
}

/** Parse the lines between the fences; anything that is not a pair is ignored. */
function frontmatterData(lines: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const pair = FRONTMATTER_PAIR.exec(line);
    if (!pair) continue; // tolerate stray/nested shapes instead of failing
    const key = pair[1].trim().replace(/^["']|["']$/g, "");
    if (pair[2].trim() !== "") {
      data[key] = frontmatterScalar(pair[2]);
      continue;
    }
    // An inline-less key may own an indented — or YAML "indentless" — block list.
    const items: string[] = [];
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === "") {
        index += 1;
        continue;
      }
      const item = FRONTMATTER_ITEM.exec(next);
      if (!item) break;
      items.push(item[1]);
      index += 1;
    }
    data[key] = items.length > 0 ? items.map(frontmatterScalar) : null;
  }
  return data;
}

/**
 * Split the `---\nkey: value\n---` frontmatter block off a Markdown document
 * so the import can capture title/tags/date as page data before the block
 * parser sees the body.
 *
 * Deliberately YAML-*ish* and tolerant (no dependency, never throws):
 * CRLF, quoted values, `#` comments, inline `[a, b]` and block lists are
 * handled; a missing closing fence lets the block end at the first blank
 * line (or at EOF). A leading block with no `key: value` pair is NOT
 * frontmatter — a document that merely starts with a `---` rule keeps every
 * byte of its body.
 */
export function parseFrontmatter(markdown: string): FrontmatterResult {
  const input = (markdown ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = input.split("\n");

  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  if (lines[start]?.trim() !== "---") return { data: {}, body: input };

  // Closing fence wins; without one the block stops at the first blank line.
  let end = -1;
  let boundary = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      boundary = i;
      break;
    }
    if (lines[i].trim() === "") {
      boundary = i;
      break;
    }
  }

  const data = frontmatterData(lines.slice(start + 1, boundary));
  if (Object.keys(data).length === 0) return { data: {}, body: input };

  const body = lines
    .slice(end === -1 ? boundary : end + 1)
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, ""); // drop blank lines right after the fence
  return { data, body };
}

// ---------------------------------------------------------------------------
// Markdown shortcuts (editor input rules)
// ---------------------------------------------------------------------------

/**
 * The pure spec behind the editor's markdown shortcuts: given the text of a
 * block up to the cursor (including the just-typed character), report which
 * trigger fired, the exact text it consumed, and the payload the transform
 * needs (heading level, list start, checked state, fence language, table
 * cells…).
 *
 * Block-level triggers are anchored at the start of the block (leading
 * indentation is allowed) and are terminated by a space or the newline that
 * arrives with Enter. Inline triggers (`~~…~~`, `==…==`) anchor at the cursor
 * instead. Everything here is dependency-free so each rule is unit-testable
 * without an editor.
 */
export type MarkdownShortcutKind =
  | "heading"
  | "bullet"
  | "ordered"
  | "quote"
  | "code"
  | "task"
  | "hr"
  | "strike"
  | "highlight"
  | "table";

export type MarkdownShortcut = {
  kind: MarkdownShortcutKind;
  /** Exact text consumed by the trigger. */
  trigger: string;
  /** Payload for the transform: marker, language, inner text, pipe row… */
  value: string;
  /** Index in the inspected text where the trigger starts. */
  from: number;
  /** Index just past the trigger. */
  to: number;
  /** Heading level (1-6). */
  level?: number;
  /** Task checkbox state. */
  checked?: boolean;
  /** Ordered-list start number. */
  start?: number;
  /** Fence language, or `null` when the fence carries none. */
  lang?: string | null;
  /** Table cells split from the pipe row. */
  cells?: string[];
};

const SHORTCUT_HEADING = /^(\s*)(#{1,6})\s$/;
const SHORTCUT_HR = /^(\s*)(-{3,}|\*{3,}|_{3,})\s$/;
const SHORTCUT_BULLET = /^(\s*)([-*+])\s$/;
const SHORTCUT_ORDERED = /^(\s*)(\d{1,9})[.)]\s$/;
const SHORTCUT_QUOTE = /^(\s*)>\s$/;
const SHORTCUT_FENCE = /^(\s*)(```+|~~~+)([\w+#.-]*)\s$/;
const SHORTCUT_TASK = /^(\s*)\[([ xX]?)\]\s$/;
const SHORTCUT_TABLE = /^\s*\|(.+)\|\s*\n$/;
const SHORTCUT_STRIKE = /~~([^~\n]+)~~$/;
const SHORTCUT_HIGHLIGHT = /==([^=\n]+)==$/;

/** Match a markdown shortcut against the text before the cursor. */
export function matchMarkdownShortcut(text: string): MarkdownShortcut | null {
  const input = text ?? "";
  let match: RegExpExecArray | null;

  if ((match = SHORTCUT_HEADING.exec(input))) {
    return {
      kind: "heading",
      trigger: match[0],
      value: match[2],
      from: 0,
      to: match[0].length,
      level: match[2].length,
    };
  }
  if ((match = SHORTCUT_HR.exec(input))) {
    return { kind: "hr", trigger: match[0], value: match[2], from: 0, to: match[0].length };
  }
  if ((match = SHORTCUT_BULLET.exec(input))) {
    return { kind: "bullet", trigger: match[0], value: match[2], from: 0, to: match[0].length };
  }
  if ((match = SHORTCUT_ORDERED.exec(input))) {
    return {
      kind: "ordered",
      trigger: match[0],
      value: match[2],
      from: 0,
      to: match[0].length,
      start: Number(match[2]),
    };
  }
  if ((match = SHORTCUT_QUOTE.exec(input))) {
    return { kind: "quote", trigger: match[0], value: ">", from: 0, to: match[0].length };
  }
  if ((match = SHORTCUT_FENCE.exec(input))) {
    return {
      kind: "code",
      trigger: match[0],
      value: match[3],
      from: 0,
      to: match[0].length,
      lang: match[3] || null,
    };
  }
  if ((match = SHORTCUT_TASK.exec(input))) {
    return {
      kind: "task",
      trigger: match[0],
      value: match[2],
      from: 0,
      to: match[0].length,
      checked: /[xX]/.test(match[2]),
    };
  }
  if ((match = SHORTCUT_TABLE.exec(input))) {
    return {
      kind: "table",
      trigger: match[0],
      value: match[1],
      from: 0,
      to: match[0].length,
      cells: splitRow(match[1]),
    };
  }
  if ((match = SHORTCUT_STRIKE.exec(input))) {
    return {
      kind: "strike",
      trigger: match[0],
      value: match[1],
      from: input.length - match[0].length,
      to: input.length,
    };
  }
  if ((match = SHORTCUT_HIGHLIGHT.exec(input))) {
    return {
      kind: "highlight",
      trigger: match[0],
      value: match[1],
      from: input.length - match[0].length,
      to: input.length,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// TipTap / ProseMirror conversion
// ---------------------------------------------------------------------------

type TipTapNode = { type: string; attrs?: Record<string, unknown>; content?: TipTapNode[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };

function inlineToTipTap(nodes: Inline[], marks: TipTapNode["marks"] = []): TipTapNode[] {
  const out: TipTapNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push({ type: "text", text: node.value, ...(marks && marks.length ? { marks } : {}) });
        break;
      case "strong":
        out.push(...inlineToTipTap(node.children, [...(marks ?? []), { type: "bold" }]));
        break;
      case "em":
        out.push(...inlineToTipTap(node.children, [...(marks ?? []), { type: "italic" }]));
        break;
      case "del":
        out.push(...inlineToTipTap(node.children, [...(marks ?? []), { type: "strike" }]));
        break;
      case "code":
        out.push({ type: "text", text: node.value, marks: [...(marks ?? []), { type: "code" }] });
        break;
      case "link":
        out.push(...inlineToTipTap(node.children, [...(marks ?? []), { type: "link", attrs: { href: node.href } }]));
        break;
      case "ref":
        out.push({ type: "text", text: node.title, marks: [...(marks ?? []), { type: "bold" }] });
        break;
      case "br":
        out.push({ type: "hardBreak" });
        break;
    }
  }
  return out;
}

function blockToTipTap(block: Block): TipTapNode[] {
  switch (block.type) {
    case "heading":
      return [
        {
          type: "heading",
          attrs: { level: Math.min(block.level, 3) },
          content: inlineToTipTap(block.content),
        },
      ];
    case "paragraph":
      return block.content.length > 0 ? [{ type: "paragraph", content: inlineToTipTap(block.content) }] : [];
    case "code": {
      const attrs: Record<string, unknown> = {};
      if (block.lang) attrs.language = block.lang;
      if (block.lineNumbers) attrs.lineNumbers = true;
      if (block.caption) attrs.caption = block.caption;
      return [{ type: "codeBlock", ...(Object.keys(attrs).length > 0 ? { attrs } : {}), content: block.value ? [{ type: "text", text: block.value }] : [] }];
    }
    case "quote": {
      const inner = block.blocks.flatMap(blockToTipTap);
      // A large quote keeps its `blockquote` wrapper + `size` attr; a plain
      // quote flattens exactly as before (the editor path this always fed).
      if (block.size && block.size !== DEFAULT_PULL_QUOTE_SIZE) {
        return [{ type: "blockquote", attrs: { size: block.size }, content: inner }];
      }
      return inner;
    }
    case "list": {
      const items: TipTapNode[] = block.items.map((item) => {
        const children = item.children.flatMap(blockToTipTap);
        const paragraph: TipTapNode = { type: "paragraph", content: inlineToTipTap(item.content) };
        return { type: item.checked === null ? "listItem" : "taskItem", ...(item.checked === null ? {} : { attrs: { checked: item.checked } }), content: [paragraph, ...children] };
      });
      return [{ type: block.ordered ? "orderedList" : block.items.some((item) => item.checked !== null) ? "taskList" : "bulletList", content: items }];
    }
    case "table":
      return [
        {
          type: "table",
          content: [
            { type: "tableRow", content: block.header.map((cell) => ({ type: "tableHeader", content: [{ type: "paragraph", content: inlineToTipTap(cell) }] })) },
            ...block.rows.map((row) => ({ type: "tableRow", content: row.map((cell) => ({ type: "tableCell", content: [{ type: "paragraph", content: inlineToTipTap(cell) }] })) })),
          ],
        },
      ];
    case "hr":
      return [{ type: "horizontalRule" }];
    case "image":
      return [
        {
          type: "image",
          attrs: { src: block.src, alt: block.alt, caption: block.caption ?? "" },
        },
      ];
  }
}

/** Convert Markdown to ProseMirror JSON so it can be inserted into the editor. */
export function markdownToTipTap(markdown: string): TipTapNode[] {
  return parseMarkdown(markdown).flatMap(blockToTipTap);
}

/** Flatten Markdown to plain text (search, previews, titles). */
export function markdownToText(markdown: string): string {
  const walk = (nodes: Inline[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case "text":
            return node.value;
          case "code":
            return node.value;
          case "ref":
            return node.title;
          case "br":
            return "\n";
          default:
            return walk(node.children);
        }
      })
      .join("");
  return parseMarkdown(markdown)
    .map((block) => {
      switch (block.type) {
        case "heading":
        case "paragraph":
          return walk(block.content);
        case "code":
          return block.value;
        case "quote":
          return block.blocks.map((inner) => ("content" in inner ? walk(inner.content) : "")).join("\n");
        case "list":
          return block.items.map((item) => `- ${walk(item.content)}`).join("\n");
        case "table":
          return [block.header, ...block.rows].map((row) => row.map(walk).join(" | ")).join("\n");
        case "hr":
          return "---";
      }
    })
    .join("\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Markdown export (blocks → Markdown, MISSING_FEATURES §12 / §1)
// ---------------------------------------------------------------------------

/** One mark on a text node (TipTap/ProseMirror JSON). */
export type BlockMark = { type: string; attrs?: Record<string, unknown> };

/**
 * A block as the editor stores it: TipTap/ProseMirror JSON — the same shape
 * `docToMarkdown` in `blocks.ts` serialises. Structural (no tiptap import)
 * so the export helpers stay pure and tolerate unknown/future node types.
 */
export type RichBlock = {
  type?: string;
  text?: string;
  marks?: BlockMark[];
  attrs?: Record<string, unknown>;
  content?: RichBlock[];
};

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
/** Block-level children a list item's inline "head" must not swallow. */
const CONTAINER_TYPES = new Set([
  ...LIST_TYPES,
  "toggle",
  "blockquote",
  "codeBlock",
  "table",
  "blockMath",
  "callout",
  "horizontalRule",
  "columns",
  "column",
]);
/** What the unknown-block fallback recognises as block (vs inline) children. */
const BLOCK_KID_TYPES = new Set([
  ...CONTAINER_TYPES,
  "paragraph",
  "heading",
  "listItem",
  "taskItem",
  "image",
  "bookmark",
  "embed",
  "pageEmbed",
]);
/** One list/toggle nesting level — the parser reads two-space steps back. */
const INDENT = "  ";

function indentLines(markdown: string, pad: string): string {
  return markdown
    .split("\n")
    .map((line) => (line === "" ? line : pad + line))
    .join("\n");
}

function quoteLines(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** Wrap a text run in its marks (innermost first, link last — like the exporter). */
function applyBlockMarks(value: string, marks: readonly BlockMark[] | undefined): string {
  if (!marks || marks.length === 0) return value;
  const has = (type: string): boolean => marks.some((mark) => mark.type === type);
  let out = value;
  if (has("code")) out = `\`${out}\``;
  if (has("bold") || has("strong")) out = `**${out}**`;
  if (has("italic") || has("em")) out = `*${out}*`;
  if (has("strike") || has("del")) out = `~~${out}~~`;
  if (has("highlight") || has("mark")) out = `==${out}==`;
  // B109: the output side applies the same allowlist the input side applies
  // (`safeHref`) — a target the allowlist refuses is written as plain text,
  // never as a link.
  const link = marks.find((mark) => mark.type === "link");
  const href = typeof link?.attrs?.href === "string" ? safeHref(link.attrs.href) : null;
  if (href) out = `[${out}](${href})`;
  return out;
}

function imageMarkdown(block: RichBlock): string {
  const src = String(block.attrs?.src ?? "");
  const alt = String(block.attrs?.alt ?? "");
  const caption = String(block.attrs?.caption ?? "").trim();
  return caption ? `![${alt}](${src} "${caption}")` : `![${alt}](${src})`;
}

/**
 * The `{lineNumbers caption="…"}` fence suffix for a code block, or `""` when
 * it carries neither optional affordance. The caption is normalised with
 * `code-block.ts`'s `formatCaption` (mirroring the editor/HTML renderer) and
 * quotes inside it are escaped so the fence info string stays one line.
 */
function codeFenceOptions(attrs: RichBlock["attrs"]): string {
  const parts: string[] = [];
  if (attrs?.lineNumbers) parts.push("lineNumbers");
  const caption = formatCaption(typeof attrs?.caption === "string" ? attrs.caption : null);
  if (caption) parts.push(`caption="${caption.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return parts.length > 0 ? ` {${parts.join(" ")}}` : "";
}

/** Inline nodes (either a paragraph's children) → Markdown. */
function inlineToMarkdown(nodes: readonly RichBlock[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    switch (node.type) {
      case "hardBreak":
        out += "  \n";
        break;
      case "mention":
        out += `@${String(node.attrs?.label ?? "")}`;
        break;
      case "inlineMath":
        out += `$${String(node.attrs?.latex ?? "")}$`;
        break;
      case "image":
        out += imageMarkdown(node);
        break;
      case "bookmark":
      case "embed": {
        const url = String(node.attrs?.url ?? "");
        out += `[${String(node.attrs?.title ?? url)}](${url})`;
        break;
      }
      case "pageEmbed":
        out += `/w/…/${String(node.attrs?.pageId ?? "")} — ${String(node.attrs?.title ?? "")}`;
        break;
      default:
        if (typeof node.text === "string") out += applyBlockMarks(node.text, node.marks);
        else out += inlineToMarkdown(node.content);
    }
  }
  return out;
}

/** A bullet/ordered/task list, items indented two spaces per nesting level. */
function listToMarkdown(list: RichBlock): string {
  const ordered = list.type === "orderedList";
  const start = Number(list.attrs?.start ?? 1);
  const lines: string[] = [];
  (list.content ?? []).forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const checked = item.attrs?.checked;
    const marker = ordered
      ? `${start + index}.`
      : typeof checked === "boolean"
        ? `- [${checked ? "x" : " "}]`
        : "-";
    const kids = (item.content ?? []).filter(Boolean);
    const head = inlineToMarkdown(kids.filter((kid) => !CONTAINER_TYPES.has(kid.type ?? "")));
    const nested = kids
      .filter((kid) => CONTAINER_TYPES.has(kid.type ?? ""))
      .map(blockToMarkdown)
      .filter((part) => part !== "");
    const line = head ? `${marker} ${head}` : marker;
    lines.push(nested.length > 0 ? `${line}\n${indentLines(nested.join("\n"), INDENT)}` : line);
  });
  return lines.join("\n");
}

function tableToMarkdown(table: RichBlock): string {
  const rows = (table.content ?? [])
    .map((row) =>
      (row?.content ?? [])
        .map((cell) => inlineToMarkdown(cell?.content).replace(/\|/g, "\\|"))
        .filter(Boolean),
    )
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  const separator = `| ${header.map(() => "---").join(" | ")} |`;
  return [line(header), separator, ...body.map(line)].join("\n");
}

/**
 * Serialise a node whose `type` is unknown (a block type this build does not
 * know yet): render block children as blocks, fall back to inline text, and
 * otherwise emit nothing — never throw, never lose what we can read.
 */
function unknownBlockToMarkdown(block: RichBlock): string {
  const kids = (block.content ?? []).filter(Boolean);
  if (kids.some((kid) => BLOCK_KID_TYPES.has(kid.type ?? ""))) {
    return kids.map(blockToMarkdown).filter((part) => part !== "").join("\n\n");
  }
  const inline = inlineToMarkdown(kids);
  if (inline !== "") return inline;
  if (typeof block.text === "string") return applyBlockMarks(block.text, block.marks);
  return "";
}

function blockToMarkdown(block: RichBlock): string {
  if (!block || typeof block !== "object") return ""; // junk in a selection must not throw
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(Number(block.attrs?.level ?? 1), 1), 6);
      const text = inlineToMarkdown(block.content);
      return text ? `${"#".repeat(level)} ${text}` : "";
    }
    case "paragraph":
      return inlineToMarkdown(block.content);
    case "codeBlock": {
      const code = inlineToMarkdown(block.content);
      const run = code.match(/`+/g)?.reduce((max, tick) => Math.max(max, tick.length), 0) ?? 0;
      const fence = "`".repeat(Math.max(3, run + 1));
      const lang = block.attrs?.language == null ? "" : String(block.attrs.language);
      return `${fence}${lang}${codeFenceOptions(block.attrs)}\n${code}\n${fence}`;
    }
    case "blockquote": {
      const inner = (block.content ?? [])
        .map(blockToMarkdown)
        .filter((part) => part !== "")
        .join("\n\n");
      if (!inner) return "";
      // A large pull quote (see `pull-quote.ts`) leads with a `[!large]` marker
      // inside the quote; every other quote round-trips byte-for-byte as before.
      const size = block.attrs?.size;
      const body =
        isPullQuoteSize(size) && size !== DEFAULT_PULL_QUOTE_SIZE ? `[!${size}]\n${inner}` : inner;
      return quoteLines(body);
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
      return listToMarkdown(block);
    case "toggle": {
      const summary = String(block.attrs?.summary ?? "");
      const head = summary ? `- ${summary}` : "";
      const kids = (block.content ?? []).map(blockToMarkdown).filter((part) => part !== "");
      if (kids.length === 0) return head;
      const body = indentLines(kids.join("\n"), INDENT);
      return head ? `${head}\n${body}` : body;
    }
    case "callout": {
      const text = inlineToMarkdown(block.content);
      return `> ${[String(block.attrs?.emoji ?? "💡"), text].filter(Boolean).join(" ")}`;
    }
    case "image":
      return imageMarkdown(block);
    case "bookmark":
    case "embed": {
      const url = String(block.attrs?.url ?? "");
      return `[${String(block.attrs?.title ?? url)}](${url})`;
    }
    case "pageEmbed":
      return `/w/…/${String(block.attrs?.pageId ?? "")} — ${String(block.attrs?.title ?? "")}`;
    case "blockMath":
      return `$$\n${String(block.attrs?.latex ?? "")}\n$$`;
    case "table":
      return tableToMarkdown(block);
    case "horizontalRule":
      return "---";
    default:
      return unknownBlockToMarkdown(block);
  }
}

/**
 * Serialize editor blocks to Markdown with their nesting intact: lists
 * indent two spaces per level, toggles indent their children, quotes prefix
 * every line (nested quotes nest their `>`), tables get their separator row
 * and code keeps a fence longer than anything inside it. Empty blocks are
 * dropped; unknown block types degrade to their children or text instead of
 * throwing. Pure — the DB-free counterpart of the export route's serializer.
 */
export function blocksToMarkdown(blocks: readonly RichBlock[]): string {
  return (blocks ?? [])
    .map(blockToMarkdown)
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * "Copy as Markdown" (§1): the copied block range as a Markdown string.
 * Same serializer as the export path — a selection is just the top slice of
 * a document — so a copied range pastes as the exported page would read.
 */
export function selectionToMarkdown(blocks: readonly RichBlock[]): string {
  return blocksToMarkdown(blocks);
}

/** A page as the subpage-export tree walk sees it. */
export type MarkdownTreeNode = {
  id?: string;
  title?: string;
  /** The page's blocks: a stored `{ type: "doc" }`, a bare block, or an array. */
  blocks?: RichBlock[] | RichBlock | null;
};

/** One path segment — mirrors the workspace export route's `safeName`. */
function pathSegment(title?: string): string {
  return (title ?? "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

function nodeBlocks(node: MarkdownTreeNode): RichBlock[] {
  const blocks = node.blocks;
  if (!blocks) return [];
  if (Array.isArray(blocks)) return blocks;
  if (blocks.type === "doc") return blocks.content ?? [];
  return [blocks];
}

/** Deduplicate a path by appending ` (1)`, ` (2)`… before `.md` (route parity). */
function uniqueMarkdownPath(path: string, used: Set<string>): string {
  let candidate = path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const hasExtension = dot > slash + 1;
  const base = hasExtension ? path.slice(0, dot) : path;
  const extension = hasExtension ? path.slice(dot) : "";
  let n = 1;
  while (used.has(candidate)) {
    candidate = `${base} (${n++})${extension}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Serialize a page and its descendants into the map of path → markdown the
 * subpage/zip export consumes: `Roadmap.md`, `Roadmap/Phase-1.md`,
 * `Roadmap/Phase-1/Kickoff.md`… Depth-first pre-order; each page is visited
 * at most once (keyed by id, falling back to identity), so parent cycles
 * terminate. Paths mirror the workspace export route: sanitised title
 * segments joined by `/`, colliding paths suffixed ` (1)`.
 */
export function blocksToMarkdownTree<T extends MarkdownTreeNode>(
  root: T,
  getChildren: (page: T) => readonly T[] | null | undefined,
): Map<string, string> {
  const tree = new Map<string, string>();
  const used = new Set<string>();
  const seen = new Set<unknown>();
  const stack: { page: T; ancestors: string[] }[] = [{ page: root, ancestors: [] }];

  while (stack.length > 0) {
    const frame = stack.pop() as { page: T; ancestors: string[] };
    const { page, ancestors } = frame;
    if (!page || typeof page !== "object") continue;
    const key = page.id ?? page;
    if (seen.has(key)) continue;
    seen.add(key);

    const segment = pathSegment(page.title);
    const path =
      ancestors.length > 0 ? `${ancestors.join("/")}/${segment}.md` : `${segment}.md`;
    tree.set(uniqueMarkdownPath(path, used), blocksToMarkdown(nodeBlocks(page)));

    const children = getChildren(page) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ page: children[i], ancestors: [...ancestors, segment] });
    }
  }
  return tree;
}

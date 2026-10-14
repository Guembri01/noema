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
 */

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
  | { type: "code"; lang: string | null; value: string }
  | { type: "quote"; blocks: Block[] }
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

const FENCE = /^(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

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
      blocks.push({ type: "code", lang: fence[2] || null, value: body.join("\n") });
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
      blocks.push({ type: "quote", blocks: parseMarkdown(inner.join("\n")) });
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
    case "code":
      return [{ type: "codeBlock", ...(block.lang ? { attrs: { language: block.lang } } : {}), content: block.value ? [{ type: "text", text: block.value }] : [] }];
    case "quote":
      return block.blocks.flatMap(blockToTipTap).map((node) => node);
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

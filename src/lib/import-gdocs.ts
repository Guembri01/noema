/**
 * Google Docs HTML export → Noema blocks.
 *
 * `parseGoogleDoc({ html })` is the pure, DOM-free front half of the Google
 * Docs importer: it turns the HTML Google Docs ("Download → Web page") and
 * Mammoth's `convertToHtml` (the `.docx` path) hand us into the same TipTap /
 * ProseMirror `RichNode[]` the editor stores, plus a `meta` summary the import
 * route can report. No I/O, no database, no editor imports — it runs in the
 * node test environment.
 *
 * Both sources are the same shape in practice: `<h1>`–`<h6>`, `<p>`, `<ul>` /
 * `<ol>` / `<li>`, `<table>` and `<img>`, wrapped in styling-only `<span>`s and
 * a stylesheet we throw away. So the mapping is structural:
 *
 *   - headings → `heading` (level 1–6)
 *   - paragraphs → `paragraph`
 *   - `<ul>` / `<ol>` → `bulletList` / `orderedList` of `listItem`s (nesting
 *     survives as a child list on the parent item)
 *   - tables → `table` / `tableRow` / `tableHeader` / `tableCell`
 *   - images → a link (`images as links`): the export either embeds a
 *     `data:` URI (Mammoth) or points at a `googleusercontent` URL, neither of
 *     which is a usable Noema image, so the image becomes a link paragraph
 *     labelled with its `alt` text (falling back to the `src`)
 *   - `<blockquote>`, `<hr>` and `<pre>` → `blockquote`, `horizontalRule`,
 *     `codeBlock`
 *   - inline markup → bold / italic / underline / strike / code marks, and
 *     `<a href>` → a link mark
 *
 * Reuse, not a fork: link targets go through `markdown.ts`'s `safeHref` (the
 * single gate for `javascript:` / `data:`-style URLs and bare-domain
 * normalisation) and entities/text are decoded by `html-sanitize.ts`'s
 * `stripTags`, so this module agrees with the paste and sanitise pipelines.
 *
 * It never throws: `<head>` chrome, comments, doctypes, scripts/styles and
 * unsupported elements (`<video>`, `<form>`, …) are dropped, unbalanced tags
 * degrade to whatever content can still be read, and a missing/non-string
 * `html` yields an empty result.
 */

import type { Mark, RichNode } from "@/lib/blocks";
import { stripTags } from "@/lib/html-sanitize";
import { safeHref } from "@/lib/markdown";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Honest counters/text the import route reports instead of silently losing data. */
export type GoogleDocMeta = {
  /** `<title>` text when present, else `null`. */
  title: string | null;
  /** Top-level heading blocks. */
  headings: number;
  /** Top-level paragraph blocks (list-item / cell paragraphs excluded). */
  paragraphs: number;
  /** Top-level list blocks. */
  lists: number;
  /** `listItem` nodes at every depth. */
  listItems: number;
  /** Top-level table blocks. */
  tables: number;
  /** `<img>` elements successfully turned into links. */
  images: number;
  /** `<a href>` links kept (image links excluded). */
  links: number;
  /** Unsupported element tags whose subtree was dropped, first-seen order. */
  dropped: string[];
};

export type GoogleDocImport = {
  /** Top-level Noema blocks, ready to store as a document body. */
  blocks: RichNode[];
  meta: GoogleDocMeta;
};

// ---------------------------------------------------------------------------
// Tolerant tokenizer (same DOM-free approach as `paste.ts` / `html-sanitize.ts`)
// ---------------------------------------------------------------------------

type ElementNode = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
};
type TextNode = { kind: "text"; raw: string };
type HtmlNode = ElementNode | TextNode;

/** Elements removed together with their content before tokenizing. */
const DROP_WITH_CONTENT = [
  "script", "style", "iframe", "object", "noscript", "noframes",
  "template", "svg", "math", "applet",
] as const;

const dropWithContentRe = (tags: readonly string[]): RegExp =>
  new RegExp(`<(${tags.join("|")})\\b[^>]*>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`, "gi");

const DROP_RE = dropWithContentRe(DROP_WITH_CONTENT);
const COMMENT = /<!--[\s\S]*?-->/g;
const UNCLOSED_COMMENT = /<!--[\s\S]*$/g;
const DOCTYPE = /<!doctype[^>]*>/gi;
const PROCESSING = /<\?[\s\S]*?\?>/g;
const TOKEN = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;

/** Elements that never take a closing tag (or children). */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Parse a start tag's attributes. `on*` handlers never survive; first wins. */
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1].toLowerCase();
    if (name.startsWith("on")) continue;
    if (name in attrs) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** Decode entities via the shared sanitizer (single source of truth). */
function decodeEntities(value: string): string {
  return stripTags(value);
}

/** Tokenize into a tree; unmatched closes pop the nearest open element. */
function tokenize(html: string): HtmlNode[] {
  const root: ElementNode = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const clean = html
    .replace(COMMENT, "")
    .replace(UNCLOSED_COMMENT, "")
    .replace(DOCTYPE, "")
    .replace(PROCESSING, "")
    .replace(DROP_RE, "");
  TOKEN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const pushText = (raw: string) => {
    if (raw) stack[stack.length - 1].children.push({ kind: "text", raw });
  };
  while ((match = TOKEN.exec(clean))) {
    pushText(clean.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const tag = match[1].toLowerCase();
    if (match[0][1] === "/") {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const selfClosing = match[0].endsWith("/>") || VOID.has(tag);
    const el: ElementNode = { kind: "element", tag, attrs: parseAttrs(match[2] ?? ""), children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
  }
  pushText(clean.slice(cursor));
  return root.children;
}

// ---------------------------------------------------------------------------
// Text + marks
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace the way the HTML renderer would. */
function collapseWhitespace(raw: string): string {
  return raw.replace(/[ \t\r\n\f]+/g, " ");
}

/** Decoded, whitespace-collapsed text of one text node. */
function textOf(raw: string): string {
  return collapseWhitespace(decodeEntities(raw));
}

/** Plain decoded text of a subtree (preserves newlines; used for `<pre>`/`<title>`). */
function plainText(nodes: readonly HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += decodeEntities(node.raw);
    else if (node.tag === "br") out += "\n";
    else out += plainText(node.children);
  }
  return out;
}

/** Marks a wrapping inline element contributes. */
function marksOf(el: ElementNode, meta: GoogleDocMeta): Mark[] {
  switch (el.tag) {
    case "b": case "strong": return [{ type: "bold" }];
    case "i": case "em": return [{ type: "italic" }];
    case "u": case "ins": return [{ type: "underline" }];
    case "s": case "del": case "strike": return [{ type: "strike" }];
    case "code": return [{ type: "code" }];
    case "a": {
      const href = el.attrs.href ? safeHref(el.attrs.href) : null;
      if (!href) return [];
      meta.links += 1;
      return [{ type: "link", attrs: { href } }];
    }
    default: return [];
  }
}

function dedupeMarks(marks: readonly Mark[]): Mark[] {
  const seen = new Set<string>();
  const out: Mark[] = [];
  for (const mark of marks) {
    if (seen.has(mark.type)) continue;
    seen.add(mark.type);
    out.push(mark.attrs ? { type: mark.type, attrs: { ...mark.attrs } } : { type: mark.type });
  }
  return out;
}

function marksKey(marks: readonly Mark[] | undefined): string {
  if (!marks || marks.length === 0) return "";
  return marks.map((mark) => `${mark.type}:${mark.attrs ? JSON.stringify(mark.attrs) : ""}`).join("|");
}

function textNode(text: string, marks: readonly Mark[]): RichNode {
  const unique = dedupeMarks(marks);
  return unique.length > 0 ? { type: "text", text, marks: unique } : { type: "text", text };
}

/** An `<img>` becomes a link to its source, labelled by alt/title/src. */
function imageLink(el: ElementNode, meta: GoogleDocMeta): RichNode | null {
  const src = (el.attrs.src ?? "").trim();
  const href = src ? safeHref(src) : null;
  const alt = (el.attrs.alt ? textOf(el.attrs.alt) : decodeEntities(el.attrs.title ?? "")).trim();
  if (!href) {
    recordDropped(meta, "img");
    return alt ? { type: "text", text: alt } : null;
  }
  meta.images += 1;
  return { type: "text", text: alt || href, marks: [{ type: "link", attrs: { href } }] };
}

/** Flatten an element's children into inline nodes for a heading/paragraph/cell. */
function inlineRun(nodes: readonly HtmlNode[], marks: readonly Mark[], meta: GoogleDocMeta): RichNode[] {
  const out: RichNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const text = textOf(node.raw);
      if (text) out.push(textNode(text, marks));
      continue;
    }
    if (node.tag === "br") {
      out.push({ type: "hardBreak" });
      continue;
    }
    if (node.tag === "hr") continue;
    if (node.tag === "img") {
      const link = imageLink(node, meta);
      if (link) out.push(link);
      continue;
    }
    out.push(...inlineRun(node.children, dedupeMarks([...marks, ...marksOf(node, meta)]), meta));
  }
  return out;
}

/** Trim outer whitespace, drop empties and merge adjacent identically-marked runs. */
function finalizeInline(nodes: readonly RichNode[]): RichNode[] {
  const kept: RichNode[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") kept.push({ type: "hardBreak" });
    else if (node.type === "text" && node.text) kept.push(node);
  }
  const first = kept.find((node) => node.type === "text");
  if (first) first.text = (first.text ?? "").replace(/^\s+/, "");
  const last = [...kept].reverse().find((node) => node.type === "text");
  if (last) last.text = (last.text ?? "").replace(/\s+$/, "");

  const merged: RichNode[] = [];
  for (const node of kept) {
    if (node.type !== "text") { merged.push(node); continue; }
    if (!node.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.type === "text" && marksKey(prev.marks) === marksKey(node.marks)) {
      prev.text = `${prev.text ?? ""}${node.text}`;
      continue;
    }
    merged.push(node);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Block walker
// ---------------------------------------------------------------------------

/** Elements mapped to blocks; their presence makes a wrapper a container. */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "blockquote", "pre", "hr", "table", "thead", "tbody", "tfoot",
  "tr", "td", "th", "caption",
]);

/** Element tags intentionally dropped (no Noema home) and reported in `meta.dropped`. */
const SKIP_TAGS = new Set([
  "video", "audio", "canvas", "embed", "input", "form", "select",
  "textarea", "button", "fieldset", "map", "area", "progress", "meter",
  "output", "dialog",
]);

/** Head/chrome tags that contribute no blocks. */
const IGNORE_TAGS = new Set([
  "meta", "link", "base", "col", "colgroup", "param", "source", "track", "wbr",
]);

function recordDropped(meta: GoogleDocMeta, tag: string): void {
  if (!meta.dropped.includes(tag)) meta.dropped.push(tag);
}

function hasBlockDescendant(el: ElementNode): boolean {
  for (const child of el.children) {
    if (child.kind !== "element") continue;
    if (BLOCK_TAGS.has(child.tag)) return true;
    if (hasBlockDescendant(child)) return true;
  }
  return false;
}

function findElement(nodes: readonly HtmlNode[], tag: string): ElementNode | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.tag === tag) return node;
    const nested = findElement(node.children, tag);
    if (nested) return nested;
  }
  return null;
}

function spanValue(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function paragraph(content: RichNode[]): RichNode {
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

function buildList(el: ElementNode, meta: GoogleDocMeta): RichNode | null {
  const items: RichNode[] = [];
  for (const child of el.children) {
    if (child.kind !== "element" || child.tag !== "li") continue;
    const inline: RichNode[] = [];
    const nested: RichNode[] = [];
    for (const kid of child.children) {
      if (kid.kind === "element" && (kid.tag === "ul" || kid.tag === "ol")) {
        const sub = buildList(kid, meta);
        if (sub) nested.push(sub);
        continue;
      }
      inline.push(...inlineRun([kid], [], meta));
    }
    items.push({ type: "listItem", content: [paragraph(finalizeInline(inline)), ...nested] });
    meta.listItems += 1;
  }
  if (items.length === 0) return null;

  const attrs: Record<string, unknown> = {};
  if (el.tag === "ol") {
    const start = Number.parseInt(el.attrs.start ?? "", 10);
    if (Number.isFinite(start) && start > 1) attrs.start = start;
  }
  return {
    type: el.tag === "ol" ? "orderedList" : "bulletList",
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    content: items,
  };
}

function buildRow(tr: ElementNode, meta: GoogleDocMeta): RichNode {
  const cells: RichNode[] = [];
  for (const child of tr.children) {
    if (child.kind !== "element" || (child.tag !== "td" && child.tag !== "th")) continue;
    cells.push({
      type: child.tag === "th" ? "tableHeader" : "tableCell",
      attrs: { colspan: spanValue(child.attrs.colspan), rowspan: spanValue(child.attrs.rowspan) },
      content: [paragraph(finalizeInline(inlineRun(child.children, [], meta)))],
    });
  }
  return { type: "tableRow", content: cells };
}

function buildTable(el: ElementNode, meta: GoogleDocMeta): RichNode | null {
  const rows: RichNode[] = [];
  const collect = (node: ElementNode): void => {
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (child.tag === "tr") rows.push(buildRow(child, meta));
      else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") collect(child);
    }
  };
  collect(el);
  return rows.length > 0 ? { type: "table", content: rows } : null;
}

function buildBlocks(nodes: readonly HtmlNode[], meta: GoogleDocMeta, out: RichNode[]): void {
  let loose: RichNode[] = [];
  const flush = (): void => {
    if (loose.length === 0) return;
    const content = finalizeInline(loose);
    loose = [];
    if (content.length > 0) out.push({ type: "paragraph", content });
  };

  for (const node of nodes) {
    if (node.kind === "text") {
      const text = textOf(node.raw);
      if (text.trim() === "" && loose.length === 0) continue;
      if (text) loose.push({ type: "text", text });
      continue;
    }

    const tag = node.tag;
    if (tag === "head") {
      const title = findElement(node.children, "title");
      if (title && !meta.title) {
        const text = plainText(title.children).trim();
        if (text) meta.title = text;
      }
      continue;
    }
    if (tag === "title") {
      if (!meta.title) {
        const text = plainText(node.children).trim();
        if (text) meta.title = text;
      }
      continue;
    }
    if (IGNORE_TAGS.has(tag)) continue;
    if (SKIP_TAGS.has(tag)) {
      recordDropped(meta, tag);
      continue;
    }

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        flush();
        out.push({
          type: "heading",
          attrs: { level: Number(tag[1]) },
          content: finalizeInline(inlineRun(node.children, [], meta)),
        });
        continue;
      }
      case "p": {
        flush();
        const content = finalizeInline(inlineRun(node.children, [], meta));
        if (content.length > 0) out.push({ type: "paragraph", content });
        continue;
      }
      case "ul": case "ol": {
        flush();
        const list = buildList(node, meta);
        if (list) out.push(list);
        continue;
      }
      case "blockquote": {
        flush();
        const inner: RichNode[] = [];
        buildBlocks(node.children, meta, inner);
        out.push({ type: "blockquote", content: inner.length > 0 ? inner : [{ type: "paragraph" }] });
        continue;
      }
      case "pre": {
        flush();
        out.push({ type: "codeBlock", content: [{ type: "text", text: plainText(node.children) }] });
        continue;
      }
      case "hr": {
        flush();
        out.push({ type: "horizontalRule" });
        continue;
      }
      case "img": {
        const link = imageLink(node, meta);
        if (link) loose.push(link);
        continue;
      }
      case "table": {
        flush();
        const table = buildTable(node, meta);
        if (table) out.push(table);
        continue;
      }
      default:
        break;
    }

    // Transparent wrapper (div/span/section/…) or stray block: recurse when it
    // holds real blocks, otherwise treat its content as inline text.
    if (hasBlockDescendant(node)) {
      flush();
      buildBlocks(node.children, meta, out);
      continue;
    }
    const inline = inlineRun([node], [], meta);
    if (inline.length > 0) loose.push(...inline);
  }

  flush();
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function emptyMeta(): GoogleDocMeta {
  return {
    title: null,
    headings: 0,
    paragraphs: 0,
    lists: 0,
    listItems: 0,
    tables: 0,
    images: 0,
    links: 0,
    dropped: [],
  };
}

/**
 * Parse a Google Docs HTML export (or Mammoth's `convertToHtml` output) into
 * Noema blocks plus an honest `meta` summary. Pure and total: malformed,
 * hostile or missing input never throws, it degrades to whatever content can
 * still be read.
 */
export function parseGoogleDoc(input: { html?: string | null }): GoogleDocImport {
  const meta = emptyMeta();
  const blocks: RichNode[] = [];
  try {
    const html = typeof input?.html === "string" ? input.html : "";
    if (html.trim() !== "") buildBlocks(tokenize(html), meta, blocks);
  } catch {
    // Never throw: return whatever was parsed before the failure.
  }

  // Top-level counters are read back from the tree so nested list-item and
  // table-cell paragraphs don't inflate `headings` / `paragraphs`.
  meta.headings = blocks.filter((block) => block.type === "heading").length;
  meta.paragraphs = blocks.filter((block) => block.type === "paragraph").length;
  meta.lists = blocks.filter((block) => block.type === "bulletList" || block.type === "orderedList").length;
  meta.tables = blocks.filter((block) => block.type === "table").length;

  return { blocks, meta };
}

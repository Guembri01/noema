/**
 * Clipboard HTML -> TipTap JSON normalisation.
 *
 * Pure: no DOM, no editor imports, so it runs in the node test environment.
 * The editor's paste handler converts clipboard HTML through this module and
 * inserts the resulting JSON as a *closed* block slice, which is what keeps
 * cross-page paste faithful: ProseMirror's own clipboard round-trip flattens
 * the first block whenever the copy was a partial selection (open depths in
 * `data-pm-slice`), turning copied headings into plain paragraphs.
 *
 * Only unsafe markup is stripped (script/style/iframe content, `on*`
 * handlers, `javascript:` urls, non-whitelisted CSS); structure and every
 * Noema block attribute survive.
 */

import type { Mark, RichNode } from "@/lib/blocks";

export type NormalizedPaste = {
  /** Top-level block nodes, ready for a closed slice (openStart 0). */
  blocks: RichNode[];
  /** Flattened inline content of `blocks`, for merging into a text context. */
  inline: RichNode[];
  /** True when `data-pm-slice` reports open depths (partial selection copy). */
  partial: boolean;
};

export type PasteTarget = { empty: boolean };

/* ---------------------------------------------------------------- parsing */

type ElementNode = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
};
type TextNode = { kind: "text"; raw: string };
type HtmlNode = ElementNode | TextNode;

/** Elements whose content is discarded wholesale with the element. */
const DROP_WITH_CONTENT =
  /<(script|style|iframe|object|embed|noscript|svg|math)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TOKEN = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1].toLowerCase();
    if (name.startsWith("on")) continue; // on* handlers never survive
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Tokenize into a tree; unbalanced closes pop the nearest open element. */
function tokenize(html: string): HtmlNode[] {
  const root: ElementNode = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const clean = html.replace(COMMENT, "").replace(DROP_WITH_CONTENT, "");
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
    const closing = match[0][1] === "/";
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
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

/** True when the element contains (at any depth) a block-level construct. */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre",
  "blockquote", "hr", "img", "table", "tr", "th", "td", "div",
]);

function containsBlock(el: ElementNode): boolean {
  for (const child of el.children) {
    if (child.kind === "text") continue;
    if (BLOCK_TAGS.has(child.tag) && !isInlineElement(child)) return true;
    if (containsBlock(child)) return true;
  }
  return false;
}

function isInlineElement(el: ElementNode): boolean {
  // A div is block-level in Noema only when it carries block semantics; a
  // plain wrapping div stays transparent either way.
  return !BLOCK_TAGS.has(el.tag) || el.tag === "div";
}

/* ------------------------------------------------------------ mark mapping */

function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  return /^(javascript|vbscript|data:text\/html)/i.test(value) ? null : value;
}

function styleMarks(style: string | undefined): Mark[] {
  if (!style || /expression\s*\(|javascript:/i.test(style)) return [];
  const marks: Mark[] = [];
  const declarations: Record<string, string> = {};
  for (const part of style.split(";")) {
    const idx = part.indexOf(":");
    if (idx > 0) declarations[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim();
  }
  const color = declarations["color"];
  if (color) marks.push({ type: "textStyle", attrs: { color } });
  const background = declarations["background-color"];
  if (background && background !== "transparent" && background !== "inherit") {
    marks.push({ type: "highlight", attrs: { color: background } });
  }
  const weight = declarations["font-weight"];
  if (weight && (weight === "bold" || weight === "bolder" || Number(weight) >= 600)) {
    marks.push({ type: "bold" });
  }
  if (declarations["font-style"] === "italic") marks.push({ type: "italic" });
  const decoration = declarations["text-decoration"] ?? declarations["text-decoration-line"] ?? "";
  if (/underline/.test(decoration)) marks.push({ type: "underline" });
  if (/line-through/.test(decoration)) marks.push({ type: "strike" });
  return marks;
}

/** Marks contributed by a wrapping inline element (or any element's style). */
function extraMarks(el: ElementNode): Mark[] {
  const marks: Mark[] = [];
  switch (el.tag) {
    case "b": case "strong": marks.push({ type: "bold" }); break;
    case "i": case "em": marks.push({ type: "italic" }); break;
    case "u": case "ins": marks.push({ type: "underline" }); break;
    case "s": case "del": case "strike": marks.push({ type: "strike" }); break;
    case "code": marks.push({ type: "code" }); break;
    case "a": {
      const href = safeHref(el.attrs.href);
      if (href) marks.push({ type: "link", attrs: { href } });
      break;
    }
    case "mark": {
      const background = /background-color\s*:\s*([^;]+)/i.exec(el.attrs.style ?? "")?.[1]?.trim();
      if (background) marks.push({ type: "highlight", attrs: { color: background } });
      else marks.push({ type: "highlight" });
      break;
    }
    case "font": {
      const color = el.attrs.color;
      if (color) marks.push({ type: "textStyle", attrs: { color } });
      break;
    }
    default: break;
  }
  marks.push(...styleMarks(el.attrs.style));
  return dedupe(marks);
}

function dedupe(marks: Mark[]): Mark[] {
  const seen = new Set<string>();
  return marks.filter((mark) => {
    if (seen.has(mark.type)) return false;
    seen.add(mark.type);
    return true;
  });
}

function textNode(text: string, marks: Mark[]): RichNode | undefined {
  if (!text) return undefined;
  return { type: "text", text, ...(marks.length ? { marks } : {}) };
}

function collapseWhitespace(raw: string): string {
  return raw.replace(/[ \t\r\n\f]+/g, " ");
}

/* ---------------------------------------------------------- block mapping */

function blockColorOf(el: ElementNode): string | null {
  return el.attrs["data-block-color"] ?? null;
}

function textAlignOf(el: ElementNode): string | null {
  const align = /text-align\s*:\s*(left|center|right|justify)/i.exec(el.attrs.style ?? "")?.[1];
  return align ? align.toLowerCase() : null;
}

function languageOf(el: ElementNode): string | undefined {
  const direct = el.attrs["data-language"] ?? el.attrs.lang;
  if (direct) return direct;
  const fromPre = /\blanguage-([\w+#-]+)/.exec(el.attrs.class ?? "")?.[1];
  if (fromPre) return fromPre;
  const code = el.children.find(
    (child): child is ElementNode => child.kind === "element" && child.tag === "code",
  );
  if (!code) return undefined;
  return (
    code.attrs["data-language"] ??
    /\blanguage-([\w+#-]+)/.exec(code.attrs.class ?? "")?.[1]
  );
}

/** Raw text of an element's descendants, decoded, whitespace preserved. */
function rawText(el: ElementNode): string {
  let out = "";
  const walk = (nodes: HtmlNode[]) => {
    for (const node of nodes) {
      if (node.kind === "text") out += node.raw;
      else if (node.tag !== "br") walk(node.children);
    }
  };
  walk(el.children);
  // The HTML parser drops one leading newline inside <pre>; do the same.
  return decodeEntities(out.replace(/^\r?\n/, ""));
}

function taskChecked(el: ElementNode): boolean {
  const explicit = el.attrs["data-checked"] ?? el.attrs.checked;
  if (explicit !== undefined) return explicit !== "false" && explicit !== "0" && explicit !== "off";
  const hasInput = (nodes: HtmlNode[]): boolean =>
    nodes.some((node) =>
      node.kind === "element"
        ? (node.tag === "input" && (node.attrs.type ?? "checkbox") === "checkbox" && "checked" in node.attrs) ||
          hasInput(node.children)
        : false,
    );
  return hasInput(el.children);
}

/**
 * Convert a single element to its block node, or `null` when the element is
 * transparent / inline-level and its children are handled by the caller.
 */
function blockNodeFor(el: ElementNode, inheritedColor: string | null): RichNode | null {
  const blockColor = blockColorOf(el) ?? inheritedColor;
  const textAlign = textAlignOf(el);
  const tint = {
    ...(blockColor ? { blockColor } : {}),
    ...(textAlign ? { textAlign } : {}),
  };
  const content = (): RichNode[] | undefined => {
    const nodes = buildBlocks(el.children, [], blockColor);
    return nodes.length ? nodes : undefined;
  };

  switch (el.tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const level = Number(el.tag.slice(1));
      const inline = inlineRun(el.children, extraMarks(el));
      return {
        type: "heading",
        attrs: { level, ...tint },
        ...(inline.length ? { content: inline } : {}),
      };
    }
    case "p": {
      const inline = inlineRun(el.children, extraMarks(el));
      return {
        type: "paragraph",
        ...(Object.keys(tint).length ? { attrs: tint } : {}),
        ...(inline.length ? { content: inline } : {}),
      };
    }
    case "blockquote":
      return { type: "blockquote", ...(blockColor ? { attrs: { blockColor } } : {}), content: content() ?? [paragraph()] };
    case "pre":
      return {
        type: "codeBlock",
        attrs: {
          ...(languageOf(el) ? { language: languageOf(el) } : {}),
          ...(blockColor ? { blockColor } : {}),
        },
        content: [{ type: "text", text: rawText(el) }],
      };
    case "hr":
      return { type: "horizontalRule" };
    case "img":
      return {
        type: "image",
        attrs: {
          src: el.attrs.src ?? "",
          ...(el.attrs.alt !== undefined ? { alt: decodeEntities(el.attrs.alt) } : {}),
          ...(el.attrs.title ? { title: el.attrs.title } : {}),
          ...(el.attrs["data-caption"] ? { caption: el.attrs["data-caption"] } : {}),
        },
      };
    case "ul": {
      const type = el.attrs["data-type"] === "taskList" ? "taskList" : "bulletList";
      const nodes = buildBlocks(el.children, [], blockColor);
      if (!nodes.length) return null;
      return { type, ...(blockColor ? { attrs: { blockColor } } : {}), content: nodes };
    }
    case "ol": {
      const nodes = buildBlocks(el.children, [], blockColor);
      if (!nodes.length) return null;
      return { type: "orderedList", ...(blockColor ? { attrs: { blockColor } } : {}), content: nodes };
    }
    case "li": {
      if (el.attrs["data-type"] === "taskItem") {
        return {
          type: "taskItem",
          attrs: { checked: taskChecked(el), ...(blockColor ? { blockColor } : {}) },
          content: content() ?? [paragraph()],
        };
      }
      return {
        type: "listItem",
        ...(blockColor ? { attrs: { blockColor } } : {}),
        content: content() ?? [paragraph()],
      };
    }
    case "div": {
      const data = el.attrs;
      if ("data-callout" in data || data["data-callout"] === "") {
        return {
          type: "callout",
          attrs: { emoji: data.emoji ?? "💡", color: data.color ?? "gray" },
          content: content() ?? [paragraph()],
        };
      }
      if ("data-toggle" in data) {
        const collapsed =
          data.open === "false" || data.open === "0" ||
          data["data-collapsed"] === "true" || data["aria-expanded"] === "false";
        return {
          type: "toggle",
          attrs: { summary: data.summary ?? data["data-summary"] ?? "", open: !collapsed },
          content: content() ?? [paragraph()],
        };
      }
      if ("data-columns" in data) {
        const nodes = buildBlocks(el.children, [], blockColor);
        return { type: "columns", content: nodes.length ? nodes : [columnFallback()] };
      }
      if ("data-column" in data) {
        return { type: "column", content: content() ?? [paragraph()] };
      }
      if ("data-toc" in data) return { type: "tableOfContents" };
      return null; // plain div stays transparent
    }
    case "table":
      return { type: "table", content: content() };
    case "tr": {
      const nodes = buildBlocks(el.children, [], null);
      if (!nodes.length) return null;
      return { type: "tableRow", content: nodes };
    }
    case "th": case "td": {
      const colspan = Number.parseInt(el.attrs.colspan ?? "", 10);
      const rowspan = Number.parseInt(el.attrs.rowspan ?? "", 10);
      return {
        type: el.tag === "th" ? "tableHeader" : "tableCell",
        attrs: { colspan: colspan > 0 ? colspan : 1, rowspan: rowspan > 0 ? rowspan : 1 },
        content: content() ?? [paragraph()],
      };
    }
    default:
      return null;
  }
}

function paragraph(text?: string): RichNode {
  return text
    ? { type: "paragraph", content: [{ type: "text", text }] }
    : { type: "paragraph" };
}

function columnFallback(): RichNode {
  return { type: "column", content: [paragraph()] };
}

/** Inline content of an inline-content block (paragraph, heading). */
function inlineRun(nodes: HtmlNode[], marks: Mark[]): RichNode[] {
  const out: RichNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const text = textNode(decodeEntities(collapseWhitespace(node.raw)), marks);
      if (text) out.push(text);
      continue;
    }
    if (node.tag === "br") {
      out.push({ type: "hardBreak" });
      continue;
    }
    if (node.tag === "img" || node.tag === "input" || node.tag === "hr") continue;
    out.push(...inlineRun(node.children, dedupe([...marks, ...extraMarks(node)])));
  }
  return out;
}

/**
 * Block content of a container: inline runs become paragraphs, transparent
 * elements recurse (carrying inherited block colour and marks).
 */
function buildBlocks(nodes: HtmlNode[], marks: Mark[], inheritedColor: string | null): RichNode[] {
  const out: RichNode[] = [];
  let loose: RichNode[] = [];

  const flush = () => {
    if (!loose.length) return;
    out.push({ type: "paragraph", content: loose });
    loose = [];
  };

  for (const node of nodes) {
    if (node.kind === "text") {
      const text = collapseWhitespace(node.raw);
      const decoded = decodeEntities(text);
      if (!decoded) continue;
      // Whitespace between blocks (pretty-printed HTML) is not content.
      if (!decoded.trim() && loose.length === 0) continue;
      const piece = textNode(decoded, marks);
      if (piece) loose.push(piece);
      continue;
    }
    const inherited = blockColorOf(node) ?? inheritedColor;
    const block = blockNodeFor(node, inherited);
    if (block) {
      flush();
      out.push(block);
      continue;
    }
    if (node.tag === "input" || node.tag === "br") continue;
    if (containsBlock(node)) {
      flush();
      out.push(...buildBlocks(node.children, dedupe([...marks, ...extraMarks(node)]), inherited));
      continue;
    }
    const inline = inlineRun(node.children, dedupe([...marks, ...extraMarks(node)]));
    if (inline.length) loose.push(...inline);
  }
  flush();
  return out;
}

function flattenInline(nodes: RichNode[]): RichNode[] {
  const out: RichNode[] = [];
  const walk = (list: RichNode[]) => {
    for (const node of list) {
      if (node.type === "text" || node.type === "hardBreak") out.push(node);
      else if (node.content?.length) walk(node.content);
    }
  };
  walk(nodes);
  return out;
}

function detectPartial(nodes: HtmlNode[]): boolean {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    const slice = node.attrs["data-pm-slice"];
    if (slice) {
      const match = /^\s*(\d+)\s+(\d+)/.exec(slice);
      if (match && (Number(match[1]) > 0 || Number(match[2]) > 0)) return true;
    }
    if (detectPartial(node.children)) return true;
  }
  return false;
}

/* ---------------------------------------------------------------- public */

/** Convert clipboard HTML into sanitised TipTap block JSON. */
export function normalizePasteHtml(html: string): NormalizedPaste {
  const nodes = tokenize(html);
  const blocks = buildBlocks(nodes, [], null);
  return {
    blocks,
    inline: flattenInline(blocks),
    partial: detectPartial(nodes),
  };
}

const INLINE_FRIENDLY = new Set(["paragraph", "heading", "codeBlock", "blockquote"]);

/**
 * How the paste should be inserted at the current selection.
 *
 * - `blocks`: insert as a closed slice (openStart 0) so block types survive;
 *   an empty target paragraph is replaced by the pasted blocks.
 * - `inline`: merge the flattened text into the current text context (partial
 *   copies and single paragraphs behave like ordinary text insertion).
 */
export function pastePlan(normalized: NormalizedPaste, target: PasteTarget): "blocks" | "inline" {
  const { blocks, partial } = normalized;
  if (blocks.length === 0) return "inline";
  if (target.empty) return "blocks";
  if (blocks.length === 1) {
    const type = blocks[0].type;
    if (type === "paragraph") return "inline";
    if (partial && type && INLINE_FRIENDLY.has(type)) return "inline";
  }
  return "blocks";
}

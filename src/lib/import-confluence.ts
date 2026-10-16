/**
 * Confluence HTML export → Noema page tree (pure, tolerant, total).
 *
 * The importer half of the "Import Confluence" row (`docs/FEATURE_MATRIX.md`,
 * "Spaces into pages"): it turns a Confluence HTML export into the app's own
 * editor model — the TipTap/ProseMirror `RichBlock` JSON the export helpers in
 * `src/lib/html-export.ts` already speak — grouped into pages.
 *
 * No I/O, no DOM, no `dangerouslySetInnerHTML`. Text is decoded through
 * `html-sanitize.ts`'s `stripTags` (so a page's text is hardened exactly like a
 * paste), links go through `validation.ts`'s `sanitizeHref` (the same gate the
 * HTML exporter uses), and the structural parse is a small, local, DOM-free
 * tokenizer that degrades to text on malformed input instead of throwing.
 *
 * MAPPING (Confluence markup → Noema blocks)
 *   • `h1`–`h6`                 → `heading` (+ `attrs.level`)
 *   • `p` / loose inline runs   → `paragraph`
 *   • `ul` / `ol`               → `bulletList` / `orderedList` (+ `attrs.start`)
 *   • `li`, nested lists        → `listItem` (+ nested list)
 *   • `table` / `tr` / `th`/`td`→ `table` / `tableRow` / `tableHeader`/`tableCell`
 *   • `pre`, code macro         → `codeBlock` (+ `attrs.language`)
 *   • `blockquote`, `hr`, `img` → `blockquote`, `horizontalRule`, `image`
 *   • `a href`                  → inline `link` mark (unsafe targets dropped)
 *   • `ri:page`/`ac:link`       → inline `pageRef` mark
 *   • `ac:structured-macro`     → code `codeBlock`, info/note/warning/tip
 *                                 `callout`; anything else is skipped + warned
 *   • `script`/`style`/…        → removed with their content
 *
 * PAGE TREE
 *   Pages are the export's own wrappers: `<div class="pageSection">` (or
 *   `class="page"`, or any element with `data-page-id`/`data-page`), nested
 *   containers nest. Without containers, top-level `<h1 class="pagetitle">` /
 *   `<h1 id="title-text">` markers split sibling pages, and a document with no
 *   marker at all becomes a single page. Page props come from `data-title`,
 *   `data-icon`, `data-cover-url`, `data-space-key` and `data-label`.
 *
 * Everything unknown degrades rather than crashing: a missing title is
 * `Untitled`, an unknown macro is counted in `meta`, and any malformed input
 * yields a smaller tree, never an exception.
 */

import type { BlockMark, RichBlock } from "./markdown";
import { stripTags } from "./html-sanitize";
import { sanitizeHref } from "./validation";

export type ConfluenceImportInput = {
  /** The exported HTML (a single page, a page section, or a whole space). */
  html: string;
  /** Default space key, used when a page carries no `data-space-key`. */
  spaceKey?: string;
};

/** Page-level properties attached to an imported page. */
export type ConfluencePageProps = {
  /** Page title (never empty — `Untitled` when the export carries none). */
  title: string;
  /** Page icon, when the export provides one. */
  icon: string | null;
  /** Cover image URL, when present. */
  coverUrl: string | null;
  /** Space key: the page's own `data-space-key` or the input default. */
  spaceKey: string | null;
  /** Confluence labels, first-seen order, deduped. */
  labels: string[];
};

/** One imported page. `children` is the sub-tree; `parentId` mirrors it. */
export type ConfluencePage = {
  id: string;
  parentId: string | null;
  props: ConfluencePageProps;
  blocks: RichBlock[];
  children: ConfluencePage[];
};

export type ConfluenceImportMeta = {
  spaceKey: string | null;
  pages: number;
  blocks: number;
  headings: number;
  paragraphs: number;
  lists: number;
  tables: number;
  codeBlocks: number;
  images: number;
  links: number;
  pageRefs: number;
  /** Elements that carried no Noema equivalent (e.g. unknown macros). */
  skippedElements: number;
  /** Deduped, human-readable loss notes (see `meta.skippedElements`). */
  warnings: string[];
};

export type ConfluenceImportResult = {
  pages: ConfluencePage[];
  meta: ConfluenceImportMeta;
};

/* ------------------------------------------------------------- tokenizer */

type RawElement = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: RawNode[];
};
type RawText = { kind: "text"; raw: string };
type RawNode = RawElement | RawText;

const COMMENT = /<!--[\s\S]*?-->/g;
const UNCLOSED_COMMENT = /<!--[\s\S]*$/g;
const DOCTYPE = /<!doctype[^>]*>/gi;
const PROCESSING = /<\?[\s\S]*?\?>/g;
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const CDATA_UNCLOSED = /<!\[CDATA\[([\s\S]*)$/g;
const TOKEN = /<\/?([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
const ATTR = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** Scripting / plugin / foreign roots, removed together with their content. */
const DROP_TAGS = [
  "script", "style", "iframe", "object", "noscript", "noframes", "template",
  "svg", "math", "applet",
] as const;
const DROP_RE = new RegExp(`<(${DROP_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`, "gi");

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

/** Tags that open a block; anything else is read as inline content. */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table",
  "pre", "blockquote", "hr", "img", "ac:image", "ac:structured-macro",
  "div", "section", "article", "main", "aside", "header", "footer", "nav",
  "body", "html", "figure", "figcaption", "details", "summary", "dl", "dt",
  "dd", "address", "center", "form", "fieldset", "ac:rich-text-body",
  "ac:plain-text-body",
]);

/** Decode text through the sanitizer's text pipeline (entities, no markup). */
function decode(value: string): string {
  return value ? stripTags(value) : "";
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR.exec(source))) {
    const name = match[1].toLowerCase();
    if (name.startsWith("on")) continue; // event handlers are never data here
    if (name in attrs) continue; // duplicate: keep the first
    attrs[name] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** Tolerant, DOM-free parse into a node tree. Unmatched closes are ignored. */
function tokenize(html: string): RawElement {
  const root: RawElement = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: RawElement[] = [root];
  const clean = html
    .replace(CDATA, "$1")
    .replace(CDATA_UNCLOSED, "$1")
    .replace(COMMENT, "")
    .replace(UNCLOSED_COMMENT, "")
    .replace(DOCTYPE, "")
    .replace(PROCESSING, "")
    .replace(DROP_RE, "");
  TOKEN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const pushText = (raw: string): void => {
    if (raw) stack[stack.length - 1].children.push({ kind: "text", raw });
  };
  while ((match = TOKEN.exec(clean))) {
    pushText(clean.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const tag = match[1].toLowerCase();
    if (match[0][1] === "/") {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const selfClosing = match[0].endsWith("/>") || VOID_TAGS.has(tag);
    const el: RawElement = { kind: "element", tag, attrs: parseAttrs(match[2] ?? ""), children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
  }
  pushText(clean.slice(cursor));
  return root;
}

function textContent(nodes: readonly RawNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += decode(node.raw);
      continue;
    }
    if (node.tag === "br") {
      out += "\n";
      continue;
    }
    out += textContent(node.children);
  }
  return out;
}

function findElement(nodes: readonly RawNode[], tag: string): RawElement | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.tag === tag) return node;
    const found = findElement(node.children, tag);
    if (found) return found;
  }
  return null;
}

function findDescendant(
  nodes: readonly RawNode[],
  tag: string,
  exclude: ReadonlySet<RawElement>,
): RawElement | null {
  for (const node of nodes) {
    if (node.kind !== "element" || exclude.has(node)) continue;
    if (node.tag === tag) return node;
    const found = findDescendant(node.children, tag, exclude);
    if (found) return found;
  }
  return null;
}

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function toNull(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

/* --------------------------------------------------------------- context */

type Ctx = {
  blocks: number;
  headings: number;
  paragraphs: number;
  lists: number;
  tables: number;
  codeBlocks: number;
  images: number;
  links: number;
  pageRefs: number;
  skippedElements: number;
  warnings: string[];
  warned: Set<string>;
};

function createCtx(): Ctx {
  return {
    blocks: 0,
    headings: 0,
    paragraphs: 0,
    lists: 0,
    tables: 0,
    codeBlocks: 0,
    images: 0,
    links: 0,
    pageRefs: 0,
    skippedElements: 0,
    warnings: [],
    warned: new Set(),
  };
}

function warn(ctx: Ctx, message: string): void {
  if (ctx.warned.has(message)) return;
  ctx.warned.add(message);
  ctx.warnings.push(message);
}

/* ---------------------------------------------------------------- inline */

/** True when inline content has something to show (text or a hard break). */
function hasVisibleContent(nodes: readonly RichBlock[]): boolean {
  return nodes.some(
    (node) =>
      node.type === "hardBreak" ||
      (typeof node.text === "string" && node.text.trim() !== ""),
  );
}

function withMark(nodes: readonly RichBlock[], mark: BlockMark): RichBlock[] {
  return nodes.map((node) =>
    node.type === "hardBreak" ? node : { ...node, marks: [...(node.marks ?? []), mark] },
  );
}

/** Inline children (a paragraph's content) → text runs and marks. */
function inlineFromNodes(
  nodes: readonly RawNode[],
  exclude: ReadonlySet<RawElement>,
  ctx: Ctx,
): RichBlock[] {
  const out: RichBlock[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const text = decode(node.raw);
      if (text) out.push({ type: "text", text });
      continue;
    }
    if (exclude.has(node)) continue;
    switch (node.tag) {
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "strong":
      case "b":
        out.push(...withMark(inlineFromNodes(node.children, exclude, ctx), { type: "bold" }));
        break;
      case "em":
      case "i":
        out.push(...withMark(inlineFromNodes(node.children, exclude, ctx), { type: "italic" }));
        break;
      case "code":
        out.push(...withMark(inlineFromNodes(node.children, exclude, ctx), { type: "code" }));
        break;
      case "del":
      case "s":
      case "strike":
        out.push(...withMark(inlineFromNodes(node.children, exclude, ctx), { type: "strike" }));
        break;
      case "u":
        out.push(...withMark(inlineFromNodes(node.children, exclude, ctx), { type: "underline" }));
        break;
      case "mark":
        out.push(...withMark(inlineFromNodes(node.children, exclude, ctx), { type: "highlight" }));
        break;
      case "a": {
        const href = sanitizeHref(node.attrs.href);
        const inner = inlineFromNodes(node.children, exclude, ctx);
        if (href) {
          ctx.links += 1;
          out.push(...withMark(inner, { type: "link", attrs: { href } }));
        } else {
          out.push(...inner);
        }
        break;
      }
      case "ri:page": {
        const title = decode(node.attrs["ri:content-title"] ?? "");
        if (title) {
          ctx.pageRefs += 1;
          out.push({ type: "text", text: title, marks: [{ type: "pageRef", attrs: { title } }] });
        }
        break;
      }
      case "ac:link": {
        const page = findDescendant(node.children, "ri:page", exclude);
        const title = page ? decode(page.attrs["ri:content-title"] ?? "") : "";
        if (page && title) {
          ctx.pageRefs += 1;
          out.push({ type: "text", text: title, marks: [{ type: "pageRef", attrs: { title } }] });
        } else {
          out.push(...inlineFromNodes(node.children, exclude, ctx));
        }
        break;
      }
      default:
        // Unknown inline markup: unwrap, keeping whatever its children hold.
        out.push(...inlineFromNodes(node.children, exclude, ctx));
    }
  }
  return out;
}

/* ---------------------------------------------------------------- blocks */

function listItemBlock(
  li: RawElement,
  exclude: ReadonlySet<RawElement>,
  ctx: Ctx,
): RichBlock {
  const content: RichBlock[] = [];
  let pending: RichBlock[] = [];
  const flush = (): void => {
    if (pending.length > 0) {
      content.push({ type: "paragraph", content: pending });
      pending = [];
    }
  };
  for (const child of li.children) {
    if (child.kind === "text") {
      if (child.raw.trim()) pending.push(...inlineFromNodes([child], exclude, ctx));
      continue;
    }
    if (exclude.has(child)) continue;
    if (child.tag === "ul" || child.tag === "ol") {
      flush();
      content.push(listBlock(child, child.tag === "ol", exclude, ctx));
      continue;
    }
    if (!BLOCK_TAGS.has(child.tag)) {
      pending.push(...inlineFromNodes([child], exclude, ctx));
      continue;
    }
    flush();
    content.push(...blocksFromNodes([child], exclude, ctx));
  }
  flush();
  return { type: "listItem", content };
}

function listBlock(
  list: RawElement,
  ordered: boolean,
  exclude: ReadonlySet<RawElement>,
  ctx: Ctx,
): RichBlock {
  const items: RichBlock[] = [];
  for (const child of list.children) {
    if (child.kind === "element" && child.tag === "li") {
      items.push(listItemBlock(child, exclude, ctx));
    }
  }
  ctx.lists += 1;
  ctx.blocks += 1;
  const rawStart = list.attrs.start;
  const start = rawStart && rawStart.trim() ? Number(rawStart) : Number.NaN;
  const attrs = ordered && Number.isFinite(start) && start !== 1 ? { start } : null;
  return attrs
    ? { type: "orderedList", attrs, content: items }
    : { type: ordered ? "orderedList" : "bulletList", content: items };
}

function collectRows(nodes: readonly RawNode[], out: RawElement[]): void {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.tag === "tr") {
      out.push(node);
      continue;
    }
    if (node.tag === "table") continue; // a nested table's rows stay its own
    collectRows(node.children, out);
  }
}

function tableBlock(table: RawElement, exclude: ReadonlySet<RawElement>, ctx: Ctx): RichBlock {
  const rows: RawElement[] = [];
  collectRows(table.children, rows);
  const content: RichBlock[] = rows.map((row) => {
    const cells: RichBlock[] = [];
    for (const cell of row.children) {
      if (cell.kind !== "element") continue;
      if (cell.tag !== "td" && cell.tag !== "th") continue;
      const paragraph: RichBlock = {
        type: "paragraph",
        content: inlineFromNodes(cell.children, exclude, ctx),
      };
      cells.push({
        type: cell.tag === "th" ? "tableHeader" : "tableCell",
        content: [paragraph],
      });
    }
    return { type: "tableRow", content: cells };
  });
  ctx.tables += 1;
  ctx.blocks += 1;
  return { type: "table", content };
}

function codeBlockBase(
  nodes: readonly RawNode[],
  language: string | null,
  ctx: Ctx,
): RichBlock {
  ctx.codeBlocks += 1;
  ctx.blocks += 1;
  const content: RichBlock[] = [{ type: "text", text: textContent(nodes) }];
  return language ? { type: "codeBlock", attrs: { language }, content } : { type: "codeBlock", content };
}

function preBlock(pre: RawElement, exclude: ReadonlySet<RawElement>, ctx: Ctx): RichBlock {
  const code = findDescendant(pre.children, "code", exclude);
  let language = toNull(pre.attrs["data-language"]);
  if (!language && code) {
    const match = /(?:^|\s)language-([\w+#-]+)/.exec(code.attrs.class ?? "");
    language = match ? match[1] : null;
  }
  const nodes = code ? code.children : pre.children;
  return codeBlockBase(nodes, language, ctx);
}

function macroParameter(macro: RawElement, name: string): string | null {
  for (const child of macro.children) {
    if (child.kind === "element" && child.tag === "ac:parameter") {
      if ((child.attrs["ac:name"] ?? "").toLowerCase() === name) {
        return firstNonEmpty(textContent(child.children));
      }
    }
  }
  return null;
}

function macroBlock(
  macro: RawElement,
  exclude: ReadonlySet<RawElement>,
  ctx: Ctx,
): RichBlock | null {
  const name = (macro.attrs["ac:name"] ?? "").toLowerCase();
  if (name === "code") {
    const body = findDescendant(macro.children, "ac:plain-text-body", exclude);
    return codeBlockBase(body ? body.children : [], macroParameter(macro, "language"), ctx);
  }
  if (name === "info" || name === "note" || name === "warning" || name === "tip") {
    const body = findDescendant(macro.children, "ac:rich-text-body", exclude);
    const content = blocksFromNodes(body ? body.children : macro.children, exclude, ctx);
    ctx.blocks += 1;
    return { type: "callout", content };
  }
  ctx.skippedElements += 1;
  warn(ctx, `unsupported macro: ${name || "unknown"}`);
  return null;
}

function imageBlock(src: string | undefined, alt: string | undefined, ctx: Ctx): RichBlock {
  ctx.images += 1;
  ctx.blocks += 1;
  return { type: "image", attrs: { src: sanitizeHref(src) ?? "", alt: alt ?? "" } };
}

function acImageBlock(image: RawElement, exclude: ReadonlySet<RawElement>, ctx: Ctx): RichBlock {
  const url = findDescendant(image.children, "ri:url", exclude);
  const attachment = url ? null : findDescendant(image.children, "ri:attachment", exclude);
  const src = url
    ? url.attrs["ri:value"]
    : attachment
      ? attachment.attrs["ri:filename"]
      : "";
  return imageBlock(src, image.attrs["ac:alt"], ctx);
}

/** Block-level children of a page/container → Noema blocks, in order. */
function blocksFromNodes(
  nodes: readonly RawNode[],
  exclude: ReadonlySet<RawElement>,
  ctx: Ctx,
): RichBlock[] {
  const blocks: RichBlock[] = [];
  let pendingInline: RichBlock[] = [];
  const flush = (): void => {
    if (pendingInline.length > 0) {
      blocks.push({ type: "paragraph", content: pendingInline });
      ctx.paragraphs += 1;
      ctx.blocks += 1;
      pendingInline = [];
    }
  };

  for (const node of nodes) {
    if (node.kind === "text") {
      if (node.raw.trim()) pendingInline.push(...inlineFromNodes([node], exclude, ctx));
      continue;
    }
    if (exclude.has(node)) continue;
    const tag = node.tag;

    if (!BLOCK_TAGS.has(tag)) {
      pendingInline.push(...inlineFromNodes([node], exclude, ctx));
      continue;
    }
    flush();

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        blocks.push({
          type: "heading",
          attrs: { level: Number(tag[1]) },
          content: inlineFromNodes(node.children, exclude, ctx),
        });
        ctx.headings += 1;
        ctx.blocks += 1;
        break;
      }
      case "p": {
        const content = inlineFromNodes(node.children, exclude, ctx);
        if (hasVisibleContent(content)) {
          blocks.push({ type: "paragraph", content });
          ctx.paragraphs += 1;
          ctx.blocks += 1;
        }
        break;
      }
      case "ul":
      case "ol":
        blocks.push(listBlock(node, tag === "ol", exclude, ctx));
        break;
      case "table":
        blocks.push(tableBlock(node, exclude, ctx));
        break;
      case "pre":
        blocks.push(preBlock(node, exclude, ctx));
        break;
      case "blockquote":
        blocks.push({ type: "blockquote", content: blocksFromNodes(node.children, exclude, ctx) });
        ctx.blocks += 1;
        break;
      case "hr":
        blocks.push({ type: "horizontalRule" });
        ctx.blocks += 1;
        break;
      case "img":
        blocks.push(imageBlock(node.attrs.src, node.attrs.alt, ctx));
        break;
      case "ac:image":
        blocks.push(acImageBlock(node, exclude, ctx));
        break;
      case "ac:structured-macro": {
        const macro = macroBlock(node, exclude, ctx);
        if (macro) blocks.push(macro);
        break;
      }
      default:
        // Structural wrapper (div, section, body, …): unwrap its children.
        blocks.push(...blocksFromNodes(node.children, exclude, ctx));
    }
  }
  flush();
  return blocks;
}

/* ---------------------------------------------------------------- labels */

function collectLabels(
  nodes: readonly RawNode[],
  exclude: ReadonlySet<RawElement>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const name = value.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  const visit = (list: readonly RawNode[]): void => {
    for (const node of list) {
      if (node.kind !== "element" || exclude.has(node)) continue;
      const dataLabel = node.attrs["data-label"];
      if (dataLabel) add(decode(dataLabel));
      const cls = (node.attrs.class ?? "").split(/\s+/);
      if (cls.includes("label") || cls.includes("aui-label")) add(textContent(node.children));
      visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

/* ------------------------------------------------------------------ pages */

type ContainerHit = { el: RawElement; ancestor: RawElement | null };

function isPageContainer(el: RawElement): boolean {
  if (el.attrs["data-page-id"] !== undefined || el.attrs["data-page"] !== undefined) return true;
  if (el.tag !== "div" && el.tag !== "section" && el.tag !== "article") return false;
  const cls = (el.attrs.class ?? "").split(/\s+/);
  return cls.includes("pageSection") || cls.includes("page");
}

function collectContainers(
  nodes: readonly RawNode[],
  ancestor: RawElement | null,
  out: ContainerHit[],
): void {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (isPageContainer(node)) {
      out.push({ el: node, ancestor });
      collectContainers(node.children, node, out);
    } else {
      collectContainers(node.children, ancestor, out);
    }
  }
}

function isTitleMarker(el: RawElement): boolean {
  if (el.tag !== "h1") return false;
  const cls = (el.attrs.class ?? "").split(/\s+/);
  return cls.includes("pagetitle") || el.attrs.id === "title-text";
}

function findTitleElement(
  nodes: readonly RawNode[],
  exclude: ReadonlySet<RawElement>,
): RawElement | null {
  let first: RawElement | null = null;
  const visit = (list: readonly RawNode[]): RawElement | null => {
    for (const node of list) {
      if (node.kind !== "element" || exclude.has(node)) continue;
      if (node.tag === "h1") {
        const cls = (node.attrs.class ?? "").split(/\s+/);
        if (cls.includes("pagetitle") || node.attrs.id === "title-text") return node;
        if (!first) first = node;
      }
      const found = visit(node.children);
      if (found) return found;
    }
    return null;
  };
  return visit(nodes) ?? first;
}

function documentTitle(root: RawElement): string | null {
  const title = findElement(root.children, "title");
  if (!title) return null;
  return firstNonEmpty(textContent(title.children));
}

function makePage(
  id: string,
  parentId: string | null,
  title: string,
  nodes: readonly RawNode[],
  exclude: ReadonlySet<RawElement>,
  labels: string[],
  spaceKey: string | null,
  icon: string | null,
  coverUrl: string | null,
  ctx: Ctx,
): ConfluencePage {
  return {
    id,
    parentId,
    props: { title, icon, coverUrl, spaceKey, labels },
    blocks: blocksFromNodes(nodes, exclude, ctx),
    children: [],
  };
}

function pagesFromContainers(
  hits: readonly ContainerHit[],
  spaceKey: string | null,
  ctx: Ctx,
): ConfluencePage[] {
  const idByEl = new Map<RawElement, string>();
  const taken = new Set<string>();
  hits.forEach((hit, index) => {
    const provided = firstNonEmpty(hit.el.attrs["data-page-id"], hit.el.attrs["data-page"]);
    let id = provided ?? `page-${index + 1}`;
    while (taken.has(id)) id = `${id}-${index + 1}`;
    taken.add(id);
    idByEl.set(hit.el, id);
  });

  const built: ConfluencePage[] = [];
  for (const hit of hits) {
    const exclude = new Set<RawElement>();
    for (const nested of hits) if (nested.ancestor === hit.el) exclude.add(nested.el);
    const titleEl = findTitleElement(hit.el.children, exclude);
    if (titleEl) exclude.add(titleEl);

    const ancestorId = hit.ancestor ? idByEl.get(hit.ancestor) ?? null : null;
    const parentId = ancestorId ?? firstNonEmpty(hit.el.attrs["data-parent"]);
    const title =
      firstNonEmpty(
        hit.el.attrs["data-title"],
        hit.el.attrs["data-page-title"],
        titleEl ? textContent(titleEl.children) : null,
      ) ?? "Untitled";

    built.push(
      makePage(
        idByEl.get(hit.el) ?? `page-${built.length + 1}`,
        parentId,
        title,
        hit.el.children,
        exclude,
        collectLabels(hit.el.children, exclude),
        firstNonEmpty(hit.el.attrs["data-space-key"]) ?? spaceKey,
        toNull(hit.el.attrs["data-icon"]),
        toNull(hit.el.attrs["data-cover-url"]),
        ctx,
      ),
    );
  }

  const byId = new Map(built.map((page) => [page.id, page]));
  const roots: ConfluencePage[] = [];
  for (const page of built) {
    const parent = page.parentId ? byId.get(page.parentId) : null;
    if (parent && parent !== page) {
      parent.children.push(page);
    } else {
      page.parentId = null;
      roots.push(page);
    }
  }
  return roots;
}

function pagesFromDocument(root: RawElement, spaceKey: string | null, ctx: Ctx): ConfluencePage[] {
  const scope = findElement(root.children, "body") ?? root;
  const kids = scope.children;

  const hasMarker = kids.some((node) => node.kind === "element" && isTitleMarker(node));
  if (hasMarker) {
    const groups: { title: string; nodes: RawNode[] }[] = [];
    const leading: RawNode[] = [];
    let current: { title: string; nodes: RawNode[] } | null = null;
    for (const kid of kids) {
      if (kid.kind === "element" && isTitleMarker(kid)) {
        current = { title: textContent(kid.children), nodes: [] };
        groups.push(current);
      } else if (current) {
        current.nodes.push(kid);
      } else {
        leading.push(kid);
      }
    }
    if (groups.length > 0 && leading.length > 0) groups[0].nodes.unshift(...leading);
    return groups.map((group, index) =>
      makePage(
        `page-${index + 1}`,
        null,
        firstNonEmpty(group.title) ?? "Untitled",
        group.nodes,
        new Set<RawElement>(),
        collectLabels(group.nodes, new Set<RawElement>()),
        spaceKey,
        null,
        null,
        ctx,
      ),
    );
  }

  const exclude = new Set<RawElement>();
  const head = findElement(root.children, "head");
  if (head) exclude.add(head);
  const titleEl = findTitleElement(kids, exclude);
  if (titleEl) exclude.add(titleEl);

  const title =
    firstNonEmpty(
      documentTitle(root),
      titleEl ? textContent(titleEl.children) : null,
    ) ??
    spaceKey ??
    "Untitled";

  return [
    makePage(
      "page-1",
      null,
      title,
      kids,
      exclude,
      collectLabels(kids, exclude),
      spaceKey,
      null,
      null,
      ctx,
    ),
  ];
}

function countPages(pages: readonly ConfluencePage[]): number {
  return pages.reduce((total, page) => total + 1 + countPages(page.children), 0);
}

/* ----------------------------------------------------------------- public */

/**
 * Parse a Confluence HTML export into a Noema page tree.
 *
 * Pure, deterministic and total: malformed input, unknown macros and missing
 * titles degrade (to text, a counted warning, `Untitled`) instead of throwing.
 */
export function parseConfluenceExport(input: ConfluenceImportInput): ConfluenceImportResult {
  const source: Partial<ConfluenceImportInput> =
    input && typeof input === "object" ? input : {};
  const html = typeof source.html === "string" ? source.html : "";
  const spaceKey = firstNonEmpty(source.spaceKey);
  const ctx = createCtx();

  const emptyMeta = (): ConfluenceImportMeta => ({
    spaceKey,
    pages: 0,
    blocks: 0,
    headings: 0,
    paragraphs: 0,
    lists: 0,
    tables: 0,
    codeBlocks: 0,
    images: 0,
    links: 0,
    pageRefs: 0,
    skippedElements: 0,
    warnings: [],
  });

  if (!html.trim()) return { pages: [], meta: emptyMeta() };

  const root = tokenize(html);
  const containers: ContainerHit[] = [];
  collectContainers(root.children, null, containers);
  const pages =
    containers.length > 0
      ? pagesFromContainers(containers, spaceKey, ctx)
      : pagesFromDocument(root, spaceKey, ctx);

  return {
    pages,
    meta: {
      spaceKey,
      pages: countPages(pages),
      blocks: ctx.blocks,
      headings: ctx.headings,
      paragraphs: ctx.paragraphs,
      lists: ctx.lists,
      tables: ctx.tables,
      codeBlocks: ctx.codeBlocks,
      images: ctx.images,
      links: ctx.links,
      pageRefs: ctx.pageRefs,
      skippedElements: ctx.skippedElements,
      warnings: ctx.warnings,
    },
  };
}

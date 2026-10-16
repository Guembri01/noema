/**
 * Paste sanitisation engine (docs/FEATURE_MATRIX.md §2 "Paste with formatting",
 * "Paste without formatting").
 *
 * Clipboard HTML arrives from Word, Google Docs, Notion, the browser and worse,
 * carrying obfuscated scripts, event handlers, dangerous URLs and thickets of
 * `style`/`class` noise. This module is the pure, editor-agnostic gate between
 * that HTML and the document model:
 *
 *  - {@link toPlainText} — block-aware flattening used by "Paste without
 *    formatting": paragraphs, headings, list items, tables and `<hr>` survive as
 *    text lines; everything else is whitespace-collapsed away.
 *  - {@link sanitizePaste} — the allowlist sanitiser. It parses the fragment
 *    with a small tolerant parser (no DOM, no `DOMParser`), drops dangerous
 *    elements *with* their content, unwraps unknown wrappers while keeping their
 *    text, keeps only allowlisted tags/attributes, and neutralises every URL
 *    that is not `http:`, `https:` or `mailto:`.
 *  - {@link stripInlineStyles} / {@link normalizeNestedMarks} — the two smaller
 *    cleanup passes clipboard handlers run before insertion.
 *  - {@link detectSource} / {@link sourceCleanups} — source fingerprinting and
 *    the extra, source-specific cleanup steps it implies (Word `mso-` styles,
 *    Google Docs `docs-internal-guid` wrappers, Notion block classes).
 *  - {@link linkifyText} — turn pasted plain text back into safe anchors.
 *  - {@link describePaste} — a summary of what a paste contained.
 *
 * All functions are pure: inputs are never mutated, output is byte-stable, and
 * no `any` is used anywhere.
 */

// ---------------------------------------------------------------------------
// HTML model
// ---------------------------------------------------------------------------

interface Attr {
  name: string;
  value: string;
}

interface TextNode {
  type: "text";
  value: string;
}

interface ElementNode {
  type: "element";
  tag: string;
  attrs: Attr[];
  children: HtmlNode[];
}

type HtmlNode = TextNode | ElementNode;

/** Void ("empty") HTML elements that never take children. */
const VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is raw text, not markup. */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

/**
 * Elements removed *together with their content* by both `toPlainText` and
 * `sanitizePaste`. Everything else a sanitiser does not recognise is unwrapped.
 */
const DANGEROUS_DROP: ReadonlySet<string> = new Set([
  "script",
  "style",
  "title",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "canvas",
  "audio",
  "video",
  "source",
  "track",
  "portal",
  "base",
  "meta",
  "link",
]);

/** Block-level tags that render as their own text line in `toPlainText`. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

// ---------------------------------------------------------------------------
// Entity decoding
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  laquo: "\u00ab",
  raquo: "\u00bb",
  middot: "\u00b7",
  bull: "\u2022",
  deg: "\u00b0",
  plusmn: "\u00b1",
  times: "\u00d7",
  divide: "\u00f7",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

/** Decode the numeric and common named entities a clipboard payload carries. */
function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

// ---------------------------------------------------------------------------
// Parser (tolerant, DOM-free)
// ---------------------------------------------------------------------------

/** Locate the `>` that closes the tag starting at `start`, skipping quotes. */
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(source: string): Attr[] {
  const attrs: Attr[] = [];
  ATTR_RE.lastIndex = 0;
  let match = ATTR_RE.exec(source);
  while (match !== null) {
    const name = match[1].toLowerCase();
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    attrs.push({ name, value: decodeEntities(raw) });
    match = ATTR_RE.exec(source);
  }
  return attrs;
}

/** Pop the stack back to the matching open element, or ignore a stray close. */
function closeTag(name: string, stack: ElementNode[]): void {
  for (let i = stack.length - 1; i >= 1; i -= 1) {
    if (stack[i].tag === name) {
      stack.length = i;
      return;
    }
  }
}

function pushText(raw: string, parent: ElementNode): void {
  if (raw.length === 0) return;
  parent.children.push({ type: "text", value: decodeEntities(raw) });
}

/** Parse an HTML fragment into a node forest. Malformed input never throws. */
function parseHtml(html: string): HtmlNode[] {
  const root: ElementNode = { type: "element", tag: "#root", attrs: [], children: [] };
  const stack: ElementNode[] = [root];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i), stack[stack.length - 1]);
      break;
    }
    if (lt > i) pushText(html.slice(i, lt), stack[stack.length - 1]);

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt);
      if (end === -1) break;
      closeTag(html.slice(lt + 2, end).trim().toLowerCase(), stack);
      i = end + 1;
      continue;
    }

    const end = findTagEnd(html, lt);
    if (end === -1) {
      pushText(html.slice(lt), stack[stack.length - 1]);
      break;
    }
    const raw = html.slice(lt + 1, end);
    i = end + 1;
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const tagMatch = /^([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(body);
    if (tagMatch === null) {
      pushText(html.slice(lt, end + 1), stack[stack.length - 1]);
      continue;
    }
    const tag = tagMatch[1].toLowerCase();
    const attrs = parseAttrs(body.slice(tagMatch[1].length));
    const parent = stack[stack.length - 1];

    if (VOID_TAGS.has(tag) || selfClosing) {
      parent.children.push({ type: "element", tag, attrs, children: [] });
      continue;
    }
    if (RAW_TEXT_TAGS.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(i);
      const closeMatch = closeRe.exec(rest);
      const content = closeMatch === null ? rest : rest.slice(0, closeMatch.index);
      parent.children.push({
        type: "element",
        tag,
        attrs,
        children: content.length === 0 ? [] : [{ type: "text", value: content }],
      });
      i = closeMatch === null ? html.length : i + closeMatch.index + closeMatch[0].length;
      continue;
    }
    const el: ElementNode = { type: "element", tag, attrs, children: [] };
    parent.children.push(el);
    stack.push(el);
  }
  return root.children;
}

// ---------------------------------------------------------------------------
// Serialiser
// ---------------------------------------------------------------------------

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function serializeNode(node: HtmlNode): string {
  if (node.type === "text") return escapeText(node.value);
  const attrs = node.attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join("");
  const open = `<${node.tag}${attrs}>`;
  if (VOID_TAGS.has(node.tag)) return open;
  return open + node.children.map(serializeNode).join("") + `</${node.tag}>`;
}

function serialize(nodes: readonly HtmlNode[]): string {
  return nodes.map(serializeNode).join("");
}

// ---------------------------------------------------------------------------
// Allowlists & URL policy
// ---------------------------------------------------------------------------

/** Marks and structural tags kept by rich pastes. */
export const DEFAULT_ALLOWED_TAGS: readonly string[] = Object.freeze([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "hr",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "a",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);

/** Block structure kept by plain pastes; every inline mark is unwrapped. */
export const PLAIN_ALLOWED_TAGS: readonly string[] = Object.freeze([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "hr",
]);

/** Per-tag attribute allowlist used by rich pastes. */
export const DEFAULT_ALLOWED_ATTRS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  a: Object.freeze(["href", "title"]),
  ol: Object.freeze(["start"]),
  td: Object.freeze(["colspan", "rowspan"]),
  th: Object.freeze(["colspan", "rowspan"]),
});

/** Attributes whose value must pass the URL policy. */
const URL_ATTRS: ReadonlySet<string> = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "cite",
  "xlink:href",
]);

/** The only URL schemes a paste may introduce. */
export const SAFE_URL_SCHEMES: readonly string[] = Object.freeze(["http:", "https:", "mailto:"]);

/**
 * Return a safe URL for `value`, or `null` when it must be dropped. Control
 * characters and whitespace are removed before the scheme test so
 * `"java\nscript:"` cannot slip through.
 */
function safeUrl(value: string): string | null {
  const collapsed = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (collapsed.length === 0) return null;
  const lower = collapsed.toLowerCase();
  return SAFE_URL_SCHEMES.some((scheme) => lower.startsWith(scheme)) ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// sanitizePaste
// ---------------------------------------------------------------------------

/** Paste flavour: `rich` keeps allowed marks, `plain` keeps only structure. */
export type PasteMode = "rich" | "plain";

export interface SanitizePasteOptions {
  /** Defaults to `"rich"`. */
  mode?: PasteMode;
  /** Overrides {@link DEFAULT_ALLOWED_TAGS} / {@link PLAIN_ALLOWED_TAGS}. */
  allowedTags?: readonly string[];
  /** Per-tag attribute allowlist; entries replace the default for that tag. */
  allowedAttrs?: Readonly<Record<string, readonly string[]>>;
}

function sanitizeAttrs(
  tag: string,
  attrs: readonly Attr[],
  allowedAttrs: Readonly<Record<string, readonly string[]>>,
): Attr[] {
  const allowedForTag = allowedAttrs[tag] ?? [];
  const out: Attr[] = [];
  for (const attr of attrs) {
    if (/^on/i.test(attr.name)) continue;
    if (!allowedForTag.includes(attr.name)) continue;
    if (URL_ATTRS.has(attr.name)) {
      const url = safeUrl(attr.value);
      if (url === null) continue;
      out.push({ name: attr.name, value: url });
      continue;
    }
    out.push(attr);
  }
  return out;
}

function sanitizeNodes(
  nodes: readonly HtmlNode[],
  allowedTags: ReadonlySet<string>,
  allowedAttrs: Readonly<Record<string, readonly string[]>>,
): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      out.push(node);
      continue;
    }
    if (DANGEROUS_DROP.has(node.tag)) continue;
    const children = sanitizeNodes(node.children, allowedTags, allowedAttrs);
    if (!allowedTags.has(node.tag)) {
      out.push(...children);
      continue;
    }
    out.push({
      type: "element",
      tag: node.tag,
      attrs: sanitizeAttrs(node.tag, node.attrs, allowedAttrs),
      children,
    });
  }
  return out;
}

function resolveAllowedTags(options: SanitizePasteOptions | undefined): ReadonlySet<string> {
  if (options?.allowedTags !== undefined) return new Set(options.allowedTags);
  return new Set(options?.mode === "plain" ? PLAIN_ALLOWED_TAGS : DEFAULT_ALLOWED_TAGS);
}

/**
 * Sanitise pasted HTML. Dangerous elements lose their content; unknown wrappers
 * are unwrapped while their text survives; only allowlisted tags, attributes
 * and URL schemes pass. `mode: "plain"` additionally drops every inline mark.
 */
export function sanitizePaste(html: string, options?: SanitizePasteOptions): string {
  const allowedTags = resolveAllowedTags(options);
  const allowedAttrs = options?.allowedAttrs ?? DEFAULT_ALLOWED_ATTRS;
  return serialize(sanitizeNodes(parseHtml(html), allowedTags, allowedAttrs));
}

// ---------------------------------------------------------------------------
// stripInlineStyles
// ---------------------------------------------------------------------------

function stripStyleNodes(nodes: readonly HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      out.push(node);
      continue;
    }
    if (node.tag === "style" || node.tag === "link") continue;
    out.push({
      type: "element",
      tag: node.tag,
      attrs: node.attrs.filter((a) => a.name !== "style" && a.name !== "class"),
      children: stripStyleNodes(node.children),
    });
  }
  return out;
}

/** Remove every `style`/`class` attribute (and `<style>`/`<link>` element). */
export function stripInlineStyles(html: string): string {
  return serialize(stripStyleNodes(parseHtml(html)));
}

// ---------------------------------------------------------------------------
// normalizeNestedMarks
// ---------------------------------------------------------------------------

/** Mark tags that mean the same thing and may be collapsed together. */
const MARK_GROUPS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["b", "strong"]),
  Object.freeze(["i", "em"]),
  Object.freeze(["s", "strike", "del"]),
  Object.freeze(["u"]),
  Object.freeze(["code"]),
]);

function markGroup(tag: string): number {
  return MARK_GROUPS.findIndex((group) => group.includes(tag));
}

function normalizeMarkNodes(nodes: readonly HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      out.push(node);
      continue;
    }
    let children = normalizeMarkNodes(node.children);
    const group = markGroup(node.tag);
    if (group !== -1) {
      let child = children.length === 1 ? children[0] : undefined;
      while (child !== undefined && child.type === "element" && markGroup(child.tag) === group) {
        children = child.children;
        child = children.length === 1 ? children[0] : undefined;
      }
    }
    out.push({ type: "element", tag: node.tag, attrs: node.attrs, children });
  }
  return out;
}

/** Collapse redundant mark nesting, e.g. `<b><b>x</b></b>` → `<b>x</b>`. */
export function normalizeNestedMarks(html: string): string {
  return serialize(normalizeMarkNodes(parseHtml(html)));
}

// ---------------------------------------------------------------------------
// Source detection & cleanups
// ---------------------------------------------------------------------------

export type PasteSource = "google-docs" | "word" | "notion" | "generic";

export interface PasteCleanupStep {
  readonly id: string;
  readonly label: string;
}

const WORD_SIGNALS: readonly RegExp[] = Object.freeze([
  /mso-/i,
  /<o:p[\s>/]/i,
  /urn:schemas-microsoft-com:office:word/i,
  /class="?Mso/i,
  /<!--\[if gte mso/i,
]);

const GDOCS_SIGNALS: readonly RegExp[] = Object.freeze([
  /docs-internal-guid/i,
  /id="?docs-internal/i,
  /google-docs/i,
]);

const NOTION_SIGNALS: readonly RegExp[] = Object.freeze([
  /notion-/i,
  /notion-page-content/i,
  /data-block-id/i,
]);

/** Fingerprint the clipboard source; defaults to `"generic"`. */
export function detectSource(html: string): PasteSource {
  if (WORD_SIGNALS.some((re) => re.test(html))) return "word";
  if (GDOCS_SIGNALS.some((re) => re.test(html))) return "google-docs";
  if (NOTION_SIGNALS.some((re) => re.test(html))) return "notion";
  return "generic";
}

const SOURCE_CLEANUPS: Readonly<Record<PasteSource, readonly PasteCleanupStep[]>> = Object.freeze({
  word: Object.freeze([
    Object.freeze({
      id: "word:mso-styles",
      label: "Strip Word mso-* inline styles and MsoNormal classes",
    }),
    Object.freeze({
      id: "word:conditional-comments",
      label: "Drop downlevel-revealed conditional comments",
    }),
    Object.freeze({
      id: "word:office-namespaces",
      label: "Unwrap o:/w: namespaced elements and their attributes",
    }),
  ]),
  "google-docs": Object.freeze([
    Object.freeze({
      id: "gdocs:internal-ids",
      label: 'Drop id="docs-internal-guid…" wrappers',
    }),
    Object.freeze({
      id: "gdocs:fake-bold",
      label: 'Unwrap <b style="font-weight:normal"> fake-bold wrappers',
    }),
  ]),
  notion: Object.freeze([
    Object.freeze({
      id: "notion:block-classes",
      label: "Strip notion-* block classes",
    }),
    Object.freeze({
      id: "notion:data-attrs",
      label: "Drop data-block-id and related data-* attributes",
    }),
  ]),
  generic: Object.freeze([]),
});

/** The extra cleanup steps a detected source implies; empty for generic. */
export function sourceCleanups(source: PasteSource): readonly PasteCleanupStep[] {
  return SOURCE_CLEANUPS[source];
}

// ---------------------------------------------------------------------------
// toPlainText
// ---------------------------------------------------------------------------

function renderPlain(nodes: readonly HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      // Collapse inline runs (including raw newlines) so only structural
      // markers introduce line breaks.
      out += node.value.replace(/\s+/g, " ");
      continue;
    }
    const tag = node.tag;
    if (DANGEROUS_DROP.has(tag)) continue;
    if (tag === "br") {
      out += "\n";
      continue;
    }
    if (tag === "hr") {
      out += "\n---\n";
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      let index = 0;
      for (const child of node.children) {
        if (child.type === "element" && child.tag === "li") {
          index += 1;
          const prefix = tag === "ol" ? `${index}. ` : "- ";
          out += `\n${prefix}${renderPlain(child.children)}\n`;
        } else {
          out += renderPlain([child]);
        }
      }
      continue;
    }
    if (tag === "tr") {
      const cells = node.children
        .filter((c): c is ElementNode => c.type === "element" && (c.tag === "td" || c.tag === "th"))
        .map((c) => renderPlain(c.children));
      out += `\n${cells.join(" | ")}\n`;
      continue;
    }
    const inner = renderPlain(node.children);
    if (BLOCK_TAGS.has(tag) || HEADING_TAGS.has(tag)) {
      out += `\n${inner}\n`;
      continue;
    }
    out += inner;
  }
  return out;
}

function normalizeLines(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Flatten HTML to newline-separated plain text, block-aware and collapsed. */
export function toPlainText(html: string): string {
  return normalizeLines(renderPlain(parseHtml(html)));
}

// ---------------------------------------------------------------------------
// linkifyText
// ---------------------------------------------------------------------------

const LINK_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function escapeTextForLink(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trimTrailingPunctuation(candidate: string): { url: string; rest: string } {
  const trailing = candidate.match(/[.,;:!?)\]]+$/);
  if (trailing === null) return { url: candidate, rest: "" };
  return { url: candidate.slice(0, candidate.length - trailing[0].length), rest: trailing[0] };
}

/** Escape plain text and turn bare URLs/emails into safe anchors. */
export function linkifyText(text: string): string {
  let result = "";
  let last = 0;
  LINK_RE.lastIndex = 0;
  let match = LINK_RE.exec(text);
  while (match !== null) {
    const start = match.index;
    result += escapeTextForLink(text.slice(last, start));
    const { url, rest } = trimTrailingPunctuation(match[0]);
    if (url.length === 0) {
      result += escapeTextForLink(match[0]);
    } else if (url.includes("@") && !/^https?:/i.test(url)) {
      result += `<a href="mailto:${escapeAttr(url)}">${escapeTextForLink(url)}</a>`;
    } else {
      const href = url.startsWith("www.") ? `https://${url}` : url;
      result += `<a href="${escapeAttr(href)}">${escapeTextForLink(url)}</a>`;
    }
    result += escapeTextForLink(rest);
    last = start + match[0].length;
    match = LINK_RE.exec(text);
  }
  return result + escapeTextForLink(text.slice(last));
}

// ---------------------------------------------------------------------------
// describePaste
// ---------------------------------------------------------------------------

export interface PasteSummary {
  characters: number;
  words: number;
  lines: number;
  headings: number;
  listItems: number;
  tables: number;
  links: number;
  images: number;
  hasHtml: boolean;
  hasUnsafeHtml: boolean;
}

interface TagCounts {
  headings: number;
  listItems: number;
  tables: number;
  links: number;
  images: number;
}

function countTags(nodes: readonly HtmlNode[], counts: TagCounts): void {
  for (const node of nodes) {
    if (node.type === "text") continue;
    if (HEADING_TAGS.has(node.tag)) counts.headings += 1;
    if (node.tag === "li") counts.listItems += 1;
    if (node.tag === "table") counts.tables += 1;
    if (node.tag === "img") counts.images += 1;
    if (node.tag === "a") {
      const href = node.attrs.find((a) => a.name === "href");
      if (href !== undefined && safeUrl(href.value) !== null) counts.links += 1;
    }
    countTags(node.children, counts);
  }
}

function hasUnsafeHtml(html: string): boolean {
  return (
    /<\s*(script|style|iframe|object|embed|svg|math)\b/i.test(html) ||
    /\son[a-z]+\s*=/i.test(html) ||
    /javascript\s*:/i.test(html) ||
    /<[^>]+\bsrc\s*=\s*["']?\s*data:/i.test(html)
  );
}

/** Summarise what a paste contained, for telemetry and paste prompts. */
export function describePaste(html: string): PasteSummary {
  const plain = toPlainText(html);
  const counts: TagCounts = { headings: 0, listItems: 0, tables: 0, links: 0, images: 0 };
  countTags(parseHtml(html), counts);
  return {
    characters: plain.length,
    words: plain.length === 0 ? 0 : plain.split(/\s+/).length,
    lines: plain.length === 0 ? 0 : plain.split("\n").length,
    headings: counts.headings,
    listItems: counts.listItems,
    tables: counts.tables,
    links: counts.links,
    images: counts.images,
    hasHtml: /<[a-z!/]/i.test(html),
    hasUnsafeHtml: hasUnsafeHtml(html),
  };
}

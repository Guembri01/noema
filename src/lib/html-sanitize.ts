/**
 * HTML sanitizer for pasted / imported HTML.
 *
 * Pure `string in -> string out`: no DOM, no `dangerouslySetInnerHTML`, no
 * database. It is the hardening layer a paste/import pipeline runs before the
 * result is trusted as markup. The design mirrors `paste.ts`'s tolerant,
 * DOM-free tokenizer so both behave the same on the same adversarial input.
 *
 *   • `escapeHtml(value)`  — the one text/attribute escaper.
 *   • `sanitizeHtml(html, opts?)` — allowlist markup in, safe markup out.
 *   • `safeUrl(value, schemes?)` — one url attribute, safe url or `null`.
 *   • `stripTags(html)`    — markup in, decoded text out.
 *
 * What is stripped, unconditionally:
 *   • `<script>`, `<style>`, `<iframe>`, `<object>`, `<noscript>`,
 *     `<template>`, `<svg>`, `<math>`, `<applet>` — element *and* content;
 *   • every `on*` event handler (never allowlistable, even by name);
 *   • `javascript:`, `vbscript:` and unsafe `data:` URLs (entity-,
 *     whitespace- and case-obfuscation tolerant);
 *   • protocol-relative (`//host`) targets and encoded-colon smuggling;
 *   • HTML comments (including unclosed ones) and the `<!doctype>`/`<?…?>`
 *     prologue noise a full document import carries.
 *
 * What survives: the default tag allowlist, the default attribute allowlist
 * (plus `data-*` / `aria-*`), allowlisted URL schemes, and text (decoded then
 * escaped so existing entities round-trip without double-escaping).
 *
 * Unknown tags are *unwrapped* — the tag goes, the children stay. Malformed
 * or unbalanced markup never throws; the tokenizer degrades to text.
 *
 * Options replace the corresponding default allowlist (pass the full set you
 * want, not a delta). `allowedAttrs` does not bypass the `on*` strip.
 */

import { underHtmlScanBudget } from "@/lib/html-budget";

export type SanitizeHtmlOptions = {
  /** Tags kept in the output. Replaces the default allowlist when given. */
  allowedTags?: readonly string[];
  /** Attributes kept. Replaces the default allowlist when given. */
  allowedAttrs?: readonly string[];
  /** URL schemes allowed in href/src-shaped attributes. Replaces defaults. */
  allowedSchemes?: readonly string[];
};

/** Escape the five characters that change HTML parsing: `& < > " '`. */
export function escapeHtml(value: string): string {
  const input = typeof value === "string" ? value : "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* --------------------------------------------------------------- allowlists */

/** Default block/inline/table tags a pasted document may keep. */
const DEFAULT_ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn",
  "em", "i", "ins", "kbd", "mark", "q", "rp", "rt", "ruby", "s", "samp",
  "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
  "address", "article", "aside", "blockquote", "caption", "col", "colgroup",
  "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "img", "li", "main",
  "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul",
]);

/** Default attributes; `data-*` / `aria-*` are allowed by prefix too. */
const DEFAULT_ALLOWED_ATTRS = new Set([
  "href", "src", "alt", "title", "width", "height", "colspan", "rowspan",
  "start", "reversed", "type", "value", "checked", "disabled", "open",
  "lang", "dir", "id", "class", "name", "target", "rel", "datetime", "cite",
  "label", "for", "download", "loading", "decoding", "controls", "poster",
  "loop", "muted", "autoplay", "playsinline", "size", "maxlength",
  "placeholder", "rows", "cols", "span", "scope", "headers", "abbr",
  "align", "role",
]);

/** Default URL schemes; `data:` is additionally restricted to safe images. */
const DEFAULT_ALLOWED_SCHEMES = ["http", "https", "mailto", "tel", "data"];

/** The default schemes as a set — the allowlist {@link safeUrl} starts from. */
const DEFAULT_SCHEME_SET = new Set(DEFAULT_ALLOWED_SCHEMES);

/** Elements removed *with* their content — scripting/plugin/foreign roots. */
const DROP_WITH_CONTENT = [
  "script", "style", "iframe", "object", "noscript", "noframes",
  "template", "svg", "math", "applet",
] as const;

/** Elements that never take a closing tag (or children). */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Attributes whose value must resolve to an allowlisted URL scheme. */
const URL_ATTRS = new Set([
  "href", "src", "action", "formaction", "poster", "cite",
  "background", "longdesc", "manifest", "ping",
]);

/** `data:` is only safe for these raster image types (never `svg+xml`). */
const SAFE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp)[;,]/i;

/* --------------------------------------------------------------- tokenizer */

type ElementNode = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
};
type TextNode = { kind: "text"; raw: string };
type HtmlNode = ElementNode | TextNode;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
};

/** Decode the common/numeric entities (single pass, never throws). */
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
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Parse a start tag's attribute source. `on*` never survives; first wins. */
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1].toLowerCase();
    if (name.startsWith("on")) continue; // event handlers are never attributes here
    if (name in attrs) continue; // duplicate: keep the first, like a browser
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** One regex that removes a set of elements together with their content. */
function dropWithContentRe(tags: readonly string[]): RegExp {
  return new RegExp(`<(${tags.join("|")})\\b[^>]*>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`, "gi");
}

const COMMENT = /<!--[\s\S]*?-->/g;
const UNCLOSED_COMMENT = /<!--[\s\S]*$/g;
const DOCTYPE = /<!doctype[^>]*>/gi;
const PROCESSING = /<\?[\s\S]*?\?>/g;
const TOKEN = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;

/** Tokenize into a tree; unmatched closes are ignored, junk degrades to text. */
function tokenize(html: string, dropRe: RegExp): HtmlNode[] {
  // B130: the tokenizer's regular expression backtracks at every tag start
  // (the attribute group reads forward to the next ">" and gives the work
  // back one character at a time when there is none). A document built to
  // make that work would block the event loop for minutes — measured: 35 KB
  // of "<script" cost 8.3 s, 70 KB cost 31 s. The budget refuses such a
  // document before the scan starts.
  if (!underHtmlScanBudget(html)) {
    return [];  }
  const root: ElementNode = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const clean = html
    .replace(COMMENT, "")
    .replace(UNCLOSED_COMMENT, "")
    .replace(DOCTYPE, "")
    .replace(PROCESSING, "")
    .replace(dropRe, "");
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
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const selfClosing = match[0].endsWith("/>") || VOID_TAGS.has(tag);
    const el: ElementNode = { kind: "element", tag, attrs: parseAttrs(match[2] ?? ""), children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
  }
  pushText(clean.slice(cursor));
  return root.children;
}

/* -------------------------------------------------------------- serializing */

/**
 * Resolve an attribute value to a safe URL, or `null` to drop it.
 *
 * Control characters are removed (browsers strip them from inside a scheme),
 * protocol-relative targets are rejected, a declared scheme must be on the
 * allowlist, `data:` must be a safe raster image, and an unattributable or
 * encoded colon — an attempt to smuggle a scheme — is rejected.
 *
 * The allowlist defaults to the module's own ({@link DEFAULT_ALLOWED_SCHEMES});
 * `sanitizeHtml` passes the caller's list.
 */
export function safeUrl(
  value: string,
  allowedSchemes: ReadonlySet<string> = DEFAULT_SCHEME_SET,
): string | null {
  const raw = value.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  if (!raw) return null;
  if (/^[\\/]{2}/.test(raw)) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === "data") {
      return allowedSchemes.has("data") && SAFE_DATA_URL.test(raw) ? raw : null;
    }
    return allowedSchemes.has(name) ? raw : null;
  }
  // Only the part before the path/query/fragment can name a scheme. A colon
  // inside a relative path (`/api/files/ws/a:b.png`) is an ordinary filename
  // character, not a scheme smuggler.
  if (/^[/?#]/.test(raw)) return raw;
  const head = raw.split(/[/?#]/, 1)[0];
  if (head.includes(":") || /%3a/i.test(head)) return null;
  return raw;
}

/** True when an attribute name may be emitted. `on*` is always refused. */
function isAttrAllowed(name: string, allowedAttrs: ReadonlySet<string> | null): boolean {
  if (name.startsWith("on")) return false;
  if (allowedAttrs) return allowedAttrs.has(name);
  if (name.startsWith("data-") || name.startsWith("aria-")) return true;
  return DEFAULT_ALLOWED_ATTRS.has(name);
}

function serializeAttrs(
  attrs: Record<string, string>,
  allowedAttrs: ReadonlySet<string> | null,
  allowedSchemes: ReadonlySet<string>,
): string {
  let out = "";
  for (const [name, value] of Object.entries(attrs)) {
    if (!isAttrAllowed(name, allowedAttrs)) continue;
    if (URL_ATTRS.has(name)) {
      const safe = safeUrl(value, allowedSchemes);
      if (safe === null) continue;
      out += ` ${name}="${escapeHtml(safe)}"`;
      continue;
    }
    out += ` ${name}="${escapeHtml(value)}"`;
  }
  return out;
}

function serializeNodes(
  nodes: readonly HtmlNode[],
  allowedTags: ReadonlySet<string>,
  allowedAttrs: ReadonlySet<string> | null,
  allowedSchemes: ReadonlySet<string>,
): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += escapeHtml(decodeEntities(node.raw));
      continue;
    }
    const attrs = serializeAttrs(node.attrs, allowedAttrs, allowedSchemes);
    if (!allowedTags.has(node.tag)) {
      // Unknown tag: unwrap, keeping whatever its children contribute.
      out += serializeNodes(node.children, allowedTags, allowedAttrs, allowedSchemes);
      continue;
    }
    if (VOID_TAGS.has(node.tag)) {
      out += `<${node.tag}${attrs}>`;
      continue;
    }
    out += `<${node.tag}${attrs}>${serializeNodes(node.children, allowedTags, allowedAttrs, allowedSchemes)}</${node.tag}>`;
  }
  return out;
}

/* ------------------------------------------------------------------ public */

function asSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.toLowerCase()));
}

/**
 * Sanitise foreign HTML down to an allowlisted, script-free fragment. Safe for
 * embedding (e.g. `dangerouslySetInnerHTML`) once you trust this module's
 * defaults or pass your own allowlists. Never throws.
 */
export function sanitizeHtml(html: string, options: SanitizeHtmlOptions = {}): string {
  if (typeof html !== "string" || html === "") return "";
  const allowedTags = options.allowedTags ? asSet(options.allowedTags) : DEFAULT_ALLOWED_TAGS;
  const allowedAttrs = options.allowedAttrs ? asSet(options.allowedAttrs) : null;
  const allowedSchemes = options.allowedSchemes
    ? asSet(options.allowedSchemes)
    : new Set(DEFAULT_ALLOWED_SCHEMES);
  const nodes = tokenize(html, dropWithContentRe(DROP_WITH_CONTENT));
  return serializeNodes(nodes, allowedTags, allowedAttrs, allowedSchemes);
}

/**
 * Remove every tag, comment and scripting/plugin element, decode entities and
 * turn `<br>` into a newline — plain text out, no markup. Never throws.
 */
export function stripTags(html: string): string {
  if (typeof html !== "string" || html === "") return "";
  const nodes = tokenize(html, dropWithContentRe(DROP_WITH_CONTENT));
  let out = "";
  const walk = (list: readonly HtmlNode[]): void => {
    for (const node of list) {
      if (node.kind === "text") {
        out += decodeEntities(node.raw);
        continue;
      }
      if (node.tag === "br") out += "\n";
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * HTML export for a page.
 *
 * The pure, hardened sibling of `markdown.ts`'s `blocksToMarkdown`: it maps
 * the same editor block JSON (`RichBlock`) to semantic HTML with no database,
 * no React and no `dangerouslySetInnerHTML` — the caller decides whether the
 * string is served as a download, embedded, or inspected in a test.
 *
 * Security is the point, not an afterthought:
 *   • every text run is escaped (`escapeHtml`) before it reaches the output;
 *   • every attribute value (href, src, alt, language, …) is escaped too;
 *   • every link href goes through `sanitizeHref`, so `javascript:`,
 *     `data:`, protocol-relative and encoded-colon targets are dropped
 *     (the label survives, the anchor does not).
 *
 * `escape` only controls *text* escaping. It is an escape hatch for content
 * that is already known-safe HTML; attribute escaping and href sanitisation
 * are unconditional, so turning it off can never re-arm a link.
 *
 *   • `escapeHtml(text)`               — the one escaper
 *   • `blocksToHtml(blocks, { escape? })` — blocks → HTML fragment
 *   • `documentToHtml(blocks, { title? })` — blocks → full `<!doctype html>`
 */

import type { BlockMark, RichBlock } from "./markdown";
import { sanitizeHref } from "./validation";

export type HtmlExportOptions = {
  /**
   * How text runs are escaped. Defaults to `escapeHtml`. `false` emits text
   * verbatim (trusted, pre-escaped content only); a function supplies a custom
   * escaper. Attribute values and link hrefs are escaped/sanitised regardless.
   */
  escape?: boolean | ((text: string) => string);
};

export type HtmlDocumentOptions = {
  /** Document heading/title. Missing renders as `Untitled`. */
  title?: string;
  /** Text-escaping mode; forwarded to `blocksToHtml`. */
  escape?: boolean | ((text: string) => string);
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

/** Block-level node types this exporter understands (used to pick a layout). */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "divider",
  "callout",
  "toggle",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "image",
  "blockMath",
  "columns",
  "column",
  "bookmark",
  "embed",
  "pageEmbed",
]);

type Ctx = { text: (value: string) => string };

function makeCtx(options: HtmlExportOptions): Ctx {
  const escape = options.escape;
  const text =
    escape === false
      ? (value: string): string => value
      : typeof escape === "function"
        ? escape
        : escapeHtml;
  return { text };
}

/** The text of a node's inline subtree, with no markup (for code/math). */
function plainText(nodes: readonly RichBlock[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (typeof node.text === "string") out += node.text;
    else out += plainText(node.content);
  }
  return out;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isBlock(node: RichBlock): boolean {
  return typeof node.type === "string" && BLOCK_TYPES.has(node.type);
}

/** Wrap an already-rendered run in its marks, innermost first, link outermost. */
function applyMarks(html: string, marks: readonly BlockMark[] | undefined): string {
  if (!marks || marks.length === 0) return html;
  const has = (type: string): boolean => marks.some((mark) => mark.type === type);
  let out = html;
  if (has("code")) out = `<code>${out}</code>`;
  if (has("bold") || has("strong")) out = `<strong>${out}</strong>`;
  if (has("italic") || has("em")) out = `<em>${out}</em>`;
  if (has("strike") || has("del")) out = `<s>${out}</s>`;
  if (has("underline")) out = `<u>${out}</u>`;
  if (has("highlight") || has("mark")) out = `<mark>${out}</mark>`;
  const link = marks.find((mark) => mark.type === "link");
  const href = sanitizeHref(link?.attrs?.href);
  if (href) out = `<a href="${escapeHtml(href)}">${out}</a>`;
  return out;
}

/** Inline nodes (a paragraph's children) → HTML. */
function inlineToHtml(nodes: readonly RichBlock[] | undefined, ctx: Ctx): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    switch (node.type) {
      case "hardBreak":
        out += "<br />";
        break;
      case "mention":
        out += `<span class="mention">@${ctx.text(asString(node.attrs?.label))}</span>`;
        break;
      case "inlineMath":
        out += `<code>${ctx.text(asString(node.attrs?.latex))}</code>`;
        break;
      default: {
        const inner =
          typeof node.text === "string"
            ? ctx.text(node.text)
            : inlineToHtml(node.content, ctx);
        out += applyMarks(inner, node.marks);
      }
    }
  }
  return out;
}

/** Render every child of a container that holds block-level nodes. */
function childrenToHtml(node: RichBlock, ctx: Ctx): string {
  return (node.content ?? []).map((child) => blockToHtml(child, ctx)).join("");
}

/**
 * A quote/callout can hold block children (the editor's shape) or bare inline
 * runs (the pull-quote shape). Mixed content wraps stray inline runs in `<p>`.
 */
function containerToHtml(node: RichBlock, ctx: Ctx): string {
  const kids = (node.content ?? []).filter((child) => Boolean(child));
  if (kids.length === 0) return "";
  if (!kids.some(isBlock)) return `<p>${inlineToHtml(kids, ctx)}</p>`;
  return kids
    .map((kid) => (isBlock(kid) ? blockToHtml(kid, ctx) : `<p>${inlineToHtml([kid], ctx)}</p>`))
    .join("");
}

/** A list item's head (a paragraph) inlines; nested lists render as blocks. */
function listItemToHtml(node: RichBlock, ctx: Ctx): string {
  let out = "";
  for (const kid of node.content ?? []) {
    if (!kid || typeof kid !== "object") continue;
    out += kid.type === "paragraph" ? inlineToHtml(kid.content, ctx) : blockToHtml(kid, ctx);
  }
  return out;
}

function tableCellToHtml(cell: RichBlock, ctx: Ctx): string {
  const tag = cell.type === "tableHeader" ? "th" : "td";
  const inner = (cell.content ?? [])
    .map((kid) => (kid?.type === "paragraph" ? inlineToHtml(kid.content, ctx) : blockToHtml(kid, ctx)))
    .join("");
  return `<${tag}>${inner}</${tag}>`;
}

function tableRowToHtml(row: RichBlock, ctx: Ctx): string {
  return `<tr>${(row.content ?? []).map((cell) => tableCellToHtml(cell, ctx)).join("")}</tr>`;
}

function tableToHtml(node: RichBlock, ctx: Ctx): string {
  const rows = (node.content ?? []).filter((row) => Boolean(row));
  if (rows.length === 0) return "<table></table>";
  const headerRows = rows.filter((row) =>
    (row.content ?? []).some((cell) => cell?.type === "tableHeader"),
  );
  const bodyRows = rows.filter((row) => !headerRows.includes(row));
  let out = "<table>";
  if (headerRows.length > 0) out += `<thead>${headerRows.map((row) => tableRowToHtml(row, ctx)).join("")}</thead>`;
  if (bodyRows.length > 0) out += `<tbody>${bodyRows.map((row) => tableRowToHtml(row, ctx)).join("")}</tbody>`;
  return `${out}</table>`;
}

/**
 * A node this build does not know: render its block children as blocks, its
 * inline children as inline runs, and otherwise its own text — never throw,
 * never lose what it can read.
 */
function unknownBlockToHtml(node: RichBlock, ctx: Ctx): string {
  const kids = (node.content ?? []).filter((child) => Boolean(child));
  if (kids.some(isBlock)) return kids.map((kid) => blockToHtml(kid, ctx)).join("");
  const inline = inlineToHtml(kids, ctx);
  if (inline !== "") return inline;
  if (typeof node.text === "string") return applyMarks(ctx.text(node.text), node.marks);
  return "";
}

function blockToHtml(node: RichBlock, ctx: Ctx): string {
  if (!node || typeof node !== "object") return ""; // junk in a selection must not throw
  switch (node.type) {
    case "paragraph":
      return `<p>${inlineToHtml(node.content, ctx)}</p>`;
    case "heading": {
      const level = clamp(asNumber(node.attrs?.level, 1), 1, 6);
      return `<h${level}>${inlineToHtml(node.content, ctx)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${childrenToHtml(node, ctx)}</ul>`;
    case "orderedList": {
      const start = asNumber(node.attrs?.start, 1);
      return `<ol${start !== 1 ? ` start="${start}"` : ""}>${childrenToHtml(node, ctx)}</ol>`;
    }
    case "taskList":
      return `<ul class="todo-list">${childrenToHtml(node, ctx)}</ul>`;
    case "listItem":
      return `<li>${listItemToHtml(node, ctx)}</li>`;
    case "taskItem": {
      const checked = node.attrs?.checked === true ? " checked" : "";
      return `<li><input type="checkbox" disabled${checked} /> ${listItemToHtml(node, ctx)}</li>`;
    }
    case "blockquote": {
      const cls = node.attrs?.size === "large" ? ' class="pull-quote"' : "";
      return `<blockquote${cls}>${containerToHtml(node, ctx)}</blockquote>`;
    }
    case "codeBlock": {
      const lang = asString(node.attrs?.language);
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      return `<pre><code${cls}>${ctx.text(plainText(node.content))}</code></pre>`;
    }
    case "horizontalRule":
    case "divider":
      return "<hr />";
    case "callout": {
      const emoji = asString(node.attrs?.emoji) || "💡";
      return `<aside class="callout"><span class="callout-emoji">${ctx.text(emoji)}</span>${containerToHtml(node, ctx)}</aside>`;
    }
    case "toggle": {
      const summary = asString(node.attrs?.summary);
      return `<details open><summary>${ctx.text(summary)}</summary>${containerToHtml(node, ctx)}</details>`;
    }
    case "table":
      return tableToHtml(node, ctx);
    case "image":
      return `<img src="${escapeHtml(asString(node.attrs?.src))}" alt="${escapeHtml(asString(node.attrs?.alt))}" />`;
    case "blockMath":
      return `<div class="math">${ctx.text(asString(node.attrs?.latex))}</div>`;
    case "columns":
      return `<div class="columns">${childrenToHtml(node, ctx)}</div>`;
    case "column":
      return `<div class="column">${childrenToHtml(node, ctx)}</div>`;
    case "bookmark":
    case "embed": {
      const url = asString(node.attrs?.url);
      const href = sanitizeHref(url);
      const title = asString(node.attrs?.title) || url;
      return href
        ? `<p><a href="${escapeHtml(href)}">${ctx.text(title)}</a></p>`
        : `<p>${ctx.text(title)}</p>`;
    }
    case "pageEmbed":
      return `<p><em>Synced view: ${ctx.text(asString(node.attrs?.title))}</em></p>`;
    default:
      return unknownBlockToHtml(node, ctx);
  }
}

/**
 * Serialize editor blocks to an HTML fragment. Empty blocks are dropped;
 * unknown block types degrade to their children or text instead of throwing.
 * Pure and deterministic — the DB-free counterpart of the export route's
 * serializer.
 */
export function blocksToHtml(
  blocks: readonly RichBlock[],
  options: HtmlExportOptions = {},
): string {
  const ctx = makeCtx(options);
  return (blocks ?? [])
    .map((block) => blockToHtml(block, ctx))
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * Wrap blocks in a complete, standalone `<!doctype html>` document: charset,
 * viewport, an escaped `<title>`/`<h1>` and the same minimal styles the
 * existing export uses. `title` defaults to `Untitled`.
 */
export function documentToHtml(
  blocks: readonly RichBlock[],
  options: HtmlDocumentOptions = {},
): string {
  const title = options.title?.trim() || "Untitled";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #37352f; max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.65; }
  h1 { font-size: 1.9rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.2rem; }
  code { background: #f1f1ef; padding: .1rem .3rem; border-radius: 4px; font-size: .9em; }
  pre { background: #f1f1ef; padding: .75rem 1rem; border-radius: 6px; overflow-x: auto; }
  blockquote { border-left: 3px solid #e9e9e7; padding-left: 1rem; color: #787774; margin: 0; }
  .callout { background: #f1f1ef; padding: .75rem 1rem; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #e9e9e7; padding: 6px 8px; }
  .columns { display: flex; gap: 1rem; } .column { flex: 1; }
  .mention { background: #e7f0fd; border-radius: 3px; padding: 0 3px; }
  img { max-width: 100%; }
  .todo-list { list-style: none; padding-left: 0; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${blocksToHtml(blocks, { escape: options.escape })}
</body>
</html>
`;
}

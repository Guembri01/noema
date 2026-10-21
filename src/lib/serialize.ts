/**
 * Import/export helpers. `markdownToDoc` is a small, deliberately scoped
 * Markdown parser (headings, lists, tasks, quotes, code fences, rules, inline
 * marks) used by the Markdown import. `pageToMarkdown` reuses the block
 * serialiser. CSV output is generic (columns + matrix) and fully escaped.
 */

import { docToMarkdown, type BlockDoc, type RichNode } from "./blocks";
import { formatCaption } from "./code-block";
import { HUE_NAMES } from "./palette";
import { DEFAULT_PULL_QUOTE_SIZE, isPullQuoteSize } from "./pull-quote";
import { sanitizeHref } from "./validation";

/**
 * Recognise the optional `{lineNumbers caption="…"}` fence options the editor
 * writes out (`code-block.ts`'s `formatCaption` normalises the caption). The
 * language is whatever precedes the trailing `{…}` group, so a language-less
 * fence keeps working; unknown tokens are ignored.
 */
function parseFenceInfo(info: string | undefined): {
  language: string;
  lineNumbers?: boolean;
  caption?: string;
} {
  const text = (info ?? "").trim();
  const optionMatch = /\{([^}]*)\}\s*$/.exec(text);
  const language = (optionMatch ? text.slice(0, optionMatch.index) : text).trim();
  const options = optionMatch?.[1] ?? "";
  const parsed: { language: string; lineNumbers?: boolean; caption?: string } = { language };
  if (/\blineNumbers\b/.test(options)) parsed.lineNumbers = true;
  const caption = /caption="((?:[^"\\]|\\.)*)"|caption=(\S+)/.exec(options);
  if (caption) {
    const raw = (caption[1] ?? caption[2] ?? "").replace(/\\(["\\])/g, "$1");
    const value = formatCaption(raw);
    if (value) parsed.caption = value;
  }
  return parsed;
}

/** A leading `[!large]` line inside a blockquote marks it as a pull quote. */
const PULL_QUOTE_MARKER = /^\[!large\]$/i;

function parseInline(text: string): RichNode[] {
  const nodes: RichNode[] = [];
  const pattern =
    /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push({ type: "text", text: text.slice(last, match.index) });
    }
    if (match[2] !== undefined) {
      nodes.push({ type: "text", text: match[2], marks: [{ type: "bold" }] });
    } else if (match[4] !== undefined) {
      nodes.push({ type: "text", text: match[4], marks: [{ type: "italic" }] });
    } else if (match[6] !== undefined) {
      nodes.push({ type: "text", text: match[6], marks: [{ type: "code" }] });
    } else if (match[8] !== undefined) {
      nodes.push({
        type: "text",
        text: match[8],
        marks: [{ type: "link", attrs: { href: match[9] } }],
      });
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes;
}

const paragraph = (text: string): RichNode => ({
  type: "paragraph",
  content: parseInline(text),
});

export function markdownToDoc(markdown: string): BlockDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: RichNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      const fence = parseFenceInfo(line.trim().slice(3));
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1;
      content.push({
        type: "codeBlock",
        attrs: {
          language: fence.language || null,
          ...(fence.lineNumbers ? { lineNumbers: true } : {}),
          ...(fence.caption ? { caption: fence.caption } : {}),
        },
        content: buffer.length ? [{ type: "text", text: buffer.join("\n") }] : [],
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: Math.min(heading[1].length, 3) },
        content: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      content.push({ type: "horizontalRule" });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buffer.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      // A leading `[!large]` marker (the pull-quote form, see `pull-quote.ts`)
      // sets the display scale and is consumed, not quoted.
      const marker = buffer.findIndex((entry) => entry.trim() !== "");
      const isLarge = marker !== -1 && PULL_QUOTE_MARKER.test(buffer[marker].trim());
      if (isLarge) buffer.splice(marker, 1);
      content.push({
        type: "blockquote",
        ...(isLarge ? { attrs: { size: "large" } } : {}),
        content: [paragraph(buffer.join(" "))],
      });
      continue;
    }

    if (/^[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const items: RichNode[] = [];
      while (i < lines.length && /^[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const match = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i])!;
        items.push({
          type: "taskItem",
          attrs: { checked: match[1].toLowerCase() === "x" },
          content: [paragraph(match[2])],
        });
        i += 1;
      }
      content.push({ type: "taskList", content: items });
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: RichNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i]) && !/\[[ xX]\]/.test(lines[i])) {
        items.push({
          type: "listItem",
          content: [paragraph(lines[i].replace(/^[-*+]\s+/, ""))],
        });
        i += 1;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: RichNode[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push({
          type: "listItem",
          content: [paragraph(lines[i].replace(/^\d+[.)]\s+/, ""))],
        });
        i += 1;
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    content.push(paragraph(line));
    i += 1;
  }

  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

/** Render a page as a Markdown document (title as an H1). */
export function pageToMarkdown(title: string, doc: unknown): string {
  const body = docToMarkdown(doc);
  const heading = title ? `# ${title}\n\n` : "";
  return `${heading}${body}\n`.trimEnd() + "\n";
}

/** Escape a single CSV field. */
export function csvEscape(value: string): string {
  const text = value ?? "";
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Build a CSV document from a header row and a matrix of string cells. */
export function matrixToCsv(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  return `${all.map((row) => row.map(csvEscape).join(",")).join("\r\n")}\r\n`;
}

/** Parse a CSV document into a matrix (handles quotes, escaped quotes, CRLF). */
export function csvToMatrix(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The colours a `style` attribute may carry: the design system's tag
 * foreground tokens (`var(--tag-<hue>-fg)`) the editor writes, and a plain
 * hex value for a document stored before the token migration.
 */
const ALLOWED_STYLE_COLORS = new Set(HUE_NAMES.map((hue) => `var(--tag-${hue}-fg)`));

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` - the legacy stored colour form. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The colour a `textStyle` mark may render, or `null` when the value is not
 * on the allowlist. A stored mark can therefore never push a second CSS
 * declaration (or a `url()`) into the exported `style` attribute.
 */
export function styleColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (ALLOWED_STYLE_COLORS.has(value) || HEX_COLOR.test(value)) return value;
  return null;
}

function inlineHtml(nodes: RichNode[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === "hardBreak") return "<br/>";
      if (node.type === "mention") {
        return `<span class="mention">@${escapeHtml(String(node.attrs?.label ?? ""))}</span>`;
      }
      if (node.type === "inlineMath") {
        return `<code>${escapeHtml(String(node.attrs?.latex ?? ""))}</code>`;
      }
      let html = escapeHtml(node.text ?? inlineHtml(node.content));
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold") html = `<strong>${html}</strong>`;
        else if (mark.type === "italic") html = `<em>${html}</em>`;
        else if (mark.type === "underline") html = `<u>${html}</u>`;
        else if (mark.type === "strike") html = `<s>${html}</s>`;
        else if (mark.type === "code") html = `<code>${html}</code>`;
        else if (mark.type === "highlight") html = `<mark>${html}</mark>`;
        else if (mark.type === "textStyle" && mark.attrs?.color) {
          // Only an allowlisted colour reaches the `style` attribute; the text
          // itself always survives.
          const color = styleColor(mark.attrs.color);
          if (color) html = `<span style="color:${escapeHtml(color)}">${html}</span>`;
        } else if (mark.type === "link" && mark.attrs?.href) {
          // `sanitizeHref` is the shared scheme allowlist: a `javascript:`
          // (or `data:`, protocol-relative, encoded-colon) target loses its
          // anchor, the label survives - the rule `html-export.ts` uses.
          const href = sanitizeHref(mark.attrs.href);
          if (href) html = `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${html}</a>`;
        }
      }
      return html;
    })
    .join("");
}

function blockHtml(node: RichNode): string {
  switch (node.type) {
    case "paragraph":
      return `<p>${inlineHtml(node.content)}</p>`;
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return `<h${level}>${inlineHtml(node.content)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${(node.content ?? []).map(blockHtml).join("")}</ul>`;
    case "orderedList":
      return `<ol>${(node.content ?? []).map(blockHtml).join("")}</ol>`;
    case "taskList":
      return `<ul class="tasks">${(node.content ?? []).map(blockHtml).join("")}</ul>`;
    case "listItem":
    case "taskItem": {
      const checked = node.type === "taskItem" && node.attrs?.checked;
      const box = node.type === "taskItem" ? `<input type="checkbox" disabled ${checked ? "checked" : ""}/> ` : "";
      return `<li>${box}${(node.content ?? []).map(blockHtml).join("")}</li>`;
    }
    case "blockquote": {
      // A pull quote (see `pull-quote.ts`) keeps its display scale on the
      // element as `data-size`, matching the editor's parseHTML contract.
      const size = node.attrs?.size;
      const large = isPullQuoteSize(size) && size !== DEFAULT_PULL_QUOTE_SIZE;
      return `<blockquote${large ? ' data-size="large"' : ""}>${(node.content ?? []).map(blockHtml).join("")}</blockquote>`;
    }
    case "codeBlock": {
      // `data-line-numbers` / `data-caption` mirror `code-block.tsx`'s
      // renderHTML so the exported HTML re-imports through the editor intact;
      // the caption is normalised with the shared `formatCaption`.
      const rawCaption = node.attrs?.caption;
      const caption = formatCaption(typeof rawCaption === "string" ? rawCaption : null);
      const flags = `${node.attrs?.lineNumbers ? ' data-line-numbers="true"' : ""}${
        caption ? ` data-caption="${escapeHtml(caption)}"` : ""
      }`;
      return `<pre${flags}><code>${escapeHtml(inlineHtml(node.content))}</code></pre>`;
    }
    case "horizontalRule":
      return "<hr/>";
    case "image":
      return `<img src="${escapeHtml(String(node.attrs?.src ?? ""))}" alt="${escapeHtml(String(node.attrs?.alt ?? ""))}"/>`;
    case "callout":
      return `<div class="callout">${escapeHtml(String(node.attrs?.emoji ?? "💡"))} ${(node.content ?? []).map(blockHtml).join("")}</div>`;
    case "toggle":
      return `<details open><summary>${escapeHtml(String(node.attrs?.summary ?? ""))}</summary>${(node.content ?? []).map(blockHtml).join("")}</details>`;
    case "columns":
      return `<div class="columns">${(node.content ?? []).map(blockHtml).join("")}</div>`;
    case "column":
      return `<div class="column">${(node.content ?? []).map(blockHtml).join("")}</div>`;
    case "table":
      return `<table><tbody>${(node.content ?? []).map(blockHtml).join("")}</tbody></table>`;
    case "tableRow":
      return `<tr>${(node.content ?? []).map(blockHtml).join("")}</tr>`;
    case "tableHeader":
      return `<th>${(node.content ?? []).map(blockHtml).join("")}</th>`;
    case "tableCell":
      return `<td>${(node.content ?? []).map(blockHtml).join("")}</td>`;
    case "blockMath":
      return `<div class="math">${escapeHtml(String(node.attrs?.latex ?? ""))}</div>`;
    case "bookmark":
    case "embed": {
      const url = String(node.attrs?.url ?? "#");
      // The same scheme allowlist as the inline link: an unsafe target keeps
      // its title and loses the anchor.
      const href = sanitizeHref(url);
      const title = String(node.attrs?.title ?? url);
      return href
        ? `<p><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></p>`
        : `<p>${escapeHtml(title)}</p>`;
    }
    case "pageEmbed":
      return `<p><em>Synced view: ${escapeHtml(String(node.attrs?.title ?? ""))}</em></p>`;
    default:
      return (node.content ?? []).map(blockHtml).join("");
  }
}

/** Render a document to an HTML fragment. */
export function docToHtml(doc: unknown): string {
  const root = doc as RichNode | null;
  if (!root?.content) return "";
  return root.content.map(blockHtml).join("\n");
}

/** Render a page to a standalone HTML document. */
export function pageToHtml(title: string, doc: unknown): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title || "Untitled")}</title>
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
  .tasks { list-style: none; padding-left: 0; }
</style>
</head>
<body>
<h1>${escapeHtml(title || "Untitled")}</h1>
${docToHtml(doc)}
</body>
</html>
`;
}


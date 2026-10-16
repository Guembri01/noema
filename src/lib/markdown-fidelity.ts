/**
 * Nested-content Markdown export fidelity (docs/MISSING_FEATURES.md §12
 * "Export Markdown — nested content partial").
 *
 * `blocks.ts`'s `docToMarkdown` is intentionally minimal: it flattens nested
 * lists, drops fence options, invents a placeholder for column layouts and
 * silently loses marks it does not know. This module is the fidelity-focused
 * sibling — it serialises the SAME editor block JSON (`RichNode`) to Markdown
 * that survives a re-import, and it is honest about what it cannot preserve.
 *
 * Conventions (all documented here because they are the round-trip contract):
 *
 *   • **Nested lists** indent two spaces per level (the app importer's step);
 *     a nested block inside an item is indented one further level.
 *   • **Nested blockquotes** prefix every line with `> `, so a quote inside a
 *     quote nests its markers. A `size: "large"` quote leads with the
 *     importer's `[!large]` marker (`pull-quote.ts`).
 *   • **Tables** use GFM pipe syntax; every `|` inside a cell is escaped `\|`
 *     and short rows are padded to the header's column count.
 *   • **Code fences** carry the language plus the importer's
 *     `{lineNumbers caption="…"}` option suffix (`markdown.ts` `FENCE` /
 *     `parseFenceOptions`); the caption is normalised with `code-block.ts`'s
 *     `formatCaption`. The fence is one backtick longer than anything inside.
 *   • **Callouts** become a GFM-alert-style blockquote whose first line is
 *     `> [!variant] emoji`, then the quoted body.
 *   • **Toggles** become `<details>`/`<summary>` HTML (the shape
 *     `html-export.ts` already emits).
 *   • **Columns** become fenced directives: `:::columns` … `:::`, with each
 *     column wrapped in `:::column` … `:::`. A bare `:::` closes the most
 *     recent opener, so nesting is unambiguous. This is the documented
 *     round-trip marker.
 *   • **Embeds/bookmarks** become titled links; a page embed becomes a link to
 *     its `/w/…/<id>` placeholder.
 *   • **Equations** keep their LaTeX source: `$$` for block math, `$` inline.
 *   • **Images** keep `alt` and an optional caption, plus a `{width=…}` suffix
 *     when a width is stored. `imageBase` prefixes relative `src` values.
 *
 * Everything here is pure, dependency-light (only `code-block.ts`,
 * `pull-quote.ts` and the `RichNode` type are imported) and tolerates unknown
 * or malformed nodes instead of throwing. It is ADDITIVE: no existing module
 * is modified.
 */

import { formatCaption } from "./code-block";
import { DEFAULT_PULL_QUOTE_SIZE, isPullQuoteSize } from "./pull-quote";
import type { RichNode } from "./blocks";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FidelityOptions = {
  /**
   * Use GFM list extensions (task checkboxes `- [x]` and `~~strikethrough~~`).
   * Defaults to `true`. Tables and code fences are always GFM/CommonMark
   * flavoured because the round-trip contract needs them.
   */
  gfm?: boolean;
  /** Emit a leading YAML frontmatter block derived from these pairs. */
  frontMatter?: Record<string, unknown>;
  /** Base path prefixed to relative image `src` values (absolute stay put). */
  imageBase?: string;
};

/** One thing the export cannot preserve across a round trip. */
export type FidelityLoss = { kind: string; reason: string };

export type FidelityReport = {
  /** Features that cannot round-trip at all. */
  lost: FidelityLoss[];
  /** Features encoded in a lossy-but-close form, one note each. */
  approximated: string[];
};

/** Result of {@link roundTripCheck}. */
export type RoundTripCheck = { ok: boolean; issues: string[] };

type Ctx = { gfm: boolean; imageBase: string | undefined };

// ---------------------------------------------------------------------------
// Node classification
// ---------------------------------------------------------------------------

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
  "divider",
  "columns",
  "column",
]);

/** Everything the fidelity serializer renders as a block (vs an inline run). */
const BLOCK_TYPES = new Set([
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

/** Node types `fidelityReport` understands; anything else is reported lost. */
const KNOWN_TYPES = new Set([
  ...BLOCK_TYPES,
  "doc",
  "text",
  "hardBreak",
  "mention",
  "inlineMath",
]);

/** Marks with no Markdown form at all. */
const LOSSY_MARKS = new Set(["color", "textStyle", "fontFamily", "fontSize"]);

/** One nesting level of list / toggle indentation — the importer's step. */
const INDENT = "  ";

function isBlockNode(node: RichNode): boolean {
  return BLOCK_TYPES.has(node.type ?? "");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** The text of a node's subtree with no markup (for code blocks). */
function plainText(nodes: readonly RichNode[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    if (typeof node.text === "string") out += node.text;
    else out += plainText(node.content);
  }
  return out;
}

/** The longest run of backticks in `text` (0 when there are none). */
function maxBacktickRun(text: string): number {
  let max = 0;
  for (const run of text.match(/`+/g) ?? []) max = Math.max(max, run.length);
  return max;
}

// ---------------------------------------------------------------------------
// Text helpers (exported)
// ---------------------------------------------------------------------------

/**
 * Escape the characters that would start an inline Markdown construct when a
 * text run is emitted verbatim. Pipes are intentionally NOT escaped here — the
 * table serializer escapes `|` at the cell boundary so a pipe is escaped
 * exactly once.
 */
export function escapeInline(text: string): string {
  return String(text ?? "").replace(/[\\`*_~[\]<>]/g, "\\$&");
}

/**
 * Indent every non-empty line of `text` by `depth` two-space levels. Blank
 * lines stay blank so a nested block keeps its paragraph spacing.
 */
export function indentNested(text: string, depth: number): string {
  const input = String(text ?? "");
  const levels = Number.isFinite(depth) ? Math.floor(depth) : 0;
  if (levels <= 0) return input;
  const pad = INDENT.repeat(levels);
  return input
    .split("\n")
    .map((line) => (line === "" ? line : pad + line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Inline serialisation
// ---------------------------------------------------------------------------

/** Render one text run, escaping it or wrapping it in a code span first. */
function renderText(raw: string, marks: RichNode["marks"], gfm: boolean): string {
  if (!marks || marks.length === 0) return escapeInline(raw);
  const has = (type: string): boolean => marks.some((mark) => mark.type === type);

  let out: string;
  if (has("code")) {
    const ticks = "`".repeat(Math.max(1, maxBacktickRun(raw) + 1));
    out = `${ticks}${raw}${ticks}`;
  } else {
    out = escapeInline(raw);
  }
  if (has("bold") || has("strong")) out = `**${out}**`;
  if (has("italic") || has("em")) out = `*${out}*`;
  if (gfm && (has("strike") || has("del"))) out = `~~${out}~~`;
  if (has("highlight") || has("mark")) out = `==${out}==`;
  if (has("underline")) out = `<u>${out}</u>`;
  const link = marks.find((mark) => mark.type === "link");
  if (typeof link?.attrs?.href === "string") out = `[${out}](${link.attrs.href})`;
  return out;
}

function resolveImageSrc(src: string, base: string | undefined): string {
  if (!base) return src;
  // Scheme-qualified, protocol-relative, root-relative and fragment targets
  // are already resolved; only a relative path takes the base.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src)) return src;
  return `${base.replace(/\/+$/, "")}/${src.replace(/^\.?\//, "")}`;
}

function imageMarkdown(node: RichNode, ctx: Ctx): string {
  const src = resolveImageSrc(asString(node.attrs?.src), ctx.imageBase);
  const alt = escapeInline(asString(node.attrs?.alt));
  const caption = formatCaption(typeof node.attrs?.caption === "string" ? node.attrs.caption : null);
  const quoted = caption.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let out = caption ? `![${alt}](${src} "${quoted}")` : `![${alt}](${src})`;
  const width = node.attrs?.width;
  if (typeof width === "number" && Number.isFinite(width) && width > 0) {
    out += `{width=${Math.round(width)}}`;
  } else if (typeof width === "string" && width.trim() !== "") {
    out += `{width="${width.replace(/"/g, '\\"')}"}`;
  }
  return out;
}

function linkMarkdown(node: RichNode): string {
  const url = asString(node.attrs?.url);
  const title = node.attrs?.title == null ? url : asString(node.attrs.title);
  return `[${escapeInline(title || url)}](${url})`;
}

function pageEmbedMarkdown(node: RichNode): string {
  const id = asString(node.attrs?.pageId);
  const title = asString(node.attrs?.title);
  return `[${escapeInline(title || id)}](/w/…/${id})`;
}

/** Inline nodes (a paragraph's children) → Markdown. */
function inlineToMarkdown(nodes: readonly RichNode[] | undefined, ctx: Ctx): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    switch (node.type) {
      case "hardBreak":
        out += "  \n";
        break;
      case "mention":
        out += `@${escapeInline(asString(node.attrs?.label))}`;
        break;
      case "inlineMath":
        out += `$${asString(node.attrs?.latex)}$`;
        break;
      case "image":
        out += imageMarkdown(node, ctx);
        break;
      case "bookmark":
      case "embed":
        out += linkMarkdown(node);
        break;
      case "pageEmbed":
        out += pageEmbedMarkdown(node);
        break;
      default:
        if (typeof node.text === "string") out += renderText(node.text, node.marks, ctx.gfm);
        else out += inlineToMarkdown(node.content, ctx);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block serialisation
// ---------------------------------------------------------------------------

function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** Render a container's children: block children as blocks, else inline. */
function containerMarkdown(node: RichNode, ctx: Ctx): string {
  const kids = (node.content ?? []).filter(Boolean);
  if (kids.length === 0) return "";
  if (kids.some(isBlockNode)) {
    return kids
      .map((kid) => (isBlockNode(kid) ? blockToMarkdown(kid, ctx) : inlineToMarkdown([kid], ctx)))
      .filter((part) => part !== "")
      .join("\n\n");
  }
  return inlineToMarkdown(kids, ctx);
}

/** The `{lineNumbers caption="…"}` fence suffix the importer understands. */
function codeFenceOptions(attrs: RichNode["attrs"]): string {
  const parts: string[] = [];
  if (attrs?.lineNumbers) parts.push("lineNumbers");
  const caption = formatCaption(typeof attrs?.caption === "string" ? attrs.caption : null);
  if (caption) parts.push(`caption="${caption.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return parts.length > 0 ? ` {${parts.join(" ")}}` : "";
}

function codeBlockMarkdown(node: RichNode): string {
  const code = plainText(node.content);
  const fence = "`".repeat(Math.max(3, maxBacktickRun(code) + 1));
  const lang = node.attrs?.language == null ? "" : asString(node.attrs.language);
  return `${fence}${lang}${codeFenceOptions(node.attrs)}\n${code}\n${fence}`;
}

function blockquoteMarkdown(node: RichNode, ctx: Ctx): string {
  const inner = containerMarkdown(node, ctx);
  if (!inner) return "";
  const size = node.attrs?.size;
  const body =
    isPullQuoteSize(size) && size !== DEFAULT_PULL_QUOTE_SIZE ? `[!${size}]\n${inner}` : inner;
  return quoteLines(body);
}

function calloutMarkdown(node: RichNode, ctx: Ctx): string {
  const emoji = asString(node.attrs?.emoji) || "💡";
  const variant = asString(node.attrs?.variant) || asString(node.attrs?.color) || "note";
  const head = `[!${variant}] ${emoji}`;
  const inner = containerMarkdown(node, ctx);
  return quoteLines(inner ? `${head}\n\n${inner}` : head);
}

function toggleMarkdown(node: RichNode, ctx: Ctx): string {
  const summary = escapeInline(asString(node.attrs?.summary));
  const open = node.attrs?.open === true ? " open" : "";
  const inner = containerMarkdown(node, ctx);
  const head = `<details${open}>\n<summary>${summary}</summary>`;
  return inner ? `${head}\n\n${inner}\n\n</details>` : `${head}\n</details>`;
}

function listItemMarker(list: RichNode, item: RichNode, index: number, ctx: Ctx): string {
  if (list.type === "orderedList") {
    const start = Number(list.attrs?.start ?? 1);
    return `${(Number.isFinite(start) ? start : 1) + index}.`;
  }
  const checked = item.attrs?.checked;
  if (ctx.gfm && typeof checked === "boolean") return `- [${checked ? "x" : " "}]`;
  return "-";
}

function listToMarkdown(list: RichNode, ctx: Ctx): string {
  const lines: string[] = [];
  (list.content ?? []).forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const marker = listItemMarker(list, item, index, ctx);
    const kids = (item.content ?? []).filter(Boolean);
    const head = inlineToMarkdown(
      kids.filter((kid) => !CONTAINER_TYPES.has(kid.type ?? "")),
      ctx,
    );
    const headLines = head.split("\n");
    lines.push(head ? `${marker} ${headLines[0] ?? ""}` : marker);
    for (const continuation of headLines.slice(1)) lines.push(`${INDENT}${continuation}`);
    for (const kid of kids) {
      if (!CONTAINER_TYPES.has(kid.type ?? "")) continue;
      const nested = blockToMarkdown(kid, ctx);
      if (nested !== "") lines.push(indentNested(nested, 1));
    }
  });
  return lines.join("\n");
}

/** Split one escaped pipe row into its cell strings (a `\|` stays a pipe). */
function countTableCells(row: string): number {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  let count = 1;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "\\") {
      i += 1;
      continue;
    }
    if (trimmed[i] === "|") count += 1;
  }
  return count;
}

function tableMarkdown(table: RichNode, ctx: Ctx): string {
  const rows = (table.content ?? [])
    .map((row) =>
      (row?.content ?? []).map((cell) => inlineToMarkdown(cell?.content, ctx).replace(/\|/g, "\\|")),
    )
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return "";
  const header = rows[0];
  const pad = (cells: string[]): string[] => {
    const copy = cells.slice();
    while (copy.length < header.length) copy.push("");
    return copy;
  };
  const line = (cells: string[]): string => `| ${pad(cells).join(" | ")} |`;
  const separator = `| ${header.map(() => "---").join(" | ")} |`;
  return [line(header), separator, ...rows.slice(1).map(line)].join("\n");
}

function columnsMarkdown(node: RichNode, ctx: Ctx): string {
  const columns = (node.content ?? []).filter(Boolean);
  if (columns.length === 0) return ":::columns\n\n:::";
  const parts = columns.map((column) => {
    const body = containerMarkdown(column, ctx);
    return body ? `:::column\n\n${body}\n\n:::` : `:::column\n\n:::`;
  });
  return `:::columns\n\n${parts.join("\n\n")}\n\n:::`;
}

function unknownBlockToMarkdown(node: RichNode, ctx: Ctx): string {
  const kids = (node.content ?? []).filter(Boolean);
  if (kids.some(isBlockNode)) {
    return kids
      .map((kid) => (isBlockNode(kid) ? blockToMarkdown(kid, ctx) : inlineToMarkdown([kid], ctx)))
      .filter((part) => part !== "")
      .join("\n\n");
  }
  const inline = inlineToMarkdown(kids, ctx);
  if (inline !== "") return inline;
  if (typeof node.text === "string") return escapeInline(node.text);
  return "";
}

function blockToMarkdown(node: RichNode, ctx: Ctx): string {
  if (!node || typeof node !== "object") return ""; // junk in a selection must not throw
  switch (node.type) {
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      const text = inlineToMarkdown(node.content, ctx);
      return text ? `${"#".repeat(level)} ${text}` : "";
    }
    case "paragraph":
      return inlineToMarkdown(node.content, ctx);
    case "codeBlock":
      return codeBlockMarkdown(node);
    case "blockquote":
      return blockquoteMarkdown(node, ctx);
    case "bulletList":
    case "orderedList":
    case "taskList":
      return listToMarkdown(node, ctx);
    case "toggle":
      return toggleMarkdown(node, ctx);
    case "callout":
      return calloutMarkdown(node, ctx);
    case "image":
      return imageMarkdown(node, ctx);
    case "bookmark":
    case "embed":
      return linkMarkdown(node);
    case "pageEmbed":
      return pageEmbedMarkdown(node);
    case "blockMath":
      return `$$\n${asString(node.attrs?.latex)}\n$$`;
    case "table":
      return tableMarkdown(node, ctx);
    case "horizontalRule":
    case "divider":
      return "---";
    case "columns":
      return columnsMarkdown(node, ctx);
    case "column":
      return containerMarkdown(node, ctx);
    default:
      return unknownBlockToMarkdown(node, ctx);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Quote a scalar unless it is a safe bare YAML token. */
function frontMatterScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = asString(value);
  if (text === "") return '""';
  const needsQuotes =
    /[:#[\]{},&*!|>'"%@`]/.test(text) ||
    /^\s|\s$/.test(text) ||
    /^(?:true|false|null|~)$/i.test(text) ||
    /^[+-]?\d/.test(text);
  return needsQuotes ? `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : text;
}

function frontMatterValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(frontMatterScalar).join(", ")}]`;
  return frontMatterScalar(value);
}

function renderFrontMatter(data: Record<string, unknown> | undefined): string {
  if (!data || typeof data !== "object") return "";
  const keys = Object.keys(data);
  if (keys.length === 0) return "";
  return `---\n${keys.map((key) => `${key}: ${frontMatterValue(data[key])}`).join("\n")}\n---`;
}

// ---------------------------------------------------------------------------
// Public serialiser
// ---------------------------------------------------------------------------

/**
 * Serialise an editor document (`{ type: "doc", content: [...] }`, a bare
 * block, or an array of blocks) to fidelity Markdown. See the module header for
 * the round-trip conventions.
 */
export function docToMarkdownFidelity(doc: unknown, options: FidelityOptions = {}): string {
  const ctx: Ctx = { gfm: options.gfm !== false, imageBase: options.imageBase };
  const root = doc as RichNode | null;
  const content = Array.isArray(root?.content) ? root.content : [];
  const body = content
    .map((node) => blockToMarkdown(node, ctx))
    .filter((part) => part !== "")
    .join("\n\n")
    .trim();
  const front = renderFrontMatter(options.frontMatter);
  if (!front) return body;
  return body ? `${front}\n\n${body}` : front;
}

// ---------------------------------------------------------------------------
// Fidelity report
// ---------------------------------------------------------------------------

/**
 * Walk a document and report what a fidelity export cannot preserve: `lost`
 * collects features with no Markdown form (each with a reason), `approximated`
 * lists the encodings that are close but not byte-identical. Order is stable
 * (first-seen) and duplicates collapse.
 */
export function fidelityReport(doc: unknown): FidelityReport {
  const lost: FidelityLoss[] = [];
  const approximated = new Set<string>();
  const seen = new Set<string>();

  const addLost = (kind: string, reason: string): void => {
    const key = `${kind}\u0000${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    lost.push({ kind, reason });
  };

  const walk = (node: RichNode): void => {
    if (!node || typeof node !== "object") return;
    const type = node.type ?? "";

    for (const mark of node.marks ?? []) {
      if (LOSSY_MARKS.has(mark.type)) {
        addLost(mark.type, `the “${mark.type}” mark has no Markdown form`);
      }
    }

    if (type === "mention") {
      addLost("mention", "only the @label survives; the linked target id is dropped");
    } else if (type === "pageEmbed") {
      approximated.add("page embeds become a title link to a /w/… placeholder");
    } else if (type === "callout") {
      approximated.add("callouts are encoded as a GFM-style [!variant] alert marker");
    } else if (type === "toggle") {
      approximated.add("toggles are encoded as <details> HTML");
    } else if (type === "columns" || type === "column") {
      approximated.add("columns are encoded as fenced :::columns blocks");
    } else if (type === "table") {
      approximated.add("tables require GFM pipe syntax with escaped |");
    } else if (type === "blockMath" || type === "inlineMath") {
      approximated.add("equations keep their LaTeX source only");
    } else if (type === "image" && node.attrs?.width != null) {
      approximated.add("image width is encoded as a {width=…} suffix");
    } else if (type !== "" && !KNOWN_TYPES.has(type)) {
      addLost(type, `unknown block type “${type}” has no Markdown form`);
    }

    for (const child of node.content ?? []) walk(child);
  };

  const root = doc as RichNode | null;
  if (Array.isArray(root?.content)) for (const child of root.content) walk(child);
  return { lost, approximated: [...approximated] };
}

// ---------------------------------------------------------------------------
// Structural round-trip check
// ---------------------------------------------------------------------------

const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s/;

/** Flag tables whose rows disagree with the header or lack a separator. */
function tableIssues(lines: string[], fenced: boolean[]): string[] {
  const issues: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (fenced[i] || !lines[i].trim().startsWith("|")) {
      i += 1;
      continue;
    }
    const group: string[] = [];
    const firstLine = i;
    while (i < lines.length && !fenced[i] && lines[i].trim().startsWith("|")) {
      group.push(lines[i].trim());
      i += 1;
    }
    if (group.length < 2) {
      issues.push(`table on line ${firstLine + 1} has no separator row`);
      continue;
    }
    if (!group[1].includes("---")) {
      issues.push(`table on line ${firstLine + 1} is missing its --- separator row`);
    }
    const expected = countTableCells(group[0]);
    group.forEach((row, index) => {
      const cells = countTableCells(row);
      if (cells !== expected) {
        issues.push(
          `table row ${index + 1} on line ${firstLine + index + 1} has ${cells} cells, expected ${expected}`,
        );
      }
    });
  }
  return issues;
}

/** Flag list indentation that is not a multiple of the two-space step. */
function listIndentIssues(lines: string[], fenced: boolean[]): string[] {
  const issues: string[] = [];
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const match = LIST_ITEM.exec(line);
    if (!match) return;
    const indent = match[1].replace(/\t/g, "  ").length;
    if (indent % 2 !== 0) {
      issues.push(`list indentation of ${indent} spaces on line ${index + 1} is not a multiple of 2`);
    }
  });
  return issues;
}

/**
 * Structurally validate fidelity Markdown against a re-import: fences and
 * `:::` directives balance, `<details>` tags close, `$$` delimiters pair,
 * tables line up with their header, list indentation follows the two-space
 * step, and a leading frontmatter block is closed. It is a structural check,
 * not a semantic deep-equal — it answers "would this survive a re-import?"
 * without needing the original document.
 */
export function roundTripCheck(markdown: string): RoundTripCheck {
  const issues: string[] = [];
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const fenced = new Array<boolean>(lines.length).fill(false);

  // --- leading frontmatter -------------------------------------------------
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  let bodyStart = 0;
  if (lines[start]?.trim() === "---") {
    let close = -1;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        close = i;
        break;
      }
    }
    if (close === -1) issues.push("frontmatter block is never closed");
    else bodyStart = close + 1;
  }

  // --- fences, directives, details, math -----------------------------------
  let fence: string | null = null;
  let fenceOpen = -1;
  const directives: { kind: string; line: number }[] = [];
  let details = 0;
  let dollars = 0;

  for (let i = bodyStart; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();

    if (fence) {
      fenced[i] = true;
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }

    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      fence = fenceMatch[1].slice(0, 3);
      fenceOpen = i;
      fenced[i] = true;
      continue;
    }

    if (trimmed === "$$") {
      dollars += 1;
      continue;
    }

    if (trimmed.startsWith(":::")) {
      const info = trimmed.slice(3).trim();
      if (info === "") {
        if (directives.length === 0) issues.push(`stray ":::" closer on line ${i + 1}`);
        else directives.pop();
      } else {
        directives.push({ kind: info, line: i });
      }
      continue;
    }

    if (trimmed.startsWith("<details")) {
      details += 1;
    } else if (trimmed.startsWith("</details>")) {
      details -= 1;
      if (details < 0) {
        issues.push(`unbalanced </details> on line ${i + 1}`);
        details = 0;
      }
    }
  }

  if (fence) issues.push(`unclosed code fence opened on line ${fenceOpen + 1}`);
  for (const directive of directives) {
    issues.push(`unclosed :::${directive.kind} block opened on line ${directive.line + 1}`);
  }
  if (details > 0) issues.push("unbalanced <details> (never closed)");
  if (dollars % 2 !== 0) issues.push("unbalanced $$ math delimiter");

  // --- tables + list indentation ------------------------------------------
  issues.push(...tableIssues(lines, fenced));
  issues.push(...listIndentIssues(lines, fenced));

  return { ok: issues.length === 0, issues };
}

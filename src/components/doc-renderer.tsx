import type { CSSProperties, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { MermaidDiagram } from "@/components/diagrams/mermaid-diagram";
import { UmlDiagramView } from "@/components/diagrams/uml-diagram-view";
import { PlantUmlDiagram } from "@/components/diagrams/plantuml-diagram";
import { isPlantUmlLanguage } from "@/lib/diagrams/plantuml-policy";
import { isMermaidLanguage } from "@/lib/diagrams/mermaid-policy";
import { formatCaption, numberLines } from "@/lib/code-block";
import { tagClass, tagStyle, type TagHue } from "@/lib/design-tokens";
import { embedMeta, resolveEmbed } from "@/lib/embeds";
import { externalImageSrc } from "@/lib/external-image";
import { t } from "@/lib/i18n";
import { alignOf, alignStyle } from "@/lib/media";
import { contentDirProps, inlineBidiProps } from "@/lib/bidi";
import {
  blocksToQuote,
  formatPullQuote,
  parsePullQuote,
  type PullQuote,
  type PullQuoteBlock,
} from "@/lib/pull-quote";
import { buildTocItems, tocAnchorId, type TocHeading, type TocItem } from "@/lib/toc";
import { truncateMiddle } from "@/lib/truncate";
import { cn } from "@/lib/utils";
import { styleColor } from "@/lib/serialize";
import { validateLatex } from "@/lib/math-render";
import { describeButton, parseButtonBlock, parseTemplateButton } from "@/lib/template-blocks";
import { templateDefinition, type TemplateId } from "@/lib/templates";
import { sanitizeHref } from "@/lib/validation";

/**
 * Read-only renderer for a ProseMirror/TipTap document. Shared (no hooks) so it
 * can render on the server (synced views, future public pages) and on the
 * client. Unknown nodes fall back to rendering their children.
 */

type PMMark = { type: string; attrs?: Record<string, unknown> };
type PMNode = {
  type?: string;
  text?: string;
  marks?: PMMark[];
  attrs?: Record<string, unknown>;
  content?: PMNode[];
};

function applyMarks(node: PMNode, children: ReactNode, key: string): ReactNode {
  let element = children;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        element = <strong key={key}>{element}</strong>;
        break;
      case "italic":
        element = <em key={key}>{element}</em>;
        break;
      case "underline":
        element = <u key={key}>{element}</u>;
        break;
      case "strike":
        element = <s key={key}>{element}</s>;
        break;
      case "code":
        element = (
          <code
            key={key}
            className={docClasses("inlineCode")}
          >
            {element}
          </code>
        );
        break;
      case "highlight": {
        const color = styleColor(mark.attrs?.color);
        element = (
          <mark key={key} style={color ? { background: color } : undefined}>
            {element}
          </mark>
        );
        break;
      }
      case "textStyle": {
        const color = styleColor(mark.attrs?.color);
        element = color ? (
          <span key={key} style={{ color }}>
            {element}
          </span>
        ) : (
          element
        );
        break;
      }
      case "link": {
        const href = mark.attrs?.href as string | undefined;
        // H2 defence in depth: only allowlisted schemes render; everything
        // else (`javascript:` etc.) collapses to a same-page "#" target.
        element = href ? (
          <a
            key={key}
            href={sanitizeHref(href) ?? "#"}
            className={docClasses("link")}
            target="_blank"
            rel="noreferrer noopener"
          >
            {element}
          </a>
        ) : (
          element
        );
        break;
      }
      default:
        break;
    }
  }
  return element;
}

function renderInline(nodes: PMNode[] = []): ReactNode {
  return nodes.map((node, index) => {
    const key = `i${index}`;
    if (node.type === "hardBreak") return <br key={key} />;
    if (node.type === "mention") {
      const type = String(node.attrs?.type ?? "page");
      const glyph = type === "user" ? "👤" : type === "date" ? "🗓" : "📄";
      const label = String(node.attrs?.label ?? "");
      const direction = inlineBidiProps(label);
      return (
        <span
          key={key}
          dir={direction.dir}
          className={cn(
            "noema-mention",
            docClasses("mention"),
            mentionClass(type),
            direction.className,
          )}
          style={mentionStyle(type)}
        >
          {glyph} {label}
        </span>
      );
    }
    if (node.type === "inlineMath") {
      // LaTeX preview: the authored TeX is shown in place (mono-styled by
      // `.noema-math-inline`) and mirrored onto `data-latex`/`aria-label` so the
      // source survives round-trips and assistive tech can read it. Full KaTeX
      // rasterisation would need a raw-HTML injection sink, which this read path
      // deliberately does not have — tracked as a follow-up.
      const latex = String(node.attrs?.latex ?? "");
      const issue = validateLatex(latex)[0];
      return (
        <span
          key={key}
          className="noema-math-inline"
          data-latex={latex}
          data-math-error={issue?.message}
          role="math"
          aria-label={latex}
        >
          {latex}
          {issue ? (
            <span role="alert" className="noema-math-error">
              {issue.message}
            </span>
          ) : null}
        </span>
      );
    }
    const text = node.text ?? "";
    return <span key={key}>{applyMarks(node, text, key)}</span>;
  });
}

/** Notion-style block background colour (shared with the editor palette). */
type BlockColorProps = { "data-block-color"?: string; style?: CSSProperties };

function colorProps(node: PMNode): BlockColorProps {
  const color = node.attrs?.blockColor;
  if (!color) return {};
  return { "data-block-color": String(color), style: blockColorStyle(color) };
}

/**
 * Block background colours ride the tag palette (`--tag-<hue>-bg`) instead of
 * the raw hex the legacy `.noema-doc-renderer [data-block-color]` sheet used.
 * The inline value wins over that unlayered rule, so the token is what ships.
 */
const BLOCK_COLOR_HUES: Record<string, TagHue> = {
  gray: "gray",
  brown: "brown",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  blue: "blue",
  purple: "purple",
  pink: "pink",
  red: "red",
  teal: "teal",
};

/** Inline token background for a stored block colour, or undefined. */
function blockColorStyle(value: unknown): CSSProperties | undefined {
  const hue = typeof value === "string" ? BLOCK_COLOR_HUES[value] : undefined;
  return hue ? { backgroundColor: `var(--tag-${hue}-bg)` } : undefined;
}

/* -------------------------------------------------------------------------- *
 * Design-system mappings (docs/DESIGN_SYSTEM.md §1–§6).
 *
 * Pure and DOM-free, so node tests can pin the exact tokens the read path
 * renders: a block → class map, the reading measure a document wants, the
 * mention → tag palette map and the print class set. No component below
 * carries a raw hex, an ad-hoc radius or a magic spacing value — every value
 * is a token (`--surface-2`, `--radius-md`, the 4 px grid) or a `print:`
 * variant.
 * -------------------------------------------------------------------------- */

/** Reading measure for prose (§3, comfortable measure). Mirrors `share-dialog`. */
export const DOC_PROSE_MEASURE = "max-w-[720px]";
/** Reading measure for a document that embeds a database — wide enough for tables. */
export const DOC_WIDE_MEASURE = "max-w-[1100px]";

/** Node names that make a document "contain a database". */
export const DOC_DATABASE_NODE_TYPES: readonly string[] = [
  "linkedDatabase",
  "database",
  "inlineDatabase",
  "inline_database",
  "databaseView",
];

/**
 * Whether a stored document (or a raw content array) embeds a database. Walks
 * the ProseMirror tree generically and is cycle-safe, so malformed or hostile
 * content reads as "no database" rather than hanging.
 */
export function docHasDatabase(doc: unknown): boolean {
  const root = doc && typeof doc === "object" ? (doc as { content?: unknown }) : null;
  const stack: unknown[] = Array.isArray(root?.content) ? [...root.content] : [];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const record = node as { type?: unknown; content?: unknown };
    if (typeof record.type === "string" && DOC_DATABASE_NODE_TYPES.includes(record.type)) {
      return true;
    }
    if (Array.isArray(record.content)) {
      for (const child of record.content) stack.push(child);
    }
  }
  return false;
}

/** The centred reading measure a document should render at. */
export function docReadingMeasure(doc: unknown): string {
  return docHasDatabase(doc) ? DOC_WIDE_MEASURE : DOC_PROSE_MEASURE;
}

/** Token classes for one read-side block or inline kind. */
export const DOC_BLOCK_CLASS = {
  paragraph: "my-1 leading-[1.6] text-fg",
  heading: "mt-4 mb-1 font-semibold tracking-heading text-fg",
  bulletList: "my-1 list-disc ps-6",
  orderedList: "my-1 list-decimal ps-6",
  taskList: "my-1 list-none ps-0",
  listItem: "my-0.5",
  blockquote: "my-2 ps-3 text-muted",
  codeBlock:
    "my-2 overflow-x-auto rounded-control border border-border bg-surface-2 p-4 font-mono text-sm leading-[1.5] text-fg",
  inlineCode:
    "rounded-xs bg-surface-2 px-1 py-0.5 font-mono text-[0.85em] text-danger",
  divider: "my-4 border-0 border-t border-border",
  table: "my-2 w-full border-collapse text-sm",
  tableCell: "border border-border px-2 py-1.5 align-top",
  tableHeader: "bg-surface-2 text-start font-semibold",
  link: "u-colors text-accent underline decoration-accent-soft underline-offset-2 hover:decoration-accent",
  mention: "align-middle",
  callout: "my-2 flex gap-2 rounded-card border border-border bg-surface-2 px-4 py-3",
  toggle: "my-2",
  image: "h-auto max-w-full",
  imageCaption: "mt-1 text-center text-xs text-muted",
} as const;

export type DocBlockKind = keyof typeof DOC_BLOCK_CLASS;

/** Token classes for a block kind; an unknown kind falls back to the paragraph rhythm. */
export function docBlockClass(kind: string): string {
  return DOC_BLOCK_CLASS[kind as DocBlockKind] ?? DOC_BLOCK_CLASS.paragraph;
}

/** Print-only classes (§3): no chrome, no shadows, avoid breaking blocks. */
export const DOC_PRINT_CLASS = {
  /** The renderer root: never clip the measure when printing. */
  root: "print:max-w-none",
  /** Default per-block rule: keep a block whole across a page break. */
  block: "print:break-inside-avoid",
  /** Headings should not be orphaned from the block that follows. */
  heading: "print:break-after-avoid",
  /** Interactive chrome (TOC, breadcrumb, embeds, copy buttons) never prints. */
  hide: "print:hidden",
  /** Hairline borders keep their token on paper. */
  hairline: "print:border-border",
} as const;

/**
 * The print classes a block kind carries: content blocks/tables/code/quotes are
 * kept whole, headings avoid orphaning, chrome hides.
 */
export function docPrintClass(kind: string): string {
  switch (kind) {
    case "codeBlock":
    case "table":
    case "blockquote":
    case "image":
      return `${DOC_PRINT_CLASS.block} ${DOC_PRINT_CLASS.hairline}`;
    case "heading":
      return DOC_PRINT_CLASS.heading;
    default:
      return DOC_PRINT_CLASS.block;
  }
}

/** Screen + print token classes for a block kind. */
export function docClasses(kind: string): string {
  return cn(docBlockClass(kind), docPrintClass(kind));
}

/**
 * Mention kinds → tag palette hue (pages gray, people blue, dates orange).
 */
export const MENTION_HUE: Record<string, TagHue> = {
  page: "gray",
  user: "blue",
  date: "orange",
};

/** Tag-palette hue for a mention kind; an unknown kind reads as a page. */
export function mentionHue(type: string): TagHue {
  return MENTION_HUE[type] ?? "gray";
}

/** `tag tag-<hue>` classes for a mention chip. */
export function mentionClass(type: string): string {
  return tagClass(mentionHue(type));
}

/** Inline token style for a mention chip (the tag palette). */
export function mentionStyle(type: string): Record<string, string> {
  return tagStyle(mentionHue(type));
}

/**
 * The `@media print` block for the read path (§3): clean margins, no shadows,
 * `--border` hairlines, `break-inside: avoid` on blocks/code/tables, break
 * control on headings and hidden interactive chrome. Scoped to the two read
 * containers so it never leaks into the editor. Rendered as a `<style>` by
 * {@link ReadPrintStyles}.
 */
export const DOC_PRINT_CSS = `@media print {
  @page { margin: 16mm; }
  .noema-doc-renderer,
  .notion-markdown { max-width: none; }
  .noema-doc-renderer *,
  .notion-markdown * { box-shadow: none !important; }
  .noema-doc-renderer pre,
  .noema-doc-renderer table,
  .noema-doc-renderer blockquote,
  .noema-doc-renderer li,
  .noema-doc-renderer .noema-callout,
  .notion-code,
  .notion-markdown table,
  .notion-markdown blockquote,
  .notion-markdown li {
    break-inside: avoid;
    border-color: var(--border);
  }
  .noema-doc-renderer h1,
  .noema-doc-renderer h2,
  .noema-doc-renderer h3,
  .notion-markdown h1,
  .notion-markdown h2,
  .notion-markdown h3 { break-after: avoid; }
  .noema-doc-renderer a[href],
  .notion-markdown a[href] { color: inherit; }
}`;

/**
 * The `@media print` stylesheet as an element. Rendered by both read surfaces;
 * the rules are scoped to their containers, so a second copy is harmless.
 */
export function ReadPrintStyles() {
  return <style>{DOC_PRINT_CSS}</style>;
}

/** A read-side breadcrumb crumb (editor twin: `BreadcrumbCrumb`). */
export type DocRendererBreadcrumb = { id: string; title: string };

/**
 * Heading outline for the read-only TOC block. Built once per `DocRenderer`
 * pass, in document order, so the headings and the outline agree on one set of
 * view-local anchors — the exact slug strategy `src/lib/toc.ts` pins for the
 * editor (`TocView`). `slugByNode` is keyed by node identity: the same walk that
 * collects the outline also records which heading node owns which slug, so no
 * cursor has to thread through the recursive render.
 */
interface HeadingOutline {
  items: TocItem[];
  slugByNode: Map<PMNode, string>;
}

/** Optional per-document view data the block tree alone cannot carry. */
interface RenderContext {
  headings: HeadingOutline;
  breadcrumb: { trail: readonly DocRendererBreadcrumb[]; workspaceSlug?: string };
}

/* -------------------------------------------------------------------------- *
 * Read-side block variants: pull quotes and the two optional code-block
 * affordances. Both delegate their semantics to the shared libs so the editor,
 * the read paths and the unit tests agree on one definition.
 * -------------------------------------------------------------------------- */

/** Flatten a node's inline text (a code block's code, a paragraph's words, …). */
function nodeText(node: PMNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(nodeText).join("");
}

/** Project a read-side block into `pull-quote.ts`'s minimal block shape. */
function pullQuoteBlockOf(node: PMNode): PullQuoteBlock {
  const text = nodeText(node).trim();
  const block: PullQuoteBlock = {
    type: node.type === "blockquote" ? "blockquote" : "paragraph",
    content: text ? [{ type: "text", text }] : [],
  };
  if (node.type === "blockquote" && node.attrs?.size === "large") {
    block.attrs = { size: "large" };
  }
  return block;
}

/**
 * Read a `size: "large"` blockquote as a pull quote through `pull-quote.ts`.
 * Returns undefined for a normal blockquote — or a large one the lib rejects
 * (blank text) — so it keeps the ordinary blockquote rendering untouched.
 */
function pullQuoteOf(node: PMNode): PullQuote | undefined {
  if (node.type !== "blockquote" || node.attrs?.size !== "large") return undefined;
  const parsed = parsePullQuote({ text: nodeText(node), size: "large" });
  return parsed.ok ? parsed.value : undefined;
}

/**
 * Resolve a top-level pull-quote pair: the `large` blockquote plus the optional
 * attribution paragraph that `quoteToBlocks` writes immediately after it. The
 * lib strips a leading dash when it reads the pair back, so a following
 * paragraph only counts as an attribution when that strip changes its text; a
 * plain paragraph is left in place for normal rendering.
 */
function resolvePullQuote(
  node: PMNode,
  next: PMNode | undefined,
): { quote?: PullQuote; consumed: boolean } {
  const base = pullQuoteOf(node);
  if (!base) return { consumed: false };
  if (!next || next.type !== "paragraph") return { quote: base, consumed: false };

  const nextText = nodeText(next).trim();
  if (!nextText) return { quote: base, consumed: false };

  const parsed = parsePullQuote(blocksToQuote([pullQuoteBlockOf(node), pullQuoteBlockOf(next)]));
  if (!parsed.ok) return { quote: base, consumed: false };
  const { attribution } = parsed.value;
  if (attribution === undefined || attribution === nextText) {
    return { quote: base, consumed: false };
  }
  return { quote: parsed.value, consumed: true };
}

/** Display-scale pull quote — the read-side twin of the editor's decoration. */
function renderPullQuote(quote: PullQuote, node: PMNode, key: string): ReactNode {
  const direction = contentDirProps(quote.text);
  return (
    <blockquote
      key={key}
      {...colorProps(node)}
      dir={direction.dir}
      className={cn(
        "noema-pull-quote text-[1.5em] font-semibold leading-[1.45]",
        DOC_PRINT_CLASS.block,
        direction.className,
      )}
      data-pull-quote=""
      data-size="large"
      title={formatPullQuote(quote)}
    >
      {quote.text}
      {quote.attribution !== undefined && (
        <footer
          className="noema-pull-quote-attribution text-end text-[0.9em] font-normal opacity-75"
        >
          {"\u2014 "}
          <bdi>{quote.attribution}</bdi>
        </footer>
      )}
    </blockquote>
  );
}

/* -------------------------------------------------------------------------- *
 * Table of contents + breadcrumb: the two "chrome" blocks. Both are view-local
 * projections — the TOC derives its outline from the document's headings (never
 * persisted ids) and the breadcrumb reads the ancestor trail the caller already
 * fetched, mirroring `src/components/editor/extensions/{custom-blocks,breadcrumb}`.
 * -------------------------------------------------------------------------- */

/** Collect every heading, in document order, plus its view-local anchor slug. */
function collectHeadingOutline(nodes: readonly PMNode[]): HeadingOutline {
  const headings: TocHeading[] = [];
  const headingNodes: PMNode[] = [];
  const visit = (list: readonly PMNode[]): void => {
    for (const node of list) {
      if (node.type === "heading") {
        const text = nodeText(node).trim();
        if (text) {
          headingNodes.push(node);
          headings.push({ level: Number(node.attrs?.level) || 1, text, pos: headings.length });
        }
      }
      if (node.content) visit(node.content);
    }
  };
  visit(nodes);
  const items = buildTocItems(headings);
  const slugByNode = new Map<PMNode, string>();
  headingNodes.forEach((node, index) => {
    const item = items[index];
    if (item) slugByNode.set(node, item.slug);
  });
  return { items, slugByNode };
}

function renderToc(items: readonly TocItem[], locale: string, key: string): ReactNode {
  return (
    <div key={key} className={cn("noema-toc", DOC_PRINT_CLASS.hide)} data-toc="">
      <p className="noema-toc-title">{t(locale, "blockTableOfContents")}</p>
      {items.length === 0 ? (
        <p className="noema-toc-empty">{t(locale, "tocEmpty")}</p>
      ) : (
        <ul>
          {items.map((item) => (
            // `#`-anchors (not editor buttons): the read path has no editor to
            // scroll, so a plain deep link is the honest behaviour.
            <li
              key={item.slug}
              style={{ paddingInlineStart: `calc(${item.level - 1} * var(--space-4))` }}
            >
              <a href={`#${tocAnchorId(item.slug)}`} className={docClasses("link")}>
                {item.text}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Longest breadcrumb label rendered, in code points — mirror of the editor's
 * `breadcrumb.tsx` so read-only and editor trails elide identically.
 */
const BREADCRUMB_LABEL_MAX = 40;

/** Parse a trail stored on the block itself (imports/future writers), if any. */
function crumbsFromAttrs(node: PMNode): DocRendererBreadcrumb[] {
  const raw = node.attrs?.trail ?? node.attrs?.crumbs;
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const crumbs: DocRendererBreadcrumb[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id === "string" && id !== "") {
      crumbs.push({ id, title: typeof record.title === "string" ? record.title : "" });
    }
  }
  return crumbs;
}

function renderBreadcrumb(
  crumbs: readonly DocRendererBreadcrumb[],
  workspaceSlug: string | undefined,
  locale: string,
  key: string,
): ReactNode {
  return (
    <div key={key} className={cn("noema-breadcrumb", DOC_PRINT_CLASS.hide)} data-breadcrumb="">
      {crumbs.length === 0 ? (
        <span className="noema-breadcrumb-empty">{t(locale, "breadcrumbNoParents")}</span>
      ) : (
        <span className="noema-breadcrumb-trail">
          {crumbs.map((crumb, index) => (
            <span key={crumb.id} className="noema-breadcrumb-item">
              {workspaceSlug ? (
                <a href={`/w/${workspaceSlug}/${crumb.id}`} className={docClasses("link")}>
                  {truncateMiddle(crumb.title || t(locale, "untitled"), BREADCRUMB_LABEL_MAX)}
                </a>
              ) : (
                <span>
                  {truncateMiddle(crumb.title || t(locale, "untitled"), BREADCRUMB_LABEL_MAX)}
                </span>
              )}
              {index < crumbs.length - 1 && <span className="noema-breadcrumb-sep">/</span>}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Tables: read-side twin of the editor's TableKit rendering. Header cells get
 * the same visual weight as the editor (`var(--surface)`, ≥600) and a real
 * `scope` (R84.5 — `<th scope="col">` / `<th scope="row">`), and per-cell
 * background colours ride the same attr the block-colour palette uses.
 * -------------------------------------------------------------------------- */

/** Conservative CSS-colour shape: hex, rgb/hsl() or a bare keyword. */
const SAFE_CELL_COLOR =
  /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\)|[a-zA-Z]+)$/;

function cellColor(cell: PMNode): string | undefined {
  const raw = cell.attrs?.backgroundColor ?? cell.attrs?.blockColor;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value !== "" && SAFE_CELL_COLOR.test(value) ? value : undefined;
}

function cellSpan(cell: PMNode, name: "colspan" | "rowspan"): number | undefined {
  const value = cell.attrs?.[name];
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : undefined;
}

function renderTable(node: PMNode, key: string, locale: string, ctx: RenderContext): ReactNode {
  const rows = node.content ?? [];
  return (
    <table key={key} {...colorProps(node)} className={docClasses("table")}>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={`${key}.${rowIndex}`}>
            {(row.content ?? []).map((cell, colIndex) => {
              const header = cell.type === "tableHeader";
              const color = cellColor(cell);
              const style: CSSProperties | undefined = header
                ? { background: color ?? "var(--surface-2)" }
                : color
                  ? { background: color }
                  : undefined;
              const content = (cell.content ?? []).map((child, index) =>
                renderBlock(child, `${key}.${rowIndex}.${colIndex}.${index}`, locale, ctx),
              );
              const shared = {
                colSpan: cellSpan(cell, "colspan"),
                rowSpan: cellSpan(cell, "rowspan"),
                "data-cell-color": color,
                className: docClasses(header ? "tableHeader" : "tableCell"),
                style,
              };
              // A header row (`tableHeader` in row 0) reads as columns; any
              // `tableHeader` further down is a header *column*, so it reads as
              // a row header.
              return header ? (
                <th key={`${key}.${rowIndex}.${colIndex}`} {...shared} scope={rowIndex === 0 ? "col" : "row"}>
                  {content}
                </th>
              ) : (
                <td key={`${key}.${rowIndex}.${colIndex}`} {...shared}>
                  {content}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderBlock(
  node: PMNode,
  key: string,
  locale: string,
  ctx: RenderContext,
  quote?: PullQuote,
): ReactNode {
  switch (node.type) {
    case "paragraph": {
      // User-authored prose: its own first strong character sets the base
      // direction, so mixed text never inherits the wrong side from the
      // document locale. `dir-mixed` isolates the run from its neighbours.
      const direction = contentDirProps(nodeText(node));
      return (
        <p
          key={key}
          {...colorProps(node)}
          dir={direction.dir}
          className={cn(docClasses("paragraph"), direction.className)}
        >
          {renderInline(node.content)}
        </p>
      );
    }
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      // Stamp the view-local anchor so TOC deep links land on the heading; the
      // id is derived at render time and never written back to the document.
      const slug = ctx.headings.slugByNode.get(node);
      const direction = contentDirProps(nodeText(node));
      return (
        <Tag
          key={key}
          {...colorProps(node)}
          dir={direction.dir}
          className={cn(docClasses("heading"), direction.className)}
          id={slug ? tocAnchorId(slug) : undefined}
        >
          {renderInline(node.content)}
        </Tag>
      );
    }
    case "bulletList":
      return (
        <ul key={key} {...colorProps(node)} className={docClasses("bulletList")}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} {...colorProps(node)} className={docClasses("orderedList")}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </ol>
      );
    case "taskList":
      return (
        <ul key={key} className={cn("noema-render-tasks", docClasses("taskList"))} {...colorProps(node)}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </ul>
      );
    case "listItem":
    case "taskItem": {
      const checked = node.type === "taskItem" && Boolean(node.attrs?.checked);
      return (
        <li key={key} {...colorProps(node)} className={docClasses("listItem")}>
          {node.type === "taskItem" && (
            <input type="checkbox" checked={checked} readOnly className="me-2 align-middle" />
          )}
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </li>
      );
    }
    case "blockquote": {
      // A `size: "large"` quote (already resolved with any attribution
      // paragraph) renders at display scale; everything else is unchanged.
      const pullQuote = quote ?? pullQuoteOf(node);
      if (pullQuote) return renderPullQuote(pullQuote, node, key);
      const direction = contentDirProps(nodeText(node));
      return (
        <blockquote
          key={key}
          {...colorProps(node)}
          dir={direction.dir}
          className={cn(docClasses("blockquote"), direction.className)}
          style={{ borderInlineStart: "3px solid var(--border-strong)", ...colorProps(node).style }}
        >
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </blockquote>
      );
    }
    case "codeBlock": {
      // Mermaid is stored as a normal code block; the source stays in the
      // document, while the read side renders the SVG after hydration. Keeping
      // this on the same node is what makes the existing collaboration,
      // import/export and version-history paths work unchanged.
      const language = String(node.attrs?.language ?? "").trim();
      if (isMermaidLanguage(language)) {
        return (
          <MermaidDiagram
            key={key}
            source={nodeText(node)}
            caption={formatCaption(typeof node.attrs?.caption === "string" ? node.attrs.caption : "")}
          />
        );
      }
      if (isPlantUmlLanguage(language)) {
        return (
          <PlantUmlDiagram
            key={key}
            source={nodeText(node)}
            caption={formatCaption(typeof node.attrs?.caption === "string" ? node.attrs.caption : "")}
          />
        );
      }
      const codeClass = language ? `language-${language}` : undefined;
      const rawCaption = node.attrs?.caption;
      const caption = formatCaption(typeof rawCaption === "string" ? rawCaption : null);
      const showLineNumbers = Boolean(node.attrs?.lineNumbers);
      const blockColor = colorProps(node);
      // Code reads on `--surface-2` behind a `--border` hairline with the mono
      // token, whatever raw values the legacy sheet used.
      const codeStyle: CSSProperties = {
        backgroundColor: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        fontFamily: "var(--font-mono)",
        ...blockColor.style,
      };

      // Unchanged fast path: neither optional affordance is on, so emit exactly
      // the markup this renderer produced before.
      if (!showLineNumbers && caption === "") {
        return (
          <pre key={key} {...blockColor} className={docClasses("codeBlock")} style={codeStyle}>
            <code className={codeClass} data-language={language || undefined}>
              {renderInline(node.content)}
            </code>
          </pre>
        );
      }

      const gutter = showLineNumbers ? numberLines(nodeText(node)) : [];
      return (
        <div key={key} className="noema-code-block-view print:break-inside-avoid">
          <pre
            {...blockColor}
            className={cn(docClasses("codeBlock"), showLineNumbers && "flex gap-3 overflow-visible")}
            style={codeStyle}
          >
            {showLineNumbers && (
              <div
                aria-hidden="true"
                className="noema-code-gutter select-none text-end text-muted tabular-nums"
              >
                {gutter.map((row, index) => (
                  <div key={`${index}-${row.n ?? "wrap"}`}>{row.n === null ? "\u00a0" : row.n}</div>
                ))}
              </div>
            )}
            <code
              className={codeClass}
              data-language={language || undefined}
              style={showLineNumbers ? { flex: 1, minWidth: 0, overflowX: "auto" } : undefined}
            >
              {renderInline(node.content)}
            </code>
          </pre>
          {caption !== "" && <p className="noema-image-caption-view">{caption}</p>}
        </div>
      );
    }
    case "umlDiagram":
      return <UmlDiagramView key={key} data={node.attrs?.data} diagramId={String(node.attrs?.id ?? key)} readOnly />;
    case "horizontalRule":
      return <hr key={key} className={docClasses("divider")} />;
    case "image": {
      const caption = String(node.attrs?.caption ?? "").trim();
      const width = typeof node.attrs?.width === "number" ? node.attrs.width : null;
      const align = alignOf(node.attrs?.align);
      // B69: a picture that lives on another host is fetched by the SERVER
      // (the proxy route), never by the visitor's browser. Otherwise opening a
      // shared page tells that host the visitor's IP address - and the
      // `Referer` of the share page, which names the instance. An upload (a
      // relative path) is untouched, and a reference that cannot be served at
      // all renders nothing.
      const src = externalImageSrc(node.attrs?.src);
      if (src === "") return null;
      return (
        <figure
          key={key}
          className={cn("noema-image-block", docClasses("image"))}
          data-width={width === null ? undefined : `${width}%`}
          data-align={align}
          style={{ width: width === null ? undefined : `${width}%`, ...alignStyle(align) }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={String(node.attrs?.alt ?? "")}
            className="noema-image"
            style={{ borderRadius: "var(--radius-md)" }}
          />
          {caption !== "" && (
            <figcaption className={cn("noema-image-caption-view", docClasses("imageCaption"))}>
              {caption}
            </figcaption>
          )}
        </figure>
      );
    }
    case "callout":
      return (
        <div key={key} className={cn("noema-callout", docClasses("callout"))}>
          <span className="noema-callout-emoji">{String(node.attrs?.emoji ?? "💡")}</span>
          <div className="noema-callout-content">
            {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
          </div>
        </div>
      );
    case "toggle":
      return (
        <details
          key={key}
          open={Boolean(node.attrs?.open)}
          className={cn("noema-toggle", docClasses("toggle"))}
          {...colorProps(node)}
        >
          <summary>{String(node.attrs?.summary ?? t(locale, "toggleFallback"))}</summary>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </details>
      );
    case "columns":
      return (
        <div key={key} data-columns="">
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </div>
      );
    case "column":
      return (
        <div key={key} data-column="">
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </div>
      );
    case "table":
      return renderTable(node, key, locale, ctx);
    case "blockMath": {
      // LaTeX preview, block form: centred, mono-styled (`.noema-math-block`),
      // with the source mirrored onto `data-latex`/`aria-label`. Structural
      // errors are reported inline; this path never injects authored HTML.
      const latex = String(node.attrs?.latex ?? "");
      const issue = validateLatex(latex)[0];
      return (
        <div
          key={key}
          className={cn("noema-math-block", DOC_PRINT_CLASS.block)}
          data-latex={latex}
          data-math-error={issue?.message}
          role="math"
          aria-label={latex}
        >
          {latex}
          {issue ? (
            <p role="alert" className="noema-math-error">
              {issue.message}
            </p>
          ) : null}
        </div>
      );
    }
    case "tableOfContents":
      return renderToc(ctx.headings.items, locale, key);
    case "breadcrumb": {
      const attrsCrumbs = crumbsFromAttrs(node);
      const crumbs = attrsCrumbs.length > 0 ? attrsCrumbs : ctx.breadcrumb.trail;
      return renderBreadcrumb(crumbs, ctx.breadcrumb.workspaceSlug, locale, key);
    }
    case "templateButton": {
      // Read-only twin of the editor atom. There is no editor to insert into
      // here, so the card shows what the button would insert instead of
      // pretending to be clickable.
      const parsed = parseTemplateButton({
        id: String(node.attrs?.id ?? "templateButton"),
        templateId: String(node.attrs?.templateId ?? ""),
        label: String(node.attrs?.label ?? ""),
      });
      const templateId = parsed?.templateId ?? String(node.attrs?.templateId ?? "");
      const label =
        parsed?.label?.trim() ||
        templateDefinition(templateId as TemplateId)?.label ||
        t(locale, "blockTemplateButton");
      return (
        <div
          key={key}
          className={cn(
            DOC_PRINT_CLASS.block,
            "my-2 inline-flex items-center gap-2 rounded-control border border-border bg-surface px-3 py-1.5 text-sm text-fg",
          )}
          data-template-button=""
          data-template-id={parsed?.templateId}
          aria-label={t(locale, "blockTemplateButton")}
        >
          <span aria-hidden="true">📄</span>
          <span>{label}</span>
        </div>
      );
    }
    case "button": {
      // A Button block is interactive in the editor only. The read path renders
      // its label and configured action as a disabled, honest summary.
      const parsed = parseButtonBlock({
        id: String(node.attrs?.id ?? "button"),
        label: String(node.attrs?.label ?? ""),
        style: node.attrs?.style,
        confirm: node.attrs?.confirm,
        action: node.attrs?.action,
      });
      const label = parsed?.label?.trim() || t(locale, "blockButton");
      const description = parsed ? describeButton(parsed) : t(locale, "configureButtonFirst");
      return (
        <div
          key={key}
          className={cn(DOC_PRINT_CLASS.block, "my-2 flex flex-wrap items-center gap-2 text-sm")}
          data-button-block=""
        >
          <button
            type="button"
            disabled
            aria-label={`${label}: ${description}`}
            className="rounded-control border border-border bg-surface px-3 py-1.5 text-sm text-fg opacity-70"
          >
            {label}
          </button>
          <span className="text-xs text-muted">{description}</span>
        </div>
      );
    }
    case "bookmark": {
      const url = String(node.attrs?.url ?? "");
      const host = String(node.attrs?.host ?? "");
      const icon = node.attrs?.icon ? String(node.attrs.icon) : null;
      const title = String(node.attrs?.title ?? host ?? url);
      const description = node.attrs?.description ? String(node.attrs.description) : "";
      const image = node.attrs?.image ? String(node.attrs.image) : null;
      // B69: the favicon and the og:image of a bookmark are third-party
      // pictures too - they go through the server's proxy like every other
      // external picture.
      const iconSrc = externalImageSrc(icon);
      const imageSrc = externalImageSrc(image);
      return (
        <div key={key} className="noema-bookmark-card print:break-inside-avoid" data-bookmark="">
          <a
            href={sanitizeHref(url) ?? "#"}
            className="noema-bookmark-link"
            target="_blank"
            rel="noreferrer noopener"
          >
            <span className="noema-bookmark-text">
              {iconSrc !== "" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={iconSrc} alt="" className="noema-bookmark-favicon" />
              )}
              <span className="noema-bookmark-title">{title}</span>
              {description && <span className="noema-bookmark-desc">{description}</span>}
              {host && <span className="noema-bookmark-host">{host}</span>}
            </span>
            {imageSrc !== "" && (
              // eslint-disable-next-line @next/next/no-img-element -- og:image thumbnail
              <img src={imageSrc} alt="" className="noema-bookmark-image" />
            )}
          </a>
        </div>
      );
    }
    case "embed": {
      // Stored content is untrusted (old rows, imports, API writes): the URL
      // is re-resolved through the provider registry here rather than trusting
      // a persisted `provider`, so the iframe `src`, `sandbox` and `allow` all
      // come from ONE allowlisted source. Non-http(s), unknown/lookalike hosts
      // and allowlisted hosts with no canonical embed resolve to null and
      // degrade to a plain (scheme-gated) link - never an arbitrary iframe.
      const url = String(node.attrs?.url ?? "");
      const resolved = resolveEmbed(url);
      if (!resolved) {
        return (
          <a
            key={key}
            href={sanitizeHref(url) ?? "#"}
            className={docClasses("link")}
            target="_blank"
            rel="noreferrer noopener"
          >
            {url}
          </a>
        );
      }
      const meta = embedMeta(resolved.provider);
      return (
        <iframe
          key={key}
          src={resolved.embedUrl}
          data-provider={resolved.provider}
          title={meta?.title ?? t(locale, "embeddedContent")}
          className={cn("noema-embed-frame", DOC_PRINT_CLASS.hide)}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox={resolved.sandbox}
          allow={resolved.allow}
          allowFullScreen
          style={meta ? { aspectRatio: meta.aspectRatio } : undefined}
        />
      );
    }
    default:
      return (
        <div key={key}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}</div>
      );
  }
}

/** The read-path document states (docs/DESIGN_SYSTEM.md §8). */
export type DocRendererState = "ready" | "loading" | "error";

/**
 * Loading skeleton for a document: a heading bar, paragraph lines and a table
 * stub, inside the same reading measure the document will render at. Shapes
 * match the final layout (§8) so nothing shifts when the content lands.
 */
export function DocRendererSkeleton({
  blocks = 3,
  measure = DOC_PROSE_MEASURE,
}: {
  /** Body paragraphs between the heading and the table stub (1–6). */
  blocks?: number;
  /** Reading measure class; defaults to the prose measure. */
  measure?: string;
}) {
  const paragraphs = Math.max(1, Math.min(6, Math.trunc(blocks)));
  return (
    <div
      className={cn("noema-doc-renderer mx-auto w-full space-y-4", measure)}
      data-doc-state="loading"
      aria-busy="true"
    >
      <ReadPrintStyles />
      <Skeleton variant="block" className="h-7 w-2/5" />
      {Array.from({ length: paragraphs }, (_, index) => (
        <Skeleton key={index} variant="text" lines={index === 0 ? 2 : 3} />
      ))}
      <Skeleton variant="table" rows={2} cols={3} />
    </div>
  );
}

/**
 * Error state for a document (§8): message + optional retry. The retry renders
 * only when a client caller passes `onRetry`; the server read paths show the
 * message alone (a server component cannot carry a handler).
 */
export function DocRendererError({
  message,
  onRetry,
  measure = DOC_PROSE_MEASURE,
}: {
  message?: ReactNode;
  onRetry?: () => void;
  measure?: string;
}) {
  return (
    <div
      className={cn("noema-doc-renderer mx-auto w-full", measure)}
      data-doc-state="error"
      role="alert"
    >
      <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-danger-soft px-4 py-3 text-sm">
        <p className="m-0 font-medium text-danger">
          {message ?? "This document could not be rendered."}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="focus-ring u-interactive rounded-control border-control bg-bg px-2 py-1 text-xs text-fg"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function DocRenderer({
  doc,
  locale = "en",
  breadcrumbTrail,
  workspaceSlug,
  state = "ready",
  errorMessage,
  onRetry,
}: {
  doc: unknown;
  /** Callers without a locale source (public share page, editor) keep en. */
  locale?: string;
  /** Ancestor trail for the read-side breadcrumb block (from `getAncestorTrail`). */
  breadcrumbTrail?: readonly DocRendererBreadcrumb[];
  /** Workspace slug, so rendered breadcrumb crumbs link like the editor's. */
  workspaceSlug?: string;
  /** The read path never fetches; a caller can drive these two states (§8). */
  state?: DocRendererState;
  /** Error copy; falls back to a generic message. */
  errorMessage?: ReactNode;
  /** Retry handler for the error state (client callers only). */
  onRetry?: () => void;
}) {
  if (state === "loading") return <DocRendererSkeleton />;
  if (state === "error") return <DocRendererError message={errorMessage} onRetry={onRetry} />;

  const root = doc as PMNode | null;
  if (root === null || root === undefined) return null;
  if (!Array.isArray(root.content)) {
    return <DocRendererError message={errorMessage} onRetry={onRetry} />;
  }
  const nodes: PMNode[] = root.content;
  const ctx: RenderContext = {
    headings: collectHeadingOutline(nodes),
    breadcrumb: { trail: breadcrumbTrail ?? [], workspaceSlug },
  };
  const rendered: ReactNode[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    // A large blockquote may consume the attribution paragraph right after it;
    // every other node (and key) is untouched.
    const { quote, consumed } = resolvePullQuote(nodes[index], nodes[index + 1]);
    rendered.push(renderBlock(nodes[index], `b${index}`, locale, ctx, quote));
    if (consumed) index += 1;
  }
  return (
    <div
      className={cn(
        "noema-doc-renderer mx-auto w-full",
        docReadingMeasure(root),
        DOC_PRINT_CLASS.root,
      )}
      data-doc-state="ready"
    >
      <ReadPrintStyles />
      {rendered}
    </div>
  );
}

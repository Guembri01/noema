import type { CSSProperties, ReactNode } from "react";
import { formatCaption, numberLines } from "@/lib/code-block";
import { embedMeta, resolveEmbed } from "@/lib/embeds";
import { t } from "@/lib/i18n";
import { alignOf, alignStyle } from "@/lib/media";
import {
  blocksToQuote,
  formatPullQuote,
  parsePullQuote,
  type PullQuote,
  type PullQuoteBlock,
} from "@/lib/pull-quote";
import { buildTocItems, tocAnchorId, type TocHeading, type TocItem } from "@/lib/toc";
import { truncateMiddle } from "@/lib/truncate";
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
        element = <code key={key}>{element}</code>;
        break;
      case "highlight":
        element = (
          <mark key={key} style={{ background: (mark.attrs?.color as string) ?? undefined }}>
            {element}
          </mark>
        );
        break;
      case "textStyle": {
        const color = mark.attrs?.color as string | undefined;
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
          <a key={key} href={sanitizeHref(href) ?? "#"} target="_blank" rel="noreferrer noopener">
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
      return (
        <span key={key} className="noema-mention">
          {glyph} {String(node.attrs?.label ?? "")}
        </span>
      );
    }
    if (node.type === "inlineMath") {
      // LaTeX preview: the authored TeX is shown in place (mono-styled by
      // `.noema-math-inline`) and mirrored onto `data-latex`/`aria-label` so the
      // source survives round-trips and assistive tech can read it. Full KaTeX
      // rasterisation here would need the dangerouslySetInnerHTML allow-list
      // (see scripts/check-coherence.mjs) — tracked as a follow-up.
      const latex = String(node.attrs?.latex ?? "");
      return (
        <span
          key={key}
          className="noema-math-inline"
          data-latex={latex}
          role="math"
          aria-label={latex}
        >
          {latex}
        </span>
      );
    }
    const text = node.text ?? "";
    return <span key={key}>{applyMarks(node, text, key)}</span>;
  });
}

/** Notion-style block background colour (shared with the editor palette). */
function colorProps(node: PMNode): Record<string, string> {
  const color = node.attrs?.blockColor;
  return color ? { "data-block-color": String(color) } : {};
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
  return (
    <blockquote
      key={key}
      {...colorProps(node)}
      className="noema-pull-quote"
      data-pull-quote=""
      data-size="large"
      style={{ fontSize: "1.5em", fontWeight: 600, lineHeight: 1.45 }}
      title={formatPullQuote(quote)}
    >
      {quote.text}
      {quote.attribution !== undefined && (
        <footer
          className="noema-pull-quote-attribution"
          style={{ fontSize: "0.9em", fontWeight: 400, opacity: 0.75, textAlign: "right" }}
        >
          {"\u2014 "}
          {quote.attribution}
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
    <div key={key} className="noema-toc" data-toc="">
      <p className="noema-toc-title">{t(locale, "blockTableOfContents")}</p>
      {items.length === 0 ? (
        <p className="noema-toc-empty">{t(locale, "tocEmpty")}</p>
      ) : (
        <ul>
          {items.map((item) => (
            // `#`-anchors (not editor buttons): the read path has no editor to
            // scroll, so a plain deep link is the honest behaviour.
            <li key={item.slug} style={{ paddingLeft: (item.level - 1) * 16 }}>
              <a href={`#${tocAnchorId(item.slug)}`}>{item.text}</a>
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
    <div key={key} className="noema-breadcrumb" data-breadcrumb="">
      {crumbs.length === 0 ? (
        <span className="noema-breadcrumb-empty">{t(locale, "breadcrumbNoParents")}</span>
      ) : (
        <span className="noema-breadcrumb-trail">
          {crumbs.map((crumb, index) => (
            <span key={crumb.id} className="noema-breadcrumb-item">
              {workspaceSlug ? (
                <a href={`/w/${workspaceSlug}/${crumb.id}`}>
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
    <table key={key} {...colorProps(node)}>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={`${key}.${rowIndex}`}>
            {(row.content ?? []).map((cell, colIndex) => {
              const header = cell.type === "tableHeader";
              const color = cellColor(cell);
              const style: CSSProperties | undefined = header
                ? { background: color ?? "var(--surface)", fontWeight: 600, textAlign: "left" }
                : color
                  ? { background: color }
                  : undefined;
              const content = (cell.content ?? []).map((child, index) =>
                renderBlock(child, `${key}.${rowIndex}.${colIndex}.${index}`, locale, ctx),
              );
              const shared = {
                key: `${key}.${rowIndex}.${colIndex}`,
                colSpan: cellSpan(cell, "colspan"),
                rowSpan: cellSpan(cell, "rowspan"),
                "data-cell-color": color,
                style,
              };
              // A header row (`tableHeader` in row 0) reads as columns; any
              // `tableHeader` further down is a header *column*, so it reads as
              // a row header.
              return header ? (
                <th {...shared} scope={rowIndex === 0 ? "col" : "row"}>
                  {content}
                </th>
              ) : (
                <td {...shared}>{content}</td>
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
    case "paragraph":
      return <p key={key} {...colorProps(node)}>{renderInline(node.content)}</p>;
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      // Stamp the view-local anchor so TOC deep links land on the heading; the
      // id is derived at render time and never written back to the document.
      const slug = ctx.headings.slugByNode.get(node);
      return (
        <Tag key={key} {...colorProps(node)} id={slug ? tocAnchorId(slug) : undefined}>
          {renderInline(node.content)}
        </Tag>
      );
    }
    case "bulletList":
      return <ul key={key} {...colorProps(node)}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}</ul>;
    case "orderedList":
      return <ol key={key} {...colorProps(node)}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}</ol>;
    case "taskList":
      return (
        <ul key={key} className="noema-render-tasks" {...colorProps(node)}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
        </ul>
      );
    case "listItem":
    case "taskItem": {
      const checked = node.type === "taskItem" && Boolean(node.attrs?.checked);
      return (
        <li key={key} {...colorProps(node)}>
          {node.type === "taskItem" && (
            <input type="checkbox" checked={checked} readOnly className="mr-2 align-middle" />
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
      return <blockquote key={key} {...colorProps(node)}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}</blockquote>;
    }
    case "codeBlock": {
      // Parity with the editor's code block: keep the language class so the
      // same styles (and, later, any highlighting) apply in read-only views.
      const language = String(node.attrs?.language ?? "").trim();
      const codeClass = language ? `language-${language}` : undefined;
      const rawCaption = node.attrs?.caption;
      const caption = formatCaption(typeof rawCaption === "string" ? rawCaption : null);
      const showLineNumbers = Boolean(node.attrs?.lineNumbers);

      // Unchanged fast path: neither optional affordance is on, so emit exactly
      // the markup this renderer produced before.
      if (!showLineNumbers && caption === "") {
        return (
          <pre key={key} {...colorProps(node)}>
            <code className={codeClass} data-language={language || undefined}>
              {renderInline(node.content)}
            </code>
          </pre>
        );
      }

      const gutter = showLineNumbers ? numberLines(nodeText(node)) : [];
      return (
        <div key={key} className="noema-code-block-view">
          <pre
            {...colorProps(node)}
            style={showLineNumbers ? { display: "flex", gap: 12, overflow: "visible" } : undefined}
          >
            {showLineNumbers && (
              <div
                aria-hidden="true"
                className="noema-code-gutter"
                style={{
                  userSelect: "none",
                  textAlign: "right",
                  color: "var(--muted)",
                  fontVariantNumeric: "tabular-nums",
                }}
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
    case "horizontalRule":
      return <hr key={key} />;
    case "image": {
      const caption = String(node.attrs?.caption ?? "").trim();
      const width = typeof node.attrs?.width === "number" ? node.attrs.width : null;
      const align = alignOf(node.attrs?.align);
      return (
        <figure
          key={key}
          className="noema-image-block"
          data-width={width === null ? undefined : `${width}%`}
          data-align={align}
          style={{ width: width === null ? undefined : `${width}%`, ...alignStyle(align) }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={String(node.attrs?.src ?? "")}
            alt={String(node.attrs?.alt ?? "")}
            className="noema-image"
          />
          {caption !== "" && <figcaption className="noema-image-caption-view">{caption}</figcaption>}
        </figure>
      );
    }
    case "callout":
      return (
        <div key={key} className="noema-callout">
          <span className="noema-callout-emoji">{String(node.attrs?.emoji ?? "💡")}</span>
          <div className="noema-callout-content">
            {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale, ctx))}
          </div>
        </div>
      );
    case "toggle":
      return (
        <details key={key} open={Boolean(node.attrs?.open)} className="noema-toggle" {...colorProps(node)}>
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
      // with the source mirrored onto `data-latex`/`aria-label`.
      const latex = String(node.attrs?.latex ?? "");
      return (
        <div key={key} className="noema-math-block" data-latex={latex} role="math" aria-label={latex}>
          {latex}
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
    case "bookmark": {
      const url = String(node.attrs?.url ?? "");
      const host = String(node.attrs?.host ?? "");
      const icon = node.attrs?.icon ? String(node.attrs.icon) : null;
      const title = String(node.attrs?.title ?? host ?? url);
      const description = node.attrs?.description ? String(node.attrs.description) : "";
      const image = node.attrs?.image ? String(node.attrs.image) : null;
      return (
        <div key={key} className="noema-bookmark-card" data-bookmark="">
          <a
            href={sanitizeHref(url) ?? "#"}
            className="noema-bookmark-link"
            target="_blank"
            rel="noreferrer noopener"
          >
            <span className="noema-bookmark-text">
              {icon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={icon} alt="" className="noema-bookmark-favicon" />
              )}
              <span className="noema-bookmark-title">{title}</span>
              {description && <span className="noema-bookmark-desc">{description}</span>}
              {host && <span className="noema-bookmark-host">{host}</span>}
            </span>
            {image && (
              // eslint-disable-next-line @next/next/no-img-element -- og:image thumbnail
              <img src={image} alt="" className="noema-bookmark-image" />
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
          className="noema-embed-frame"
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

export function DocRenderer({
  doc,
  locale = "en",
  breadcrumbTrail,
  workspaceSlug,
}: {
  doc: unknown;
  /** Callers without a locale source (public share page, editor) keep en. */
  locale?: string;
  /** Ancestor trail for the read-side breadcrumb block (from `getAncestorTrail`). */
  breadcrumbTrail?: readonly DocRendererBreadcrumb[];
  /** Workspace slug, so rendered breadcrumb crumbs link like the editor's. */
  workspaceSlug?: string;
}) {
  const root = doc as PMNode | null;
  if (!root || !Array.isArray(root.content)) return null;
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
  return <div className="noema-doc-renderer">{rendered}</div>;
}

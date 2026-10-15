import type { ReactNode } from "react";
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
      return (
        <span key={key} className="noema-math-inline">
          {String(node.attrs?.latex ?? "")}
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

function renderBlock(
  node: PMNode,
  key: string,
  locale: string = "en",
  quote?: PullQuote,
): ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p key={key} {...colorProps(node)}>{renderInline(node.content)}</p>;
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag key={key} {...colorProps(node)}>{renderInline(node.content)}</Tag>;
    }
    case "bulletList":
      return <ul key={key} {...colorProps(node)}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</ul>;
    case "orderedList":
      return <ol key={key} {...colorProps(node)}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</ol>;
    case "taskList":
      return (
        <ul key={key} className="noema-render-tasks" {...colorProps(node)}>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}
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
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}
        </li>
      );
    }
    case "blockquote": {
      // A `size: "large"` quote (already resolved with any attribution
      // paragraph) renders at display scale; everything else is unchanged.
      const pullQuote = quote ?? pullQuoteOf(node);
      if (pullQuote) return renderPullQuote(pullQuote, node, key);
      return <blockquote key={key} {...colorProps(node)}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</blockquote>;
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
            {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}
          </div>
        </div>
      );
    case "toggle":
      return (
        <details key={key} open={Boolean(node.attrs?.open)} className="noema-toggle" {...colorProps(node)}>
          <summary>{String(node.attrs?.summary ?? t(locale, "toggleFallback"))}</summary>
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}
        </details>
      );
    case "columns":
      return (
        <div key={key} data-columns="">
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}
        </div>
      );
    case "column":
      return (
        <div key={key} data-column="">
          {(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}
        </div>
      );
    case "table":
      return (
        <table key={key}>
          <tbody>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</tbody>
        </table>
      );
    case "tableRow":
      return <tr key={key}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</tr>;
    case "tableHeader":
      return <th key={key}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</th>;
    case "tableCell":
      return <td key={key}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</td>;
    case "blockMath":
      return (
        <div key={key} className="noema-math-block">
          {String(node.attrs?.latex ?? "")}
        </div>
      );
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
        <div key={key}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</div>
      );
  }
}

export function DocRenderer({
  doc,
  locale = "en",
}: {
  doc: unknown;
  /** Callers without a locale source (public share page, editor) keep en. */
  locale?: string;
}) {
  const root = doc as PMNode | null;
  if (!root || !Array.isArray(root.content)) return null;
  const nodes = root.content;
  const rendered: ReactNode[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    // A large blockquote may consume the attribution paragraph right after it;
    // every other node (and key) is untouched.
    const { quote, consumed } = resolvePullQuote(nodes[index], nodes[index + 1]);
    rendered.push(renderBlock(nodes[index], `b${index}`, locale, quote));
    if (consumed) index += 1;
  }
  return <div className="noema-doc-renderer">{rendered}</div>;
}

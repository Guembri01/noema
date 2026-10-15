"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import {
  parseMarkdown,
  type Block,
  type Inline,
  type ListBlock,
  type ListItem,
} from "@/lib/markdown";
import { formatCaption, numberLines } from "@/lib/code-block";
import {
  blocksToQuote,
  formatPullQuote,
  isPullQuoteSize,
  parsePullQuote,
  type PullQuote,
  type PullQuoteBlock,
  type PullQuoteSize,
} from "@/lib/pull-quote";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Renders AI answers (and any Markdown) as React elements — never as HTML
 * strings, so model output can never inject markup. Styling lives in
 * `globals.css` under `.notion-markdown`, which mirrors the editor typography.
 */
export function Markdown({
  text,
  slug,
  className,
  compact = false,
  locale = "en",
}: {
  text: string;
  /** Workspace slug, used to turn `[[page:id|Title]]` into real links. */
  slug?: string;
  className?: string;
  compact?: boolean;
  /** Optional — editor call sites keep the English default. */
  locale?: string;
}) {
  const blocks = parseMarkdown(text ?? "");
  if (blocks.length === 0) return null;
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    // A `size: "large"` pull quote may consume the attribution paragraph that
    // immediately follows it; every other node (and key) is untouched.
    const { quote, consumed } = resolvePullQuote(blocks[index], blocks[index + 1]);
    rendered.push(
      <BlockView key={index} block={blocks[index]} slug={slug} locale={locale} quote={quote} />,
    );
    if (consumed) index += 1;
  }
  return (
    <div className={cn("notion-markdown", compact && "notion-markdown-compact", className)}>
      {rendered}
    </div>
  );
}

/** Inline-only Markdown (titles, captions, single-line labels). */
export function InlineMarkdown({
  text,
  slug,
  className,
}: {
  text: string;
  slug?: string;
  className?: string;
}) {
  const blocks = parseMarkdown(text ?? "");
  const inline: Inline[] = blocks.flatMap((block) =>
    block.type === "paragraph" ? block.content : [],
  );
  if (inline.length === 0) return <span className={className}>{text}</span>;
  return <span className={className}>{renderInline(inline, slug)}</span>;
}

/* -------------------------------------------------------------------------- *
 * Block variants: a pull quote (a blockquote the parser marks `size: "large"`,
 * serialised as a leading `[!large]` marker) and the two optional code-block
 * affordances (`lineNumbers` / `caption`, serialised as a `{…}` fence suffix).
 * Semantics come from the shared libs so the editor, the read-only doc renderer
 * and this Markdown surface agree on one definition. Everything below stays
 * element-only: text is placed as JSX children, never through innerHTML.
 * -------------------------------------------------------------------------- */

/** Flatten inline nodes to their text (a heading's label, a paragraph's words…). */
function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.value;
        case "ref":
          return node.title;
        case "br":
          return "\n";
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}

/** Flatten a block to plain text (`pull-quote.ts` models text, not marks). */
function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return inlineText(block.content);
    case "code":
      return block.value;
    case "quote":
      return block.blocks.map(blockText).join("\n");
    case "list":
      return block.items.map((item) => inlineText(item.content)).join("\n");
    case "table":
      return [block.header, ...block.rows].map((row) => row.map(inlineText).join(" | ")).join("\n");
    case "image":
      return block.caption ?? block.alt;
    case "hr":
      return "";
  }
}

/**
 * The optional code-block affordances the parser attached to a `code` block.
 * `lineNumbers` is only honoured when set to `true`; the caption is normalised
 * with `formatCaption` so stray whitespace never reaches the DOM.
 */
function codeBlockOptions(block: { lang: string | null; value: string }): {
  lineNumbers: boolean;
  caption: string;
} {
  const extra = block as { lineNumbers?: unknown; caption?: unknown };
  return {
    lineNumbers: extra.lineNumbers === true,
    caption: formatCaption(typeof extra.caption === "string" ? extra.caption : null),
  };
}

/** The display scale the parser attached to a quote, when it is a known one. */
function quoteSize(block: { blocks: Block[] }): PullQuoteSize | undefined {
  const extra = block as { size?: unknown };
  return isPullQuoteSize(extra.size) ? extra.size : undefined;
}

/** Project a Markdown block into `pull-quote.ts`'s minimal block shape. */
function pullQuoteBlockOf(block: Block, size?: PullQuoteSize): PullQuoteBlock {
  const text = blockText(block).trim();
  const projected: PullQuoteBlock = {
    type: block.type === "quote" ? "blockquote" : "paragraph",
    content: text ? [{ type: "text", text }] : [],
  };
  if (size) projected.attrs = { size };
  return projected;
}

/**
 * Read a `size: "large"` quote through `pull-quote.ts`. Returns undefined for an
 * ordinary quote — or a large one the lib rejects (blank text) — so normal
 * blockquotes keep their existing rendering untouched.
 */
function pullQuoteOf(block: Block): PullQuote | undefined {
  if (block.type !== "quote") return undefined;
  const size = quoteSize(block);
  if (size !== "large") return undefined;
  const parsed = parsePullQuote({ text: blockText(block), size });
  return parsed.ok ? parsed.value : undefined;
}

/**
 * Resolve a top-level pull-quote pair: the `large` quote plus the optional
 * attribution paragraph that follows it. The lib strips a leading dash when it
 * reads the pair back, so a following paragraph only counts as an attribution
 * when that strip changes its text; a plain paragraph is left in place.
 */
function resolvePullQuote(
  block: Block,
  next: Block | undefined,
): { quote?: PullQuote; consumed: boolean } {
  const base = pullQuoteOf(block);
  if (!base) return { consumed: false };
  if (!next || next.type !== "paragraph") return { quote: base, consumed: false };

  const nextText = blockText(next).trim();
  if (!nextText) return { quote: base, consumed: false };

  const parsed = parsePullQuote(
    blocksToQuote([pullQuoteBlockOf(block, "large"), pullQuoteBlockOf(next)]),
  );
  if (!parsed.ok) return { quote: base, consumed: false };
  const { attribution } = parsed.value;
  if (attribution === undefined || attribution === nextText) {
    return { quote: base, consumed: false };
  }
  return { quote: parsed.value, consumed: true };
}

/** Display-scale pull quote — the read-side twin of the editor's decoration. */
function renderPullQuote(quote: PullQuote): React.ReactNode {
  return (
    <blockquote
      className="notion-pull-quote"
      data-pull-quote=""
      data-size="large"
      style={{ fontSize: "1.5em", fontWeight: 600, lineHeight: 1.45 }}
      title={formatPullQuote(quote)}
    >
      {quote.text}
      {quote.attribution !== undefined && (
        <footer
          className="notion-pull-quote-attribution"
          style={{ fontSize: "0.9em", fontWeight: 400, opacity: 0.75, textAlign: "right" }}
        >
          {"\u2014 "}
          {quote.attribution}
        </footer>
      )}
    </blockquote>
  );
}

function BlockView({
  block,
  slug,
  locale,
  quote,
}: {
  block: Block;
  slug?: string;
  locale?: string;
  quote?: PullQuote;
}) {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(block.level, 4)}`) as "h1" | "h2" | "h3" | "h4";
      return <Tag>{renderInline(block.content, slug)}</Tag>;
    }
    case "paragraph":
      return <p>{renderInline(block.content, slug)}</p>;
    case "code": {
      const { lineNumbers, caption } = codeBlockOptions(block);
      return (
        <CodeBlock
          lang={block.lang}
          value={block.value}
          locale={locale}
          lineNumbers={lineNumbers}
          caption={caption}
        />
      );
    }
    case "quote": {
      // A `size: "large"` quote (already resolved with any attribution
      // paragraph) renders at display scale; everything else is unchanged.
      if (quote) return renderPullQuote(quote);
      return (
        <blockquote>
          {block.blocks.map((inner, index) => (
            <BlockView key={index} block={inner} slug={slug} locale={locale} />
          ))}
        </blockquote>
      );
    }
    case "list":
      return <ListView list={block} slug={slug} />;
    case "table":
      return (
        <div className="notion-markdown-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} style={{ textAlign: block.align[index] ?? "left" }}>
                    {renderInline(cell, slug)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? "left" }}>
                      {renderInline(cell, slug)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr />;
  }
}

function ListView({ list, slug }: { list: ListBlock; slug?: string }) {
  const isTask = list.items.some((item) => item.checked !== null);
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag className={cn(isTask && "notion-markdown-tasks")}>
      {list.items.map((item, index) => (
        <ListItemView key={index} item={item} slug={slug} />
      ))}
    </Tag>
  );
}

function ListItemView({ item, slug }: { item: ListItem; slug?: string }) {
  const body = renderInline(item.content, slug);
  return (
    <li className={cn(item.checked !== null && "notion-markdown-task")}>
      {item.checked !== null && (
        <span aria-hidden className={cn("notion-check", item.checked && "notion-check-on")}>
          {item.checked && <Check className="h-3 w-3" />}
        </span>
      )}
      {body}
      {item.children.map((child, index) => (
        <ListView key={index} list={child} slug={slug} />
      ))}
    </li>
  );
}

function CodeBlock({
  lang,
  value,
  locale = "en",
  lineNumbers = false,
  caption = "",
}: {
  lang: string | null;
  value: string;
  locale?: string;
  /** Optional gutter numbering (`code-block.ts`'s `numberLines`). */
  lineNumbers?: boolean;
  /** Optional caption under the block, already normalised via `formatCaption`. */
  caption?: string;
}) {
  const [copied, setCopied] = useState(false);
  const gutter = lineNumbers ? numberLines(value) : [];
  return (
    <div className="notion-code">
      <div className="notion-code-head">
        <span className="notion-code-lang">{lang || "text"}</span>
        <button
          type="button"
          aria-label={t(locale, "copyCode")}
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          className="notion-code-copy"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t(locale, "copiedWord") : t(locale, "copy")}
        </button>
      </div>
      <pre style={lineNumbers ? { display: "flex", gap: 12, overflow: "visible" } : undefined}>
        {lineNumbers && (
          <div
            aria-hidden
            className="notion-code-gutter"
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
        <code style={lineNumbers ? { flex: 1, minWidth: 0, overflowX: "auto" } : undefined}>
          {value}
        </code>
      </pre>
      {caption !== "" && <p className="notion-code-caption">{caption}</p>}
    </div>
  );
}

function renderInline(nodes: Inline[], slug?: string): React.ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <span key={index}>{node.value}</span>;
      case "strong":
        return <strong key={index}>{renderInline(node.children, slug)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children, slug)}</em>;
      case "del":
        return <del key={index}>{renderInline(node.children, slug)}</del>;
      case "code":
        return (
          <code key={index} className="notion-inline-code">
            {node.value}
          </code>
        );
      case "br":
        return <br key={index} />;
      case "link": {
        const external = /^https?:/i.test(node.href);
        return external ? (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(node.children, slug)}
          </a>
        ) : (
          <Link key={index} href={node.href}>
            {renderInline(node.children, slug)}
          </Link>
        );
      }
      case "ref": {
        const chip = (
          <span className="notion-ref">
            <span aria-hidden>📄</span>
            <span className="notion-ref-title">{node.title}</span>
          </span>
        );
        return slug ? (
          <Link key={index} href={`/w/${slug}/${node.pageId}`} className="notion-ref-link">
            {chip}
          </Link>
        ) : (
          <span key={index}>{chip}</span>
        );
      }
    }
  });
}

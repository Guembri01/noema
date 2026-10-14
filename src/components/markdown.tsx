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
  return (
    <div className={cn("notion-markdown", compact && "notion-markdown-compact", className)}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} slug={slug} locale={locale} />
      ))}
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

function BlockView({ block, slug, locale }: { block: Block; slug?: string; locale?: string }) {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(block.level, 4)}`) as "h1" | "h2" | "h3" | "h4";
      return <Tag>{renderInline(block.content, slug)}</Tag>;
    }
    case "paragraph":
      return <p>{renderInline(block.content, slug)}</p>;
    case "code":
      return <CodeBlock lang={block.lang} value={block.value} locale={locale} />;
    case "quote":
      return (
        <blockquote>
          {block.blocks.map((inner, index) => (
            <BlockView key={index} block={inner} slug={slug} locale={locale} />
          ))}
        </blockquote>
      );
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
}: {
  lang: string | null;
  value: string;
  locale?: string;
}) {
  const [copied, setCopied] = useState(false);
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
      <pre>
        <code>{value}</code>
      </pre>
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

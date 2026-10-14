import type { ReactNode } from "react";
import { detectEmbed, embedMeta } from "@/lib/embeds";
import { t } from "@/lib/i18n";
import { alignOf, alignStyle } from "@/lib/media";
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

function renderBlock(node: PMNode, key: string, locale: string = "en"): ReactNode {
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
    case "blockquote":
      return <blockquote key={key} {...colorProps(node)}>{(node.content ?? []).map((c, i) => renderBlock(c, `${key}.${i}`, locale))}</blockquote>;
    case "codeBlock": {
      // Parity with the editor's code block: keep the language class so the
      // same styles (and, later, any highlighting) apply in read-only views.
      const language = String(node.attrs?.language ?? "").trim();
      return (
        <pre key={key} {...colorProps(node)}>
          <code
            className={language ? `language-${language}` : undefined}
            data-language={language || undefined}
          >
            {renderInline(node.content)}
          </code>
        </pre>
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
      const info = detectEmbed(String(node.attrs?.url ?? ""));
      const meta = info.provider === "none" ? null : embedMeta(info.provider);
      return info.embedUrl ? (
        <iframe
          key={key}
          src={info.embedUrl}
          data-provider={info.provider}
          title={meta?.title ?? t(locale, "embeddedContent")}
          className="noema-embed-frame"
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          allow={meta?.allow ?? "clipboard-write"}
          allowFullScreen
          style={meta ? { aspectRatio: meta.aspectRatio } : undefined}
        />
      ) : (
        <a
          key={key}
          href={sanitizeHref(String(node.attrs?.url ?? "")) ?? "#"}
          target="_blank"
          rel="noreferrer noopener"
        >
          {String(node.attrs?.url ?? "")}
        </a>
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
  return (
    <div className="noema-doc-renderer">
      {root.content.map((node, index) => renderBlock(node, `b${index}`, locale))}
    </div>
  );
}

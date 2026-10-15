"use client";

import { useEffect, useRef, useState } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { CodeBlockLowlight, type CodeBlockLowlightOptions } from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { ListOrdered } from "lucide-react";
import { cn } from "@/lib/utils";
import { codeLanguageLabel, searchCodeLanguages } from "@/lib/code-languages";
import { formatCaption, normalizeLanguage, numberLines, validateCaption } from "@/lib/code-block";
import { t } from "@/lib/i18n";

/**
 * Syntax highlighting with highlight.js' *common* language set only, so the
 * long tail of grammars never lands in the bundle. `createLowlight` is pure
 * JS (no window access), and the editor itself keeps `immediatelyRender:
 * false`, so SSR stays safe.
 */
const lowlight = createLowlight(common);

/**
 * Notion-style code block.
 *
 * Replaces StarterKit's stock codeBlock (which only *stores* a language) with
 * the lowlight-backed variant plus a corner language selector. The `language`
 * attribute is the standard TipTap one, so stored document JSON, markdown
 * export and the read-only DocRenderer keep working unchanged.
 */
/** CodeBlockLowlight options plus the locale threaded from `page-editor.tsx`. */
type CodeBlockOptions = CodeBlockLowlightOptions & { locale: string };

export const CodeBlock = CodeBlockLowlight.extend<CodeBlockOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      locale: "en",
    } as CodeBlockOptions;
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      /**
       * Optional gutter numbering. Stored as a node attribute (serialised to
       * `data-line-numbers`) so it survives JSON, undo and collaboration just
       * like `language`; absent means "no gutter".
       */
      lineNumbers: {
        default: false,
        parseHTML: (element) => element.getAttribute("data-line-numbers") === "true",
        renderHTML: (attributes) =>
          attributes.lineNumbers ? { "data-line-numbers": "true" } : {},
      },
      /**
       * Optional caption under the block, normalised on the way out with the
       * shared `formatCaption` so a stored block never carries stray padding.
       */
      caption: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-caption") ?? "",
        renderHTML: (attributes) => {
          const caption = formatCaption(String(attributes.caption ?? ""));
          return caption === "" ? {} : { "data-caption": caption };
        },
      },
    };
  },
  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <CodeBlockView {...props} locale={locale} />
    ));
  },
}).configure({
  lowlight,
  languageClassPrefix: "language-",
  defaultLanguage: null,
});

function CodeBlockView({
  node,
  editor,
  updateAttributes,
  selected,
  locale,
}: NodeViewProps & { locale: string }) {
  const attrs = node.attrs as {
    language?: unknown;
    blockColor?: unknown;
    lineNumbers?: unknown;
    caption?: unknown;
  };
  const editable = editor.isEditable;
  const language = String(attrs.language ?? "");
  const blockColor = attrs.blockColor ? String(attrs.blockColor) : null;
  const showNumbers = Boolean(attrs.lineNumbers);
  const caption = String(attrs.caption ?? "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Local caption draft: the box edits freely, the attribute only ever stores
  // the formatted caption, so collapsing whitespace can't fight the cursor.
  const [captionDraft, setCaptionDraft] = useState(caption);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the filter box whenever the menu opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Clicking anywhere else (including back into the code) closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Keep the caption box in step with the stored attribute (undo/redo, an
  // external collaborator, a reload) without clobbering live typing.
  useEffect(() => {
    setCaptionDraft(caption);
    setCaptionError(null);
  }, [caption]);

  const choose = (value: string) => {
    // Canonicalise through the shared registry so a stored fence alias (`js`)
    // is always written in its full form (`javascript`).
    updateAttributes({ language: normalizeLanguage(value) });
    setQuery("");
    setOpen(false);
    // Return focus to the block so typing continues in the code.
    editor.chain().focus().run();
  };

  const commitCaption = () => {
    const result = validateCaption(captionDraft);
    if (!result.ok) {
      setCaptionError(result.error);
      return;
    }
    updateAttributes({ caption: formatCaption(captionDraft) });
    setCaptionError(null);
  };

  const matches = searchCodeLanguages(query);
  const gutter = showNumbers ? numberLines(node.textContent) : [];

  return (
    <NodeViewWrapper
      className={cn("noema-code-block", selected && "is-selected")}
      data-code-block=""
      data-language={language || undefined}
    >
      <div className="noema-code-lang" contentEditable={false} ref={pickerRef}>
        <button
          type="button"
          className="noema-code-lang-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          // Keep the editor selection alive while toggling the menu.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuery("");
            setOpen((current) => !current);
          }}
        >
          {codeLanguageLabel(language)}
        </button>

        {open && (
          <div className="noema-code-lang-menu" data-code-language-menu="">
            <input
              ref={inputRef}
              className="noema-code-lang-filter"
              type="text"
              value={query}
              placeholder={t(locale, "codeFilterLanguages")}
              aria-label={t(locale, "codeFilterLanguagesAria")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  editor.chain().focus().run();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (matches[0]) choose(matches[0].value);
                }
              }}
            />
            {matches.length > 0 ? (
              <div className="noema-code-lang-list" role="listbox" aria-label={t(locale, "codeLanguagesAria")}>
                {matches.map((lang) => (
                  <button
                    key={lang.value}
                    type="button"
                    role="option"
                    aria-selected={lang.value === language}
                    className={cn(
                      "noema-code-lang-option",
                      lang.value === language && "is-active",
                    )}
                    // Don't blur the filter input mid-click.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(lang.value)}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            ) : (
              <p className="noema-code-lang-empty">{t(locale, "codeNoMatches")}</p>
            )}
          </div>
        )}
      </div>

      {editable && (
        <button
          type="button"
          className="noema-code-lang-trigger"
          style={{ position: "absolute", top: 7, right: 8, zIndex: 2 }}
          aria-pressed={showNumbers}
          // Reuses the closest shipped node-view labels; dedicated code-line /
          // code-caption keys live in i18n.ts and are out of this slice's scope.
          aria-label={t(locale, "numberWord")}
          title={t(locale, "numberWord")}
          contentEditable={false}
          // Keep the editor selection alive while toggling the gutter.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => updateAttributes({ lineNumbers: !showNumbers })}
        >
          <ListOrdered className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}

      <pre
        data-block-color={blockColor ?? undefined}
        style={showNumbers ? { display: "flex", gap: 12, overflow: "visible" } : undefined}
      >
        {showNumbers && (
          <div
            aria-hidden
            contentEditable={false}
            data-code-gutter=""
            style={{
              userSelect: "none",
              pointerEvents: "none",
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
          className={language ? `language-${language}` : undefined}
          data-language={language || undefined}
          style={showNumbers ? { flex: 1, minWidth: 0, overflowX: "auto" } : undefined}
        >
          <NodeViewContent<"span"> as="span" />
        </code>
      </pre>

      {editable ? (
        <div contentEditable={false}>
          <div className="noema-image-meta">
            <input
              className="noema-image-caption"
              value={captionDraft}
              placeholder={t(locale, "imageCaptionPlaceholder")}
              aria-label={t(locale, "imageCaptionAria")}
              aria-invalid={captionError ? true : undefined}
              onChange={(event) => {
                setCaptionDraft(event.target.value);
                const result = validateCaption(event.target.value);
                setCaptionError(result.ok ? null : result.error);
              }}
              onBlur={commitCaption}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitCaption();
                }
              }}
            />
          </div>
          {captionError && (
            <p role="alert" style={{ margin: "2px 6px 0", fontSize: 11, color: "#eb5757" }}>
              {captionError}
            </p>
          )}
        </div>
      ) : (
        formatCaption(caption) !== "" && (
          <p className="noema-image-caption-view" contentEditable={false}>
            {formatCaption(caption)}
          </p>
        )
      )}
    </NodeViewWrapper>
  );
}

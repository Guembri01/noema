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
import { cn } from "@/lib/utils";
import { codeLanguageLabel, searchCodeLanguages } from "@/lib/code-languages";
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
  const attrs = node.attrs as { language?: unknown; blockColor?: unknown };
  const language = String(attrs.language ?? "");
  const blockColor = attrs.blockColor ? String(attrs.blockColor) : null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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

  const choose = (value: string) => {
    updateAttributes({ language: value });
    setQuery("");
    setOpen(false);
    // Return focus to the block so typing continues in the code.
    editor.chain().focus().run();
  };

  const matches = searchCodeLanguages(query);

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

      <pre data-block-color={blockColor ?? undefined}>
        <code
          className={language ? `language-${language}` : undefined}
          data-language={language || undefined}
        >
          <NodeViewContent<"span"> as="span" />
        </code>
      </pre>
    </NodeViewWrapper>
  );
}

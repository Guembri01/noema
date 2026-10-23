"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { CodeBlockLowlight, type CodeBlockLowlightOptions } from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { Check, Copy, Eye, ListOrdered, SquareCode, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";
import { CODE_LANGUAGES, codeLanguageLabel } from "@/lib/code-languages";
import { formatCaption, normalizeLanguage, numberLines, validateCaption } from "@/lib/code-block";
import { t } from "@/lib/i18n";
import { Z } from "@/lib/design-tokens";
import { Button } from "@/components/ui/button";
import { Select, filterOptions, type SelectOption } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { MermaidDiagram, isMermaidBlock } from "@/components/diagrams/mermaid-diagram";

/**
 * Syntax highlighting with highlight.js' *common* language set only, so the
 * long tail of grammars never lands in the bundle. `createLowlight` is pure
 * JS (no window access), and the editor itself keeps `immediatelyRender:
 * false`, so SSR stays safe.
 */
const lowlight = createLowlight(common);

/* -------------------------------------------------------------------------- *
 * Pure mappings — proven in `code-block.test.ts`
 * -------------------------------------------------------------------------- */

/**
 * How long the Copy affordance keeps its success check before returning to the
 * idle icon. One and a half seconds: long enough to register, short enough that
 * the block never looks permanently changed.
 */
export const COPY_FEEDBACK_MS = 1500;

/** The Copy affordance is either waiting (`idle`) or confirming (`copied`). */
export type CodeCopyState = "idle" | "copied";

/**
 * Copy-button state machine. A `copy` always lands on `copied` (a second copy
 * restarts the window rather than toggling off); `reset` — fired when the
 * {@link COPY_FEEDBACK_MS} timer elapses — returns to `idle`. Pure so the view
 * code and the test cannot drift.
 */
export function nextCopyState(state: CodeCopyState, event: "copy" | "reset"): CodeCopyState {
  if (event === "reset") return "idle";
  return "copied";
}

/** Colour for the Copy button per state: the success token while confirming. */
export function copyButtonClass(state: CodeCopyState): string {
  return state === "copied" ? "text-success" : "";
}

/**
 * Picker options for the language `Select`, mapped from the shared registry so
 * the menu, the lowlight grammar names and the stored `language` attribute can
 * never fork. Aliases ride along as search keywords (`js`, `ts`, `py`, …).
 */
const LANGUAGE_OPTIONS: SelectOption[] = CODE_LANGUAGES.map((lang) => ({
  value: lang.value,
  label: lang.label,
  keywords: lang.aliases ? [...lang.aliases] : undefined,
}));

/** Every selectable language (a fresh array is not needed; callers only read). */
export function languageOptions(): SelectOption[] {
  return LANGUAGE_OPTIONS;
}

/**
 * Filter the language list with the shared `Select` ranking (prefix > word >
 * substring > alias keyword), so the picker's search behaves exactly like every
 * other combobox in the app.
 */
export function filterLanguages(query: string): SelectOption[] {
  return filterOptions(languageOptions(), query);
}

/**
 * Gutter metrics for the optional line-number stripe. `gap` is the 12 px offset
 * between the numbers and the code; the ink is `--fg-subtle` (the tertiary
 * text token) so the gutter recedes behind the highlighted source.
 */
export const CODE_GUTTER = { gap: 12, color: "var(--fg-subtle)" } as const;

/** Inline style for the numbered gutter (colour + tabular figures). */
export function codeGutterStyle(): CSSProperties {
  return {
    userSelect: "none",
    pointerEvents: "none",
    textAlign: "right",
    color: CODE_GUTTER.color,
    fontVariantNumeric: "tabular-nums",
  };
}

/**
 * Soft-wrap style for the code body. Wrapping is a *presentation* toggle held in
 * the node view's local state, so the stored document (and its attributes) is
 * never touched — see the "serialization unchanged" contract.
 */
export function codeWrapStyle(wrap: boolean): CSSProperties {
  return wrap ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } : {};
}

/** Visibility inputs for the code block's affordances. */
export type CodeChromeState = {
  hovered?: boolean;
  focused?: boolean;
  selected?: boolean;
};

/** True when the chrome should be pinned visible (hover, focus or selection). */
export function codeChromeVisible(state: CodeChromeState = {}): boolean {
  return Boolean(state.hovered || state.focused || state.selected);
}

/**
 * The chrome fade in on block hover and stay visible while the block holds
 * focus or a node selection, so the keyboard path exposes the same affordances
 * as the pointer (DESIGN_SYSTEM §8/§9). Colour/opacity only via `.u-colors`.
 */
export function codeChromeClass(state: CodeChromeState = {}): string {
  return `noema-code-chrome u-colors u-transform ${codeChromeVisible(state) ? "opacity-100" : "opacity-0"}`;
}

/**
 * Pointer/keyboard reveal rules for a chrome container. Applied alongside
 * {@link codeChromeClass}: the base `opacity-0` reserves the space (the
 * controls are absolutely positioned, so nothing shifts) and these lifted
 * selectors fade it in on `group` hover, on focus-within, and while a control
 * inside is focused.
 */
export const CODE_CHROME_REVEAL =
  "group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100";

/**
 * Label for the wrap toggle. There is no dedicated `codeWrap` key in the i18n
 * catalogue yet (that file is owned elsewhere), so the literal is centralised
 * here pending the key — every other string rides `t(locale, …)`.
 */
export const CODE_WRAP_LABEL = "Wrap lines";

/* -------------------------------------------------------------------------- *
 * Extension
 * -------------------------------------------------------------------------- */

/**
 * Notion-style code block.
 *
 * Replaces StarterKit's stock codeBlock (which only *stores* a language) with
 * the lowlight-backed variant plus a hover toolbar: a searchable language
 * `Select`, a Copy button with a {@link COPY_FEEDBACK_MS} success state, the
 * line-number gutter toggle and an optional wrap toggle. The `language`,
 * `lineNumbers` and `caption` attributes are the standard TipTap ones, so
 * stored document JSON, markdown export and the read-only DocRenderer keep
 * working unchanged.
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

/* -------------------------------------------------------------------------- *
 * Chrome — presentational, no hooks (static-renderable)
 * -------------------------------------------------------------------------- */

export type CodeBlockChromeProps = {
  locale?: string;
  /** Visibility inputs (hover / focus / selection). */
  state?: CodeChromeState;
  /** Copy affordance state. */
  copy?: CodeCopyState;
  language?: string;
  showNumbers?: boolean;
  wrap?: boolean;
  /** When false (read-only block) only the Copy affordance is shown. */
  editable?: boolean;
  onLanguageChange?: (value: string) => void;
  onCopy?: () => void;
  onToggleNumbers?: () => void;
  onToggleWrap?: () => void;
  /** Mermaid blocks get a source/preview switch. */
  isMermaid?: boolean;
  preview?: boolean;
  onTogglePreview?: () => void;
};

/**
 * The code block's hover toolbar: the language picker (top-start) and the
 * Copy / line-numbers / wrap actions (top-end). Absolutely positioned inside
 * the block's reserved padding, so revealing it never moves the code; all
 * controls are `contentEditable={false}` so they stay out of the document.
 * Read-only blocks keep the Copy affordance (useful on a shared page) and drop
 * the editing controls.
 */
export function CodeBlockChrome({
  locale = "en",
  state = {},
  copy = "idle",
  language = "",
  showNumbers = false,
  wrap = false,
  editable = true,
  onLanguageChange,
  onCopy,
  onToggleNumbers,
  onToggleWrap,
  isMermaid = false,
  preview = false,
  onTogglePreview,
}: CodeBlockChromeProps) {
  const visible = codeChromeVisible(state);
  return (
    <>
      {editable && (
        <div
          className={cn(
            CODE_CHROME_REVEAL,
            codeChromeClass(state),
            "absolute start-2 top-1.5 inline-flex",
          )}
          data-code-language-picker=""
          contentEditable={false}
          style={{ zIndex: Z.sticky }}
          // Keep the editor selection alive while the picker is used.
          onMouseDown={(event) => event.preventDefault()}
        >
          <Select
            options={languageOptions()}
            value={language}
            onChange={(value) => onLanguageChange?.(value)}
            placeholder={codeLanguageLabel(language)}
            aria-label={t(locale, "codeLanguagesAria")}
            searchPlaceholder={t(locale, "codeFilterLanguages")}
            noResultsLabel={t(locale, "codeNoMatches")}
            allowClear={false}
            size="sm"
            className="w-[180px]"
            locale={locale}
          />
        </div>
      )}

      <div
        className={cn(
          CODE_CHROME_REVEAL,
          codeChromeClass(state),
          "absolute end-2 top-1.5 flex items-center gap-0.5",
        )}
        data-code-chrome=""
        data-chrome-visible={visible ? "true" : "false"}
        data-copy-state={copy}
        contentEditable={false}
        style={{ zIndex: Z.sticky }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Tooltip label={t(locale, "copyCode")} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(locale, "copyCode")}
            data-testid="code-copy"
            className={copyButtonClass(copy)}
            onClick={onCopy}
          >
            {copy === "copied" ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
        </Tooltip>

        {editable && isMermaid && (
          <Tooltip label={preview ? "Show source" : "Show diagram"} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={preview}
              aria-label={preview ? "Show Mermaid source" : "Preview Mermaid diagram"}
              data-testid="code-mermaid-preview"
              className={cn(preview && "bg-surface-2 text-fg")}
              onClick={onTogglePreview}
            >
              {preview ? (
                <SquareCode className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Eye className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </Tooltip>
        )}

        {editable && (
          <>
            <Tooltip label={t(locale, "codeLineNumbers")} side="top">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-pressed={showNumbers}
                aria-label={t(locale, "codeLineNumbers")}
                data-testid="code-line-numbers"
                className={cn(showNumbers && "bg-surface-2 text-fg")}
                onClick={onToggleNumbers}
              >
                <ListOrdered className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </Tooltip>

            <Tooltip label={CODE_WRAP_LABEL} side="top">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-pressed={wrap}
                aria-label={CODE_WRAP_LABEL}
                data-testid="code-wrap"
                className={cn(wrap && "bg-surface-2 text-fg")}
                onClick={onToggleWrap}
              >
                <WrapText className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- *
 * Copy feedback hook
 * -------------------------------------------------------------------------- */

/**
 * Owns the {@link COPY_FEEDBACK_MS} success window: `copy(text)` writes to the
 * clipboard (guarded as it is unavailable outside a secure browser context),
 * flips to `copied` and schedules the `reset`. The timer is always cleared on
 * unmount, so a removed block never fires.
 */
function useCopyFeedback(delayMs = COPY_FEEDBACK_MS) {
  const [state, setState] = useState<CodeCopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        }
      } catch {
        // Clipboard permission denied / insecure context: still confirm the
        // intent so the affordance never looks dead.
      }
      setState((current) => nextCopyState(current, "copy"));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => setState((current) => nextCopyState(current, "reset")),
        delayMs,
      );
    },
    [delayMs],
  );

  return { state, copy };
}

/* -------------------------------------------------------------------------- *
 * Node view
 * -------------------------------------------------------------------------- */

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
  const isMermaid = isMermaidBlock(language);
  const blockColor = attrs.blockColor ? String(attrs.blockColor) : null;
  const showNumbers = Boolean(attrs.lineNumbers);
  const caption = String(attrs.caption ?? "");
  // Presentation-only toggles (never serialised).
  const [wrap, setWrap] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [preview, setPreview] = useState(false);
  const wasMermaid = useRef(false);
  // Local caption draft: the box edits freely, the attribute only ever stores
  // the formatted caption, so collapsing whitespace can't fight the cursor.
  const [captionDraft, setCaptionDraft] = useState(caption);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const { state: copy, copy: copyCode } = useCopyFeedback();

  // Keep the caption box in step with the stored attribute (undo/redo, an
  // external collaborator, a reload) without clobbering live typing.
  useEffect(() => {
    setCaptionDraft(caption);
    setCaptionError(null);
  }, [caption]);

  // A freshly selected Mermaid block opens in preview once it has source; the
  // user can still switch back to source at any time. The source itself stays
  // in the document, so collaboration/undo/redo/export all keep working.
  useEffect(() => {
    if (!isMermaid) {
      wasMermaid.current = false;
      setPreview(false);
      return;
    }
    if (!wasMermaid.current && node.textContent.trim().length > 0) setPreview(true);
    wasMermaid.current = true;
  }, [isMermaid, node.textContent]);

  const choose = (value: string) => {
    // Canonicalise through the shared registry so a stored fence alias (`js`)
    // is always written in its full form (`javascript`).
    updateAttributes({ language: normalizeLanguage(value) });
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

  const gutter = showNumbers ? numberLines(node.textContent) : [];
  const preStyle: CSSProperties = {
    ...(preview ? { display: "none" } : {}),
    ...(showNumbers && !preview ? { display: "flex", gap: CODE_GUTTER.gap, overflow: "visible" } : {}),
    ...codeWrapStyle(wrap),
  };

  return (
    <NodeViewWrapper
      className={cn("noema-code-block group", selected && "is-selected")}
      data-code-block=""
      data-language={language || undefined}
      data-wrap={wrap ? "true" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
    >
      <CodeBlockChrome
        locale={locale}
        state={{ hovered, focused, selected }}
        copy={copy}
        language={language}
        showNumbers={showNumbers}
        wrap={wrap}
        editable={editable}
        onLanguageChange={choose}
        onCopy={() => void copyCode(node.textContent)}
        onToggleNumbers={() => updateAttributes({ lineNumbers: !showNumbers })}
        onToggleWrap={() => setWrap((current) => !current)}
        isMermaid={isMermaid}
        preview={preview}
        onTogglePreview={() => setPreview((current) => !current)}
      />

      <pre data-block-color={blockColor ?? undefined} style={preStyle}>
        {showNumbers && (
          <div aria-hidden contentEditable={false} data-code-gutter="" style={codeGutterStyle()}>
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

      {isMermaid && preview && (
        <div contentEditable={false} className="noema-mermaid-preview">
          <MermaidDiagram source={node.textContent} />
        </div>
      )}

      {editable ? (
        <div contentEditable={false}>
          <div className="noema-image-meta">
            <input
              className="noema-image-caption"
              value={captionDraft}
              placeholder={t(locale, "imageCaptionPlaceholder")}
              aria-label={t(locale, "codeCaption")}
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
            <p role="alert" className="mt-0.5 px-1.5 text-xs text-danger">
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

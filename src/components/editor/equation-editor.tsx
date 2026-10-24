"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EQUATION_EVENT, type EquationRequest } from "@/lib/editor-events";
import type { Editor } from "@tiptap/react";
import { equationError as mathEquationError, renderEquation } from "@/lib/math-tex";
import {
  beginEquationDraft,
  equationCommitValue,
  equationDismissFromScrim,
  equationDismissOnBlur,
  equationDraftReducer,
  equationNodeMatches,
  planBlockEquationInsertion,
  type EquationDraft,
  type EquationView,
} from "@/lib/equation-editing";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import {
  Segmented,
  type SegmentedOption,
} from "@/components/ui/segmented";
import {
  MATH_CATEGORIES,
  insertSnippet,
  searchMathSymbols,
  type MathCategory,
  type MathSymbol,
} from "@/lib/math-symbols";
import {
  applyDirAttr,
  detectDirection,
  isMixed,
  type DirAttr,
  type DirectionHint,
} from "@/lib/bidi";
import {
  focusableSelector,
  resolveReturnTarget,
  trapPlan,
  type Focusable,
  type FocusPlan,
} from "@/lib/focus-trap";

/**
 * LaTeX editor for the inline/block equation nodes.
 *
 * The mathematics extension only exposes bare insert/update commands, so
 * inserting used to place a hard-coded `x` (or nothing at all) and look broken.
 * Instead anything that wants an equation dispatches `noema:equation` and this
 * editor opens: a non-destructive LaTeX/Preview switch, a live KaTeX preview
 * that stays beside the source, Enter to apply, Escape/blur to cancel (the
 * existing document source is never touched). Clicking an existing equation
 * (configured via the extension's `onClick`) reopens it for editing.
 *
 * A browsable symbol palette (backed by `@/lib/math-symbols`) sits under the
 * source box: categorized glyph buttons plus a search filter. Picking a symbol
 * splices its LaTeX in at the caret via `insertSnippet`, leaving the caret where
 * the snippet's `$0` placeholder asked for it.
 */

export { EQUATION_EVENT } from "@/lib/editor-events";
export type { EquationRequest } from "@/lib/editor-events";

/** Display headings for the palette's sections, in `MATH_CATEGORIES` order. */
const CATEGORY_LABELS: Record<MathCategory, string> = {
  greek: "Greek letters",
  operators: "Operators",
  arrows: "Arrows",
  relations: "Relations",
  sets: "Sets",
  "big-ops": "Big operators",
  accents: "Accents",
};

/* ---------------------------------------------------------------------------
   Pure model: LaTeX / Preview switch + error reporting
   ------------------------------------------------------------------------- */

export type { EquationView } from "@/lib/equation-editing";

/** Segments for the LaTeX / Preview switch, in order. */
export const EQUATION_VIEW_OPTIONS: SegmentedOption<EquationView>[] = [
  { value: "source", label: "LaTeX" },
  { value: "preview", label: "Preview" },
];

/** Flip between the source box and the rendered preview. */
export function toggleEquationView(view: EquationView): EquationView {
  return view === "source" ? "preview" : "source";
}

/**
 * Validate the LaTeX with KaTeX through the shared macro table. Returns `null`
 * when it parses cleanly, or a short human-readable message (KaTeX's "KaTeX
 * parse error:" prefix stripped) when it does not. Empty source is treated as
 * valid (there is nothing to render yet).
 *
 * Kept as a re-export so callers/tests that imported it from this module keep
 * working; the implementation and bounds live in `@/lib/math-tex`.
 */
export function equationError(latex: string): string | null {
  return mathEquationError(latex);
}

/**
 * Per-block direction for the LaTeX source *and* its live preview, from the
 * shared bidi engine. `applyDirAttr` resolves `dir` and the `dir-ltr` /
 * `dir-rtl` / `dir-mixed` / `dir-auto` classes; `hint`/`mixed` are surfaced so
 * the caller (and tests) can see which of `detectDirection` / `isMixed` drove
 * the result.
 */
export function equationDirection(latex: string): DirAttr & {
  hint: DirectionHint;
  mixed: boolean;
} {
  const { dir, className } = applyDirAttr(latex);
  return { dir, className, hint: detectDirection(latex), mixed: isMixed(latex) };
}

/* ------------------------------------------------------------------------- *
 * Focus management (shared kernel: @/lib/focus-trap)
 *
 * The equation dialog is rendered through a portal and bypasses `ui/dialog`,
 * so it owns its own Tab trap: its source box, symbol-search field, palette
 * buttons and Apply/Cancel controls are mapped to `Focusable` descriptors,
 * `trapPlan` decides the next stop (wrapping at the ends), and
 * `resolveReturnTarget` restores focus to the invoking element on close.
 * Escape keeps its existing handling (the source box + the overlay itself).
 * ------------------------------------------------------------------------- */

/**
 * Tab / Shift+Tab plan for the equation dialog, delegated to the shared
 * `@/lib/focus-trap` kernel. `activeId` is the focused stop's id (`null` when
 * focus is outside the ring, which enters at the first stop — last on
 * Shift+Tab). `null` means "nothing to trap".
 */
export function planEquationEditorTab(
  stops: readonly Focusable[],
  { activeId = null, shift = false }: { activeId?: string | null; shift?: boolean } = {},
): FocusPlan | null {
  return trapPlan(stops, {
    initial: activeId === null ? null : { id: activeId },
    shift,
  });
}

/** The dialog's real tabbable elements, tagged with their index as the id. */
function equationStops(root: HTMLElement): {
  stops: Focusable[];
  nodes: HTMLElement[];
} {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
  const stops = nodes.map((element, index) => ({
    id: String(index),
    disabled:
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true",
    // A pane hidden with the `hidden` attribute is display:none, but the
    // element itself usually carries neither `hidden` nor `aria-hidden` — the
    // ancestor does. Check both so Preview mode never traps Tab in the
    // invisible source pane.
    hidden:
      element.hidden ||
      element.getAttribute("aria-hidden") === "true" ||
      element.closest("[hidden]") !== null,
    tabIndex: element.tabIndex,
  }));
  return { stops, nodes };
}

/* ------------------------------------------------------------------------- *
 * Presentational surface
 *
 * The chrome is split out of `EquationEditor` (which owns the portal + state)
 * so the node tests can `renderToStaticMarkup` the valid/invalid source and
 * preview panes — a portal needs a live DOM, this component does not.
 * ------------------------------------------------------------------------- */

/** One palette section: a category plus its (already-filtered) symbols. */
export type EquationSymbolGroup = {
  category: MathCategory;
  symbols: readonly MathSymbol[];
};

export type EquationDialogSurfaceProps = {
  /** Whether the dialog edits an inline or a block equation. */
  kind: "inline" | "block";
  /** The current LaTeX source. */
  latex: string;
  /** Which pane is showing. */
  view: EquationView;
  /** KaTeX's message for the current source, or `null` when it parses. */
  error: string | null;
  /** The rendered preview markup (empty when the source does not parse). */
  preview: string;
  /** Per-block direction for the source and its preview. */
  direction: DirAttr & { hint: DirectionHint; mixed: boolean };
  /** Current symbol-search query. */
  symbolQuery: string;
  /** Matched symbols, bucketed into their sections. */
  symbolGroups: readonly EquationSymbolGroup[];
  /** Active locale for the chrome strings. */
  locale: string;
  /** Id shared by the source box and its error message. */
  errorId: string;
  /** The source `<textarea>`, owned by the stateful wrapper. */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onLatexChange: (value: string) => void;
  onViewChange: (view: EquationView) => void;
  onSymbolQueryChange: (value: string) => void;
  onInsertSymbol: (command: string) => void;
  onCommit: () => void;
  onClose: () => void;
  onBlur: (event: React.FocusEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
};

/**
 * The equation dialog chrome. Token-only by construction: the `surface-raised-strong`
 * panel on a `bg-overlay` scrim at `Z.modal`, the `Segmented` LaTeX/Preview
 * switch, and the danger-ring source error (`border-danger` / `text-danger`).
 */
export function EquationDialogSurface({
  kind,
  latex,
  view,
  error,
  preview,
  direction,
  symbolQuery,
  symbolGroups,
  locale,
  errorId,
  inputRef,
  onLatexChange,
  onViewChange,
  onSymbolQueryChange,
  onInsertSymbol,
  onCommit,
  onClose,
  onBlur,
  onKeyDown,
}: EquationDialogSurfaceProps) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-overlay p-4"
      style={{ zIndex: Z.modal }}
      role="dialog"
      aria-modal="true"
      aria-label={t(locale, "equationTitle")}
      data-equation-kind={kind}
      data-equation-view={view}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        if (equationDismissFromScrim(event.target, event.currentTarget)) onClose();
      }}
    >
      <div className="surface-raised-strong animate-scale-in w-full max-w-md p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">
            {kind === "block" ? t(locale, "blockEquationTitle") : t(locale, "inlineEquation")}
          </p>
          <Segmented
            options={EQUATION_VIEW_OPTIONS}
            value={view}
            onValueChange={onViewChange}
            ariaLabel={t(locale, "equationTitle")}
            size="sm"
          />
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {t(locale, "latexSyntaxHint")} <code>{"c = \\sqrt{a^2 + b^2}"}</code>
        </p>

        {/*
          The source pane is never unmounted when Preview is selected: the
          textarea keeps its value, selectionStart/selectionEnd and undo stack.
          The dialog restores focus/caret when the author switches back, so
          inline editing never loses the cursor to a "split preview".
        */}
        <div hidden={view !== "source"} data-equation-pane="source">
          <textarea
            ref={inputRef}
            rows={kind === "inline" ? 2 : 3}
            value={latex}
            dir={direction.dir}
            aria-label={t(locale, "latexSourceAria")}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder="\frac{a}{b}"
            onChange={(event) => onLatexChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onCommit();
              }
            }}
            className={cn(
              "focus-ring mt-3 w-full rounded-control border bg-bg px-3 py-2 font-mono text-sm text-fg",
              error ? "border-danger" : "border-border",
              direction.className,
            )}
          />
          {error ? (
            <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
              {error}
            </p>
          ) : null}

          {/* Live preview stays visible while editing: no mode switch needed. */}
          <div
            data-testid="equation-live-preview"
            className="mt-2 rounded-card border border-border bg-surface px-3 py-2"
          >
            <p className="text-xs font-medium text-muted">{t(locale, "previewWord")}</p>
            {error ? (
              <p className="mt-1 text-xs text-muted">—</p>
            ) : preview ? (
              <div
                dir={direction.dir}
                className={cn("mt-1 overflow-x-auto text-center", direction.className)}
                aria-live="polite"
                dangerouslySetInnerHTML={{ __html: preview }}
              />
            ) : (
              <p className="mt-1 text-xs text-muted">—</p>
            )}
          </div>

          <div className="mt-3 rounded-card border border-border">
            <div className="border-b border-border px-3 py-2">
              <input
                type="search"
                value={symbolQuery}
                onChange={(event) => onSymbolQueryChange(event.target.value)}
                aria-label={t(locale, "search")}
                placeholder={t(locale, "searchSymbols")}
                className="focus-ring h-8 w-full rounded-control border-control bg-bg px-2 text-xs text-fg"
              />
            </div>
            <div className="scrollbar-thin max-h-52 overflow-y-auto px-3 py-2">
              {symbolGroups.length === 0 ? (
                <p className="py-2 text-center text-xs text-muted">No matching symbols</p>
              ) : (
                symbolGroups.map((group) => (
                  <div key={group.category} className="mb-2 last:mb-0">
                    <p className="mb-1 text-xs font-medium text-muted">
                      {CATEGORY_LABELS[group.category]}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {group.symbols.map((symbol) => (
                        <button
                          key={symbol.latex}
                          type="button"
                          title={symbol.label}
                          aria-label={`${symbol.label} (${symbol.latex})`}
                          onClick={() => onInsertSymbol(symbol.latex)}
                          className="focus-ring u-colors rounded-control border border-border px-1.5 py-1 font-mono text-xs text-fg hover:bg-surface-2"
                        >
                          {symbol.latex}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div
          hidden={view !== "preview"}
          data-equation-pane="preview"
          data-testid="equation-preview"
          dir={direction.dir}
          className={cn(
            "mt-3 min-h-32 overflow-x-auto rounded-card border border-border bg-surface px-3 py-6 text-center",
            direction.className,
          )}
          aria-live="polite"
        >
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : preview ? (
            <div className="text-center" dangerouslySetInnerHTML={{ __html: preview }} />
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label={t(locale, "cancel")}
            className="focus-ring u-colors h-9 rounded-control border border-border px-3 text-sm text-muted hover:bg-surface-2"
          >
            {t(locale, "cancel")}
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={!latex.trim()}
            aria-label={t(locale, "apply")}
            className="focus-ring u-colors h-9 rounded-control bg-action px-3 text-sm font-medium text-action-fg hover:bg-action/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t(locale, "apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Insert a new display equation after the block that owns the selection. A
 * plain `insertBlockMath` at the caret would try to put a block node inside the
 * current paragraph; replacing an empty paragraph (the `/equation` path) or
 * inserting after a non-empty one keeps the document valid.
 */
export function insertBlockEquation(editor: Editor, latex: string): boolean {
  const type = editor.schema.nodes.blockMath;
  if (!type) return false;
  const node = type.create({ latex });
  const { $from } = editor.state.selection;
  const tr = editor.state.tr;
  const hasTextblock = $from.depth >= 1 && $from.parent.isTextblock;
  const plan = planBlockEquationInsertion({
    hasTextblock,
    emptyTextblock: hasTextblock && $from.parent.content.size === 0,
    before: hasTextblock ? $from.before($from.depth) : $from.pos,
    after: hasTextblock ? $from.after($from.depth) : $from.pos,
    pos: $from.pos,
  });

  if (plan.type === "replace") tr.replaceWith(plan.from, plan.to, node);
  else tr.insert(plan.at, node);

  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

/**
 * Insert a new inline equation. When the bubble toolbar opened the dialog from
 * a text selection, `range` replaces that selection (so `$x$` is not left
 * duplicated beside the new node).
 */
export function insertInlineEquation(
  editor: Editor,
  latex: string,
  range: { from: number; to: number } | null,
): boolean {
  if (!editor.schema.nodes.inlineMath) return false;
  if (range) {
    const node = editor.schema.nodes.inlineMath.create({ latex });
    editor.chain().focus().insertContentAt(range, node).run();
  } else {
    editor.chain().focus().insertInlineMath({ latex }).run();
  }
  return true;
}

export function EquationEditor({ editor, locale = "en" }: { editor: Editor; locale?: string }) {
  const [draft, setDraft] = useState<EquationDraft | null>(null);
  const [symbolQuery, setSymbolQuery] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const errorId = useId();
  const open = draft !== null;

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<EquationRequest>).detail;
      const kind = detail?.kind === "inline" ? "inline" : "block";
      // The bubble toolbar sends the selected text as `latex` but no range.
      // Capture the editor selection here (it is still intact while the dialog
      // opens) so confirming replaces the selection instead of duplicating it.
      const selection = editor.state.selection;
      const captureRange = kind === "inline" && detail?.pos == null;
      const next = beginEquationDraft({
        kind,
        latex: detail?.latex ?? "",
        pos: detail?.pos ?? null,
        from: detail?.from ?? (captureRange ? selection.from : undefined),
        to: detail?.to ?? (captureRange ? selection.to : undefined),
      });
      setDraft(next);
      setSymbolQuery("");
      selectionRef.current = { start: next.latex.length, end: next.latex.length };
      window.setTimeout(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
        selectionRef.current = { start: end, end };
      }, 30);
    };
    window.addEventListener(EQUATION_EVENT, handler);
    return () => window.removeEventListener(EQUATION_EVENT, handler);
  }, [editor]);

  // Record the invoking element on open and restore focus to it on close
  // (only while it is still connected).
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      invokerRef.current = active;
    }
    return () => {
      const invoker = invokerRef.current;
      invokerRef.current = null;
      const target = resolveReturnTarget({
        invoker: invoker
          ? { id: "equation-invoker", connected: invoker.isConnected }
          : null,
      });
      if (target) invoker?.focus();
    };
  }, [open]);

  const view = draft?.view ?? "source";

  /**
   * Switching back to the source pane restores focus *and* the saved caret.
   * The textarea is never unmounted, so selectionStart/selectionEnd survive;
   * this effect is what makes that invisible state visible again.
   */
  useEffect(() => {
    if (!open || view !== "source") return;
    const id = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const max = input.value.length;
      const start = Math.min(selectionRef.current.start, max);
      const end = Math.min(selectionRef.current.end, max);
      input.setSelectionRange(start, end);
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, view]);

  /** Matched symbols bucketed into their sections; empty sections are dropped. */
  const symbolGroups = useMemo(() => {
    const matches = searchMathSymbols(symbolQuery);
    return MATH_CATEGORIES.map((category) => ({
      category,
      symbols: matches.filter((symbol) => symbol.category === category),
    })).filter((group) => group.symbols.length > 0);
  }, [symbolQuery]);

  /**
   * Splice a picked symbol's LaTeX into the source at the caret. A snippet may
   * carry a `$0` placeholder (`insertSnippet` strips it), so the caret lands
   * inside an empty brace group rather than after the command.
   */
  const insertSymbol = (command: string) => {
    const { text, cursor } = insertSnippet(command);
    const input = inputRef.current;
    if (!input) {
      setDraft((previous) =>
        previous
          ? equationDraftReducer(previous, { type: "edit", latex: previous.latex + text })
          : previous,
      );
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = input.value.slice(0, start) + text + input.value.slice(end);
    setDraft((previous) =>
      previous ? equationDraftReducer(previous, { type: "edit", latex: next }) : previous,
    );
    const caret = start + cursor;
    selectionRef.current = { start: caret, end: caret };
    window.setTimeout(() => {
      input.focus();
      input.setSelectionRange(caret, caret);
    }, 0);
  };

  /** Cancel/Escape/scrim/blur all discard the draft; the document is untouched. */
  const close = () => setDraft(null);

  // Tab / Shift+Tab cycles inside the dialog; Escape cancels from anywhere.
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const { stops, nodes } = equationStops(event.currentTarget);
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? nodes.indexOf(active) : -1;
    const plan = planEquationEditorTab(stops, {
      activeId: activeIndex >= 0 ? String(activeIndex) : null,
      shift: event.shiftKey,
    });
    if (!plan) return;
    const target = nodes[Number(plan.target.id)];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  const changeView = (next: EquationView) => {
    const input = inputRef.current;
    if (input) {
      selectionRef.current = {
        start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length,
      };
    }
    setDraft((previous) =>
      previous ? equationDraftReducer(previous, { type: "view", view: next }) : previous,
    );
  };

  const onDialogBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (equationDismissOnBlur(event.relatedTarget, event.currentTarget)) close();
  };

  if (!draft) return null;

  const rendered = renderEquation(draft.latex, {
    displayMode: draft.kind === "block",
  });
  const error = rendered.error;
  const preview = rendered.html;

  // Per-block direction for the source and its preview, from the bidi engine.
  const direction = equationDirection(draft.latex);

  const commit = () => {
    const value = equationCommitValue(draft);
    if (value === null) {
      close();
      return;
    }

    if (draft.pos !== null) {
      // Existing node: update only when the stale position still points at an
      // equation of the same kind. Otherwise leave the document untouched.
      const node = editor.state.doc.nodeAt(draft.pos);
      if (node !== null && equationNodeMatches(draft.kind, node)) {
        const tr = editor.state.tr.setNodeMarkup(draft.pos, undefined, {
          ...node.attrs,
          latex: value,
        });
        editor.view.dispatch(tr);
      }
      editor.commands.focus();
    } else if (draft.kind === "block") {
      insertBlockEquation(editor, value);
    } else {
      insertInlineEquation(editor, value, draft.range);
    }

    // Applying returns focus to the document, not to the toolbar button that
    // opened the dialog (the close cleanup would otherwise re-focus it and
    // steal focus from the freshly inserted equation).
    invokerRef.current = null;
    close();
  };

  return createPortal(
    <EquationDialogSurface
      kind={draft.kind}
      latex={draft.latex}
      view={draft.view}
      error={error}
      preview={preview}
      direction={direction}
      symbolQuery={symbolQuery}
      symbolGroups={symbolGroups}
      locale={locale}
      errorId={errorId}
      inputRef={inputRef}
      onLatexChange={(value) =>
        setDraft((previous) =>
          previous ? equationDraftReducer(previous, { type: "edit", latex: value }) : previous,
        )
      }
      onViewChange={changeView}
      onSymbolQueryChange={setSymbolQuery}
      onInsertSymbol={insertSymbol}
      onCommit={commit}
      onClose={close}
      onBlur={onDialogBlur}
      onKeyDown={onDialogKeyDown}
    />,
    document.body,
  );
}

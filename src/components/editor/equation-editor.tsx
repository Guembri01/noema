"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import type { Editor } from "@tiptap/react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  MATH_CATEGORIES,
  insertSnippet,
  searchMathSymbols,
  type MathCategory,
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
 * editor opens: live KaTeX preview, Enter to apply, Escape to cancel. Clicking
 * an existing equation (configured via the extension's `onClick`) reopens it
 * for editing.
 *
 * A browsable symbol palette (backed by `@/lib/math-symbols`) sits under the
 * source box: categorized glyph buttons plus a search filter. Picking a symbol
 * splices its LaTeX in at the caret via `insertSnippet`, leaving the caret where
 * the snippet's `$0` placeholder asked for it.
 */

export const EQUATION_EVENT = "noema:equation";

export type EquationRequest = {
  kind: "inline" | "block";
  latex?: string;
  pos?: number | null;
};

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
    hidden: element.hidden || element.getAttribute("aria-hidden") === "true",
    tabIndex: element.tabIndex,
  }));
  return { stops, nodes };
}

export function EquationEditor({ editor, locale = "en" }: { editor: Editor; locale?: string }) {
  const [request, setRequest] = useState<EquationRequest | null>(null);
  const [latex, setLatex] = useState("");
  const [symbolQuery, setSymbolQuery] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const open = request !== null;

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<EquationRequest>).detail;
      const next: EquationRequest = {
        kind: detail?.kind === "inline" ? "inline" : "block",
        latex: detail?.latex ?? "",
        pos: detail?.pos ?? null,
      };
      setRequest(next);
      setLatex(next.latex ?? "");
      setSymbolQuery("");
      window.setTimeout(() => inputRef.current?.focus(), 30);
    };
    window.addEventListener(EQUATION_EVENT, handler);
    return () => window.removeEventListener(EQUATION_EVENT, handler);
  }, []);

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
      setLatex((previous) => previous + text);
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    setLatex(input.value.slice(0, start) + text + input.value.slice(end));
    const caret = start + cursor;
    window.setTimeout(() => {
      input.focus();
      input.setSelectionRange(caret, caret);
    }, 0);
  };

  // Tab / Shift+Tab cycles inside the dialog; Escape keeps its handling below.
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
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

  if (!request) return null;

  let preview = "";
  try {
    preview = katex.renderToString(latex.trim() || "\\text{preview}", {
      throwOnError: false,
      displayMode: request.kind === "block",
    });
  } catch {
    preview = "";
  }

  // Per-block direction for the source and its preview, from the bidi engine.
  const direction = equationDirection(latex);

  const close = () => setRequest(null);

  const commit = () => {
    const value = latex.trim();
    if (!value) {
      close();
      return;
    }
    const { pos } = request;
    if (pos !== null && pos !== undefined) {
      const node = editor.state.doc.nodeAt(pos);
      if (node) {
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: value });
        editor.view.dispatch(tr);
      }
    } else if (request.kind === "block") {
      editor.chain().focus().insertBlockMath({ latex: value }).run();
    } else {
      editor.chain().focus().insertInlineMath({ latex: value }).run();
    }
    close();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t(locale, "equationTitle")}
      onKeyDown={onDialogKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-bg p-4 shadow-2xl">
        <p className="text-sm font-medium">
          {request.kind === "block" ? t(locale, "blockEquationTitle") : t(locale, "inlineEquation")}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {t(locale, "latexSyntaxHint")} <code>c = \sqrt&#123;a^2 + b^2&#125;</code>
        </p>
        <textarea
          ref={inputRef}
          rows={3}
          value={latex}
          dir={direction.dir}
          aria-label={t(locale, "latexSourceAria")}
          placeholder="\frac{a}{b}"
          onChange={(event) => setLatex(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") close();
          }}
          className={cn(
            "mt-3 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent",
            direction.className,
          )}
        />
        <div
          dir={direction.dir}
          className={cn(
            "mt-3 min-h-12 overflow-x-auto rounded-md border border-border bg-surface px-3 py-2 text-center",
            direction.className,
          )}
          aria-live="polite"
          dangerouslySetInnerHTML={{ __html: preview }}
        />
        <div className="mt-3 rounded-md border border-border">
          <div className="border-b border-border px-3 py-2">
            <input
              type="search"
              value={symbolQuery}
              onChange={(event) => setSymbolQuery(event.target.value)}
              aria-label={t(locale, "search")}
              placeholder="Search symbols…"
              className="h-8 w-full rounded border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
            />
          </div>
          <div className="max-h-52 overflow-y-auto px-3 py-2">
            {symbolGroups.length === 0 ? (
              <p className="py-2 text-center text-xs text-muted">No matching symbols</p>
            ) : (
              symbolGroups.map((group) => (
                <div key={group.category} className="mb-2 last:mb-0">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    {CATEGORY_LABELS[group.category]}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {group.symbols.map((symbol) => (
                      <button
                        key={symbol.latex}
                        type="button"
                        title={symbol.label}
                        aria-label={`${symbol.label} (${symbol.latex})`}
                        onClick={() => insertSymbol(symbol.latex)}
                        className="rounded border border-border px-1.5 py-1 font-mono text-xs hover:bg-surface-2"
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
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
          >
            {t(locale, "cancel")}
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={!latex.trim()}
            className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
          >
            {t(locale, "apply")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

"use client";

import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { t } from "@/lib/i18n";
import { FORMULA_FUNCTIONS } from "@/lib/formula-function-catalog";
import {
  applyCompletion,
  contextAt,
  diagnose,
  formatFormula,
  signatureHelp,
  suggestCompletions,
  type FormulaCompletionItem,
  type FormulaContext,
  type FormulaDiagnostic,
  type SignatureHelp,
} from "@/lib/formula-editor";

/**
 * A real formula editor: a monospace source box with function/property
 * autocomplete, signature help for the call the caret sits in, live syntax /
 * unknown-name diagnostics and a "Format" action. All of the authoring
 * intelligence lives in the pure `@/lib/formula-editor` helpers (and the
 * catalog); this component only wires them to a controlled `<textarea>` and
 * caret, so the mapping stays unit-testable without a DOM.
 *
 * The editor is controlled: `onChange` fires on every keystroke so the parent
 * can keep a live draft, while `onCommit` (blur / Format) is where a parent
 * should persist, to avoid a write per character.
 */

/** Stable empty default so `useMemo` does not churn on every render. */
const NO_PROPERTIES: readonly string[] = [];

/** Everything the editor renders for one `(source, caret)` pair. */
export type FormulaEditorModel = {
  readonly context: FormulaContext;
  readonly completions: readonly FormulaCompletionItem[];
  readonly signature: SignatureHelp | null;
  readonly diagnostics: readonly FormulaDiagnostic[];
};

/**
 * Compose the `@/lib/formula-editor` helpers for a caret position: classify the
 * context, rank completions (functions first, then the supplied property names),
 * resolve signature help for the enclosing call, and collect diagnostics. Pure
 * and total, so it is safe to call on every keystroke.
 */
export function buildFormulaEditorModel(
  source: string,
  caret: number,
  properties: readonly string[] = NO_PROPERTIES,
): FormulaEditorModel {
  const context = contextAt(source, caret);
  return {
    context,
    completions: suggestCompletions(FORMULA_FUNCTIONS, { properties }, context),
    signature:
      context.functionName === undefined
        ? null
        : signatureHelp(FORMULA_FUNCTIONS, context.functionName, context.argIndex),
    diagnostics: diagnose(source, FORMULA_FUNCTIONS),
  };
}

export type FormulaEditorProps = {
  value: string;
  /** Fired on every edit, for the caller's live draft. */
  onChange: (next: string) => void;
  /** Fired on blur and after Format, where a caller should persist. */
  onCommit?: (next: string) => void;
  /** Database property names offered for `prop("…")` completions. */
  properties?: readonly string[];
  locale?: string;
  placeholder?: string;
  /** Optional `data-testid` applied to the root element. */
  dataTestId?: string;
};

export function FormulaEditor({
  value,
  onChange,
  onCommit,
  properties = NO_PROPERTIES,
  locale = "en",
  placeholder,
  dataTestId,
}: FormulaEditorProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const model = useMemo(
    () => buildFormulaEditorModel(value, caret, properties),
    [value, caret, properties],
  );
  const completions = dismissed ? [] : model.completions;
  const signature = model.signature;

  /** Mirror the textarea's own selection into state after any caret move. */
  const syncCaret = () => {
    const input = inputRef.current;
    if (!input) return;
    setCaret(input.selectionStart ?? input.value.length);
    setDismissed(false);
    setActiveIndex(0);
  };

  /** Splice a picked completion in, then place the caret where it asks. */
  const accept = (item: FormulaCompletionItem) => {
    const applied = applyCompletion(value, item);
    onChange(applied.text);
    setDismissed(true);
    setActiveIndex(0);
    window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(applied.caret, applied.caret);
      setCaret(applied.caret);
    }, 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (completions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % completions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + completions.length) % completions.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const item = completions[Math.min(activeIndex, completions.length - 1)];
      if (item) {
        event.preventDefault();
        accept(item);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  };

  /** Normalise spacing; a formula that cannot lex is returned verbatim. */
  const handleFormat = () => {
    const formatted = formatFormula(value);
    onChange(formatted);
    onCommit?.(formatted);
  };

  return (
    <div className="space-y-2" data-testid={dataTestId}>
      <textarea
        ref={inputRef}
        rows={3}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={t(locale, "formulaWord")}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setDismissed(false);
        }}
        onSelect={syncCaret}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        onKeyDown={handleKeyDown}
        onBlur={() => onCommit?.(value)}
        className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
      />

      {signature !== null && (
        <p
          className="text-xs text-muted"
          data-testid={dataTestId ? `${dataTestId}-signature` : undefined}
        >
          <code className="font-mono">{signature.label}</code>
          {signature.doc !== "" ? ` — ${signature.doc}` : ""}
          {signature.parameters.length > 0
            ? ` · ${signature.parameters[signature.activeParameter] ?? ""}`
            : ""}
        </p>
      )}

      {completions.length > 0 && (
        <ul
          className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-border p-1"
          aria-label="Completions"
          data-testid={dataTestId ? `${dataTestId}-completions` : undefined}
        >
          {completions.map((item, index) => (
            <li key={`${item.kind}:${item.label}`}>
              <button
                type="button"
                aria-current={index === activeIndex}
                onMouseDown={(event) => {
                  // Keep focus in the textarea so the caret survives the click.
                  event.preventDefault();
                  accept(item);
                }}
                className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs hover:bg-surface-2 ${
                  index === activeIndex ? "bg-surface-2" : ""
                }`}
              >
                <span className="font-mono">{item.label}</span>
                <span className="truncate text-muted">
                  {item.kind === "function" ? item.detail : "property"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {model.diagnostics.length > 0 && (
        <ul
          className="space-y-1"
          data-testid={dataTestId ? `${dataTestId}-diagnostics` : undefined}
        >
          {model.diagnostics.map((diagnostic) => (
            <li
              key={`${diagnostic.code}:${diagnostic.start}`}
              className="text-xs text-red-500"
            >
              {diagnostic.message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleFormat}
          className="h-7 rounded border border-border px-2 text-xs text-muted hover:bg-surface-2"
        >
          Format
        </button>
      </div>
    </div>
  );
}

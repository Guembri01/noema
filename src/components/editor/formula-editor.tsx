"use client";

import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AlertCircle } from "lucide-react";
import { t } from "@/lib/i18n";
import {
  FORMULA_FUNCTIONS,
  type FunctionCategory,
} from "@/lib/formula-function-catalog";
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
import { Z, type TagHue } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { textareaClasses } from "@/components/ui/input";

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
 *
 * Every colour, shape, motion and layer comes from the token layer: the
 * completion popup is a `.surface-raised animate-rise` panel at `Z.popover`, the
 * diagnostics use `text-danger` inside a `role="alert"` list, and each
 * completion's catalog category renders as a `Tag`.
 */

/** Stable empty default so `useMemo` does not churn on every render. */
const NO_PROPERTIES: readonly string[] = [];

/** Catalog category of a completion, or `property` for a reference row. */
export type FormulaCompletionCategory = FunctionCategory | "property";

/** A completion enriched with the category its row renders as a `Tag`. */
export type FormulaCompletionRow = FormulaCompletionItem & {
  readonly category: FormulaCompletionCategory;
};

/** Everything the editor renders for one `(source, caret)` pair. */
export type FormulaEditorModel = {
  readonly context: FormulaContext;
  readonly completions: readonly FormulaCompletionRow[];
  readonly signature: SignatureHelp | null;
  readonly diagnostics: readonly FormulaDiagnostic[];
};

/** Function name → catalog category, resolved once at module load. */
const CATEGORY_BY_NAME: ReadonlyMap<string, FunctionCategory> = new Map(
  FORMULA_FUNCTIONS.map((entry) => [entry.name, entry.category]),
);

const CATEGORY_HUE: Readonly<Partial<Record<FormulaCompletionCategory, TagHue>>> = {
  math: "blue",
  text: "purple",
  logic: "teal",
  date: "orange",
  regex: "pink",
  list: "green",
  reference: "yellow",
  property: "gray",
};

/** Tag hue for a completion category; unknown values fall back to `gray`. */
export function completionCategoryHue(category: string): TagHue {
  return CATEGORY_HUE[category as FormulaCompletionCategory] ?? "gray";
}

/**
 * Compose the `@/lib/formula-editor` helpers for a caret position: classify the
 * context, rank completions (functions first, then the supplied property names),
 * resolve signature help for the enclosing call, and collect diagnostics. Each
 * completion carries its catalog category so the popup can tag the row. Pure and
 * total, so it is safe to call on every keystroke.
 */
export function buildFormulaEditorModel(
  source: string,
  caret: number,
  properties: readonly string[] = NO_PROPERTIES,
): FormulaEditorModel {
  const context = contextAt(source, caret);
  const completions: FormulaCompletionRow[] = suggestCompletions(
    FORMULA_FUNCTIONS,
    { properties },
    context,
  ).map((item) => ({
    ...item,
    category:
      item.kind === "property" ? "property" : CATEGORY_BY_NAME.get(item.label) ?? "reference",
  }));
  return {
    context,
    completions,
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
  const accept = (item: FormulaCompletionRow) => {
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
    <div className="flex flex-col gap-2" data-testid={dataTestId}>
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
        className={cn(textareaClasses({ size: "md" }), "font-mono")}
      />

      {signature !== null && (
        <div
          className="flex flex-wrap items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2 py-1 text-xs text-muted"
          data-testid={dataTestId ? `${dataTestId}-signature` : undefined}
        >
          <code className="font-mono text-fg">{signature.label}</code>
          {signature.doc !== "" ? <span>{`— ${signature.doc}`}</span> : null}
          {signature.parameters.length > 0 ? (
            <Tag hue="gray" size="sm">
              {signature.parameters[signature.activeParameter] ?? ""}
            </Tag>
          ) : null}
        </div>
      )}

      {completions.length > 0 && (
        <div
          className="surface-raised animate-rise max-h-40 overflow-y-auto scrollbar-thin p-1 text-fg"
          style={{ zIndex: Z.popover }}
        >
          <ul
            aria-label={t(locale, "completions")}
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
                  className={cn(
                    "u-colors flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-surface-2",
                    index === activeIndex && "bg-surface-2",
                  )}
                >
                  <Tag hue={completionCategoryHue(item.category)} size="sm">
                    {item.category}
                  </Tag>
                  <span className="font-mono">{item.label}</span>
                  <span className="truncate text-muted">
                    {item.kind === "function" ? item.detail : "property"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {model.diagnostics.length > 0 && (
        <ul
          role="alert"
          className="flex flex-col gap-1"
          data-testid={dataTestId ? `${dataTestId}-diagnostics` : undefined}
        >
          {model.diagnostics.map((diagnostic) => (
            <li
              key={`${diagnostic.code}:${diagnostic.start}`}
              className="flex items-start gap-1.5 text-xs text-danger"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{diagnostic.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <Button type="button" variant="secondary" size="xs" onClick={handleFormat}>
          Format
        </Button>
      </div>
    </div>
  );
}

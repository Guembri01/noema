"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Regex,
  Search,
  WholeWord,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import {
  findInPage,
  nextIndex,
  prevIndex,
  type FindBlock,
  type FindMatch,
  type FindOptions,
} from "@/lib/find-in-page";

/**
 * The editor's Ctrl+F bar (docs/DESIGN_SYSTEM.md §5/§6/§7/§9): a floating
 * `surface-raised` popover pinned to the editor's top-right. Everything that
 * decides *what* matches lives in `src/lib/find-in-page.ts`; this file is the
 * thin, keyboard-first adapter around it.
 *
 * ## Contract
 *
 * - The query re-runs its matcher a {@link FIND_DEBOUNCE_MS} after the last
 *   keystroke.
 * - `Enter` steps to the next match, `Shift+Enter` to the previous; the input
 *   keeps focus through both (navigation never steals it from the field).
 * - `caseSensitive` / `wholeWord` / `regex` are `.u-interactive` icon toggles
 *   carrying `aria-pressed`.
 * - `Esc` or the close button calls `onClose`; the visible `N / M` counter is
 *   mirrored to a polite live region as `"N of M matches"`.
 *
 * Mounting the bar inside `page-editor.tsx`, wiring `onSelect` to scroll the
 * active match into view and binding Ctrl+F/Ctrl+Shift+F are a documented
 * follow-up owned by the editor slice — this component is self-contained.
 */

/** Debounce before a keystroke re-runs the matcher, in ms. */
export const FIND_DEBOUNCE_MS = 120;

/**
 * Chrome strings. English-only for now: the i18n catalogue (`src/lib/i18n.ts`)
 * is owned by another slice, so these land as catalogue keys with the editor
 * wiring. Kept in one object so the swap is mechanical.
 */
const LABELS = {
  region: "Find in page",
  input: "Find in page",
  placeholder: "Find in page",
  matchCase: "Match case",
  wholeWord: "Match whole word",
  regex: "Use regular expression",
  previous: "Previous match",
  next: "Next match",
  close: "Close find in page",
} as const;

/** Keyboard hints shown beside the navigation buttons. */
const PREVIOUS_HINT = "⇧⏎";
const NEXT_HINT = "⏎";

/** Shared empty result so `matches` keeps a stable identity between renders. */
const NO_MATCHES: readonly FindMatch[] = [];

/** A square, focusable icon button used for both toggles and actions. */
function ToolButton({
  label,
  hint,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={hint ? `${label} (${hint})` : label}
      disabled={disabled}
      // Keep the caret in the find field when a control is clicked.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "u-interactive focus-ring flex h-7 min-w-7 shrink-0 items-center justify-center gap-0.5 rounded-control px-1 text-muted",
        pressed ? "bg-surface-2 text-fg" : "hover:bg-surface-2",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}

export type FindBarProps = {
  /** The page, flattened to blocks in document order. */
  blocks: readonly FindBlock[];
  /** Initial query. Lets a host prefill the bar (and the tests seed a count). */
  initialQuery?: string;
  /** Called with the active match (or `null`) whenever the cursor moves. */
  onSelect?: (match: FindMatch | null, index: number) => void;
  /** Called on `Esc` or the close button. */
  onClose?: () => void;
};

export function FindBar({ blocks, initialQuery = "", onSelect, onClose }: FindBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [deferredQuery, setDeferredQuery] = useState(initialQuery);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // Debounce the query into the matcher; the field itself stays immediate.
  useEffect(() => {
    const timer = setTimeout(() => setDeferredQuery(query), FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // The bar owns focus on open so typing can start straight away.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const options = useMemo<FindOptions>(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );

  const result = useMemo(
    () => findInPage(blocks, deferredQuery, options),
    [blocks, deferredQuery, options],
  );
  const matches = result.ok ? result.matches : NO_MATCHES;
  const error = result.ok ? null : result.error;
  const count = matches.length;

  // Keep the cursor in range as the result set shrinks (e.g. query narrows).
  useEffect(() => {
    setCurrent((previous) => {
      if (count === 0 || previous < 0) return 0;
      return previous >= count ? count - 1 : previous;
    });
  }, [count]);

  useEffect(() => {
    onSelect?.(matches[current] ?? null, current);
  }, [onSelect, matches, current]);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (count === 0) return;
      setCurrent((previous) =>
        direction === 1 ? nextIndex(previous, count) : prevIndex(previous, count),
      );
      inputRef.current?.focus();
    },
    [count],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
      return;
    }
    // Only the field owns Enter/Shift+Enter; a button's own activation must win.
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  const displayIndex = count === 0 ? 0 : current + 1;

  return (
    <div
      role="search"
      aria-label={LABELS.region}
      data-testid="editor-find-bar"
      onKeyDown={handleKeyDown}
      style={{ zIndex: Z.popover }}
      className="surface-raised animate-rise fixed right-3 top-3 flex w-[min(92vw,26rem)] flex-wrap items-center gap-1 p-1.5"
    >
      <Search aria-hidden className="ms-1 h-4 w-4 shrink-0 text-muted" />

      <input
        ref={inputRef}
        id={inputId}
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={LABELS.input}
        aria-invalid={result.ok ? undefined : true}
        placeholder={LABELS.placeholder}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "focus-ring h-7 min-w-0 flex-1 rounded-control bg-surface-2 px-2 text-sm text-fg placeholder:text-muted",
          !result.ok && "border border-danger",
        )}
      />

      <span aria-hidden className="shrink-0 px-1 text-xs tabular-nums text-muted">
        {displayIndex} / {count}
      </span>

      {/* Announced form of the counter, e.g. "3 of 12 matches". */}
      <span aria-live="polite" className="sr-only">
        {`${displayIndex} of ${count} matches`}
      </span>

      <ToolButton
        label={LABELS.previous}
        hint={PREVIOUS_HINT}
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp aria-hidden className="h-4 w-4" />
        <kbd className="hidden text-3xs leading-none text-muted sm:inline">{PREVIOUS_HINT}</kbd>
      </ToolButton>

      <ToolButton label={LABELS.next} hint={NEXT_HINT} disabled={count === 0} onClick={() => step(1)}>
        <ChevronDown aria-hidden className="h-4 w-4" />
        <kbd className="hidden text-3xs leading-none text-muted sm:inline">{NEXT_HINT}</kbd>
      </ToolButton>

      <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />

      <ToolButton
        label={LABELS.matchCase}
        pressed={caseSensitive}
        onClick={() => setCaseSensitive((value) => !value)}
      >
        <CaseSensitive aria-hidden className="h-4 w-4" />
      </ToolButton>

      <ToolButton
        label={LABELS.wholeWord}
        pressed={wholeWord}
        onClick={() => setWholeWord((value) => !value)}
      >
        <WholeWord aria-hidden className="h-4 w-4" />
      </ToolButton>

      <ToolButton label={LABELS.regex} pressed={regex} onClick={() => setRegex((value) => !value)}>
        <Regex aria-hidden className="h-4 w-4" />
      </ToolButton>

      <ToolButton label={LABELS.close} onClick={() => onClose?.()}>
        <X aria-hidden className="h-4 w-4" />
      </ToolButton>

      {error && (
        <span role="alert" className="w-full px-1 pb-0.5 text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

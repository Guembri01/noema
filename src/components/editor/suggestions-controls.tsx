"use client";

/**
 * Track-changes review chrome: suggesting toggle, pending count, per-item and
 * bulk accept/reject. The SmartSuggestions extension owns the session; this
 * component only reads its selectors and dispatches its commands.
 */
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Z } from "@/lib/design-tokens";
import { FLOATING_CORNER } from "@/lib/floating-corner";
import {
  isSuggesting,
  pendingSuggestions,
} from "@/components/editor/extensions/suggestions";
import type { Suggestion } from "@/lib/suggestions";

function suggestionLabel(suggestion: Suggestion, locale: string): string {
  const before = suggestion.before?.text?.trim();
  const after = suggestion.after?.text?.trim();
  if (suggestion.kind === "insert") {
    return `${t(locale, "suggestionInserted")}: ${after ?? "…"}`;
  }
  if (suggestion.kind === "delete") {
    return `${t(locale, "deletedPrefix")}: ${before ?? "…"}`;
  }
  return `${t(locale, "suggestionReplaced")}: ${before ?? "…"} → ${after ?? "…"}`;
}

/**
 * Compact review chrome for Suggestions (track-changes) mode: a "Suggesting"
 * on/off toggle, a live pending count and per-item / bulk accept-reject.
 *
 * The `SmartSuggestions` plugin (registered through `InputRules.addExtensions`)
 * owns the base snapshot and the diff; this component is a pure view over it.
 * It re-renders on the editor's `transaction` event — the same hook
 * `HistoryControls` uses — so the count tracks the document even on changes
 * that do not originate from this control.
 */
export function SuggestionsControls({ editor, locale }: { editor: Editor; locale: string }) {
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const update = () => force((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  const active = isSuggesting(editor.state);
  const pending = pendingSuggestions(editor.state);

  return (
    <div
      // Bottom-right, in the stack above the undo/redo bar. It used to be pinned
      // to the bottom-*left* to stay out of the undo/redo bar's way, which put it
      // straight on top of the sidebar footer — picking a corner the contract does
      // not cover is not a way to avoid a collision, it just moves it. See
      // `src/lib/floating-corner.ts`.
      className={cn(
        "fixed flex flex-col items-end gap-1 text-xs",
        FLOATING_CORNER.suggest,
      )}
      style={{ zIndex: Z.sticky }}
    >
      {open && pending.length > 0 && (
        <ul
          aria-label={t(locale, "suggestionsWord")}
          className="max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-lg"
        >
          {pending.map((suggestion) => (
            <li
              key={suggestion.id}
              className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2"
            >
              <span
                className="min-w-0 flex-1 truncate text-fg"
                title={suggestionLabel(suggestion, locale)}
              >
                {suggestionLabel(suggestion, locale)}
              </span>
              <button
                type="button"
                aria-label={t(locale, "acceptSuggestion")}
                title={t(locale, "acceptSuggestion")}
                onClick={() => editor.chain().focus().acceptSuggestion(suggestion.id).run()}
                className="rounded px-1 text-success hover:bg-surface"
              >
                ✓
              </button>
              <button
                type="button"
                aria-label={t(locale, "rejectSuggestion")}
                title={t(locale, "rejectSuggestion")}
                onClick={() => editor.chain().focus().rejectSuggestion(suggestion.id).run()}
                className="rounded px-1 text-danger hover:bg-surface"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-lg">
        <button
          type="button"
          aria-pressed={active}
          aria-label={t(locale, "suggestingWord")}
          title={t(locale, "suggestingWord")}
          onClick={() => {
            editor.chain().focus().setSuggesting(!active).run();
            if (active) setOpen(false);
          }}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-2 ${
            active ? "text-success" : "text-muted"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-success" : "bg-muted"}`} />
          {t(locale, "suggestingWord")}
        </button>

        {pending.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={open}
              aria-label={t(locale, "reviewSuggestions")}
              title={t(locale, "reviewSuggestions")}
              onClick={() => setOpen((value) => !value)}
              className="rounded bg-surface px-1.5 py-0.5 text-fg hover:bg-surface-2"
            >
              {pending.length} {t(locale, "pendingWord")}
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().acceptAll().run()}
              className="rounded px-1.5 py-0.5 text-success hover:bg-surface-2"
            >
              {t(locale, "acceptAllSuggestions")}
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().rejectAll().run()}
              className="rounded px-1.5 py-0.5 text-danger hover:bg-surface-2"
            >
              {t(locale, "rejectAllSuggestions")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

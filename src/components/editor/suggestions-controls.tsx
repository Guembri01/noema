"use client";

/**
 * Track-changes review chrome: suggesting toggle, pending count, per-item and
 * bulk accept/reject. The SmartSuggestions extension owns the session; this
 * component only reads its selectors and dispatches its commands.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { PenLine } from "lucide-react";
import { useEditorFocus } from "@/components/editor/use-editor-focus";
import { guarded } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Z } from "@/lib/design-tokens";
import { FLOATING_CORNER } from "@/lib/floating-corner";
import {
  getSmartSuggestionsState,
  isSuggesting,
  pendingSuggestions,
} from "@/components/editor/extensions/suggestions";
import {
  loadSuggestionSessionAction as rawLoadSuggestionSessionAction,
  saveSuggestionSessionAction as rawSaveSuggestionSessionAction,
} from "@/server/actions/suggestions";
import type { Suggestion } from "@/lib/suggestions";

const loadSuggestionSessionAction = guarded(rawLoadSuggestionSessionAction);
const saveSuggestionSessionAction = guarded(rawSaveSuggestionSessionAction);

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
export function SuggestionsControls({
  editor,
  locale,
  pageId,
}: {
  editor: Editor;
  locale: string;
  pageId: string;
}) {
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);
  const focused = useEditorFocus(editor);
  const hydrated = useRef(false);
  const lastSaved = useRef(JSON.stringify({ active: false }));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const update = () => force((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  // Restore a persisted session once, then let the transaction listener save
  // the base/session changes. Applying the base recomputes the pending list
  // against the live document, so suggestions survive a reload.
  useEffect(() => {
    let cancelled = false;
    hydrated.current = false;
    loadSuggestionSessionAction(pageId)
      .then((result) => {
        if (cancelled) return;
        if (
          !("error" in result) &&
          result.active &&
          Array.isArray(result.base) &&
          result.base.length > 0
        ) {
          editor
            .chain()
            .focus()
            .hydrateSuggestions(result.base, {
              authorId: result.authorId ?? undefined,
            })
            .run();
          lastSaved.current = JSON.stringify({
            active: true,
            base: result.base,
          });
        } else {
          lastSaved.current = JSON.stringify({ active: false });
        }
      })
      .finally(() => {
        if (!cancelled) hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [editor, pageId]);

  // Persist the committed base, debounced through the same 600 ms cadence as
  // the document autosave. Accept/reject advances the base, so the effect
  // naturally records the new comparison point.
  useEffect(() => {
    const snapshot = () => {
      const state = getSmartSuggestionsState(editor.state);
      const active = state?.active ?? false;
      const base = active ? state?.base ?? null : null;
      if (active && (!base || base.length === 0)) return null;
      return {
        active,
        base,
        key: JSON.stringify(active ? { active: true, base } : { active: false }),
      };
    };

    const persist = (immediate: boolean) => {
      if (!hydrated.current) return;
      const next = snapshot();
      if (!next || next.key === lastSaved.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const commit = () => {
        lastSaved.current = next.key;
        void saveSuggestionSessionAction(
          pageId,
          next.active ? { active: true, base: next.base } : { active: false },
        );
      };
      if (immediate) commit();
      else saveTimer.current = setTimeout(commit, 600);
    };

    const onTransaction = () => persist(false);
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        persist(true);
      }
    };
  }, [editor, pageId]);

  const active = isSuggesting(editor.state);
  const pending = pendingSuggestions(editor.state);
  // On phones the fixed pill would otherwise sit over body copy while the page
  // is being read. Keep it available as soon as the editor is focused, or while
  // the mode / a pending review is active; desktop keeps the always-visible
  // control that the floating-corner contract describes.
  const showOnSmall = focused || active || pending.length > 0;

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
        !showOnSmall && "max-sm:hidden",
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

      <div
        className="flex items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-lg"
        // Do not let the toggle blur the editor before the tap lands: below
        // `sm` an unfocused editor hides this bar.
        onMouseDown={(event) => event.preventDefault()}
      >
        <button
          type="button"
          aria-pressed={active}
          aria-label={t(locale, "suggestingWord")}
          title={t(locale, "suggestingWord")}
          onClick={() => {
            editor.chain().focus().setSuggesting(!active).run();
            if (active) setOpen(false);
          }}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-2",
            // On a phone the label is too wide for a floating mode control.
            // It collapses to a compact pen button; the pressed state and
            // accessible name still carry the meaning.
            "max-sm:h-7 max-sm:w-7 max-sm:justify-center max-sm:rounded-full max-sm:p-0",
            active ? "text-success" : "text-muted",
          )}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full max-sm:hidden ${active ? "bg-success" : "bg-muted"}`}
          />
          <PenLine className="h-3.5 w-3.5 sm:hidden" aria-hidden />
          <span className="hidden sm:inline">{t(locale, "suggestingWord")}</span>
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

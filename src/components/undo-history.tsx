"use client";

/**
 * The visible history surface for the global undo stack.
 *
 * It renders the engine's actual entries (not a toast log): newest first, each
 * with its label, age and a single affordance — Undo for an applied local step,
 * Redo for an undone one. A collaborator's entry stays visible for context but
 * has no button, because this client cannot invert it.
 *
 * The list is presentational and takes `now` explicitly, so it can be rendered
 * statically in tests with a fixed clock.
 */

import { History, Redo2, Undo2, Users } from "lucide-react";
import type { HistoryEntry } from "@/lib/undo-redo";
import { undoHistoryRows } from "@/lib/undo-history";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type UndoHistoryListProps = {
  entries: readonly HistoryEntry[];
  locale: string;
  /** Render clock; defaults to `Date.now()`. Tests inject a fixed value. */
  now?: number;
  onUndoTo: (index: number) => void;
  onRedoTo: (index: number) => void;
};

export function UndoHistoryList({
  entries,
  locale,
  now = Date.now(),
  onUndoTo,
  onRedoTo,
}: UndoHistoryListProps) {
  const rows = undoHistoryRows(entries, now, t(locale, "justNow"));
  if (rows.length === 0) {
    return (
      <p
        data-testid="undo-history-empty"
        className="px-3 py-4 text-xs text-muted"
      >
        {t(locale, "noUndoHistory")}
      </p>
    );
  }

  return (
    <ol data-testid="undo-history-list" className="max-h-72 overflow-y-auto py-1">
      {rows.map((row) => (
        <li
          key={`${row.id}:${row.index}`}
          data-testid={`undo-history-entry-${row.index}`}
          data-applied={row.applied ? "true" : "false"}
          data-remote={row.remote ? "true" : "false"}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-xs",
            row.applied ? "text-fg" : "text-muted",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              row.remote
                ? "bg-border-strong"
                : row.applied
                  ? "bg-action"
                  : "bg-muted",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              row.action === "redo" && "line-through decoration-border-strong",
            )}
            title={row.label}
          >
            {row.label}
          </span>
          {row.age ? (
            <time
              dateTime={
                typeof row.at === "number"
                  ? new Date(row.at).toISOString()
                  : undefined
              }
              className="shrink-0 tabular-nums text-2xs text-muted"
            >
              {row.age}
            </time>
          ) : null}
          {row.remote ? (
            <span
              className="flex shrink-0 items-center text-muted"
              title={t(locale, "remoteAction")}
              aria-label={t(locale, "remoteAction")}
            >
              <Users className="h-3 w-3" aria-hidden />
            </span>
          ) : row.action === "undo" ? (
            <button
              type="button"
              data-testid={`undo-history-undo-${row.index}`}
              aria-label={`${t(locale, "undo")}: ${row.label}`}
              title={`${t(locale, "undo")} → ${row.label}`}
              onClick={() => onUndoTo(row.index)}
              className="focus-ring u-interactive flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : row.action === "redo" ? (
            <button
              type="button"
              data-testid={`undo-history-redo-${row.index}`}
              aria-label={`${t(locale, "redo")}: ${row.label}`}
              title={`${t(locale, "redo")} → ${row.label}`}
              onClick={() => onRedoTo(row.index)}
              className="focus-ring u-interactive flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Redo2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : (
            <span className="h-6 w-6 shrink-0" aria-hidden />
          )}
        </li>
      ))}
    </ol>
  );
}

/** The topbar trigger + popover around {@link UndoHistoryList}. */
export function UndoHistoryControl({
  entries,
  locale,
  onUndoTo,
  onRedoTo,
}: Omit<UndoHistoryListProps, "now">) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="undo-history-trigger"
          aria-label={t(locale, "undoHistory")}
          title={t(locale, "undoHistory")}
          className="focus-ring u-interactive flex h-8 w-8 items-center justify-center rounded text-muted sm:h-7 sm:w-7 hover:bg-surface-2"
        >
          <History className="h-4 w-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-fg">
            {t(locale, "undoHistory")}
          </span>
          <span className="text-2xs tabular-nums text-muted">
            {entries.length}
          </span>
        </div>
        <UndoHistoryList
          entries={entries}
          locale={locale}
          onUndoTo={onUndoTo}
          onRedoTo={onRedoTo}
        />
      </PopoverContent>
    </Popover>
  );
}

"use client";

import { Plus, Tag } from "lucide-react";
import { t } from "@/lib/i18n";

/**
 * Shown in place of the list/board/timeline when the workspace holds no tickets
 * at all. Before this, an empty tracker rendered six empty board columns under
 * a bare "0 of 0 tickets" rollup, which read as broken. The empty state gives
 * the two obvious first actions instead: create the first ticket, or add the
 * first label so the tracker has something to organise by.
 */
export function EmptyTicketsState({
  onCreate,
  onAddLabel,
  hasLabels,
  locale = "en",
}: {
  onCreate: () => void;
  onAddLabel: () => void;
  /** Whether the workspace already has labels (changes the second CTA copy). */
  hasLabels: boolean;
  locale?: string;
}) {
  return (
    <div
      data-testid="tickets-empty"
      className="rounded-xl border border-dashed border-border px-6 py-12 text-center"
    >
      <p className="text-lg font-medium">No tickets yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">
        Create your first ticket to start tracking work, or add a label to organise
        everything that follows.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onCreate}
          className="flex h-9 items-center gap-1.5 rounded bg-accent px-3 text-sm text-accent-fg"
        >
          <Plus className="h-4 w-4" /> {t(locale, "createTicket")}
        </button>
        <button
          type="button"
          onClick={onAddLabel}
          className="flex h-9 items-center gap-1.5 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
        >
          <Tag className="h-4 w-4" /> {hasLabels ? "Add another label" : "Add a label"}
        </button>
      </div>
    </div>
  );
}

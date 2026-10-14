"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deletePageAction, emptyTrashAction, restorePageAction } from "@/server/actions/pages";
import { safeAction } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { stableTime } from "@/lib/time";



export type TrashRow = {
  id: string;
  title: string;
  icon: string | null;
  deletedAt: string | null;
};

function deletedLabel(value: string | null) {
  if (!value) return "Deleted";
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  const when =
    days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  // `stableTime` (fixed locale + UTC) so server and client render byte-identical
  // text: `toLocaleDateString()` diverged between Node (en-US) and the browser's
  // locale, failing hydration and detaching this list's action handlers.
  return `Deleted ${when} · ${stableTime(date, "date")}`;
}

/**
 * Trash list. Restoring is reversible and instant; deleting for good asks once
 * inline (no native `confirm()` dialog).
 */
export function TrashList({
  workspaceId,
  locale,
  pages,
}: {
  workspaceId: string;
  locale: string;
  pages: TrashRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);

  const run = (label: string, task: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const outcome = await safeAction(task);
      const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
      if (!value.ok) {
        toast.error(value.message ?? "Something went wrong");
        return;
      }
      toast.success(label);
      router.refresh();
    });

  if (pages.length === 0) {
    return (
      <div className="notion-empty rounded-lg border border-dashed border-border">
        <span className="notion-empty-icon">
          <Trash2 className="h-5 w-5" aria-hidden />
        </span>
        <p>Trash is empty.</p>
        <p className="text-xs">Deleted pages will show up here.</p>
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span>
          {pages.length} {pages.length === 1 ? "page" : "pages"}
        </span>
        {confirmingEmpty ? (
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run("Trash emptied", async () => {
                  const result = await emptyTrashAction(workspaceId);

                  if ("error" in result) return { ok: false, message: result.error };
                  setConfirmingEmpty(false);
                  return { ok: true };
                })
              }
              className="rounded bg-red-500/90 px-2 py-1 text-white hover:bg-red-500 disabled:opacity-50"
            >
              {t(locale, "deleteForever")}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingEmpty(false)}
              className="rounded px-2 py-1 hover:bg-surface-2"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirmingEmpty(true)}
            className="rounded px-2 py-1 hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            {t(locale, "emptyTrash")}
          </button>
        )}
      </div>

      <ul className="divide-y divide-border rounded-xl border border-border">
        {pages.map((page) => (
          <li key={page.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span aria-hidden className="text-lg">
              {page.icon ?? "📄"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{page.title || "Untitled"}</span>
              <span className="block text-[11px] text-muted" suppressHydrationWarning>{deletedLabel(page.deletedAt)}</span>
            </span>

            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run("Page restored", async () => {
                  const result = await restorePageAction(page.id);

                  return "error" in result ? { ok: false, message: result.error } : { ok: true };
                })
              }
              className="flex h-8 items-center gap-1.5 rounded border border-border px-2.5 text-sm hover:bg-surface-2 disabled:opacity-50"
            >
              <ArchiveRestore className="h-3.5 w-3.5" /> {t(locale, "restore")}
            </button>

            {confirming === page.id ? (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run("Deleted forever", async () => {
                      const result = await deletePageAction(page.id);

                      if ("error" in result) return { ok: false, message: result.error };
                      setConfirming(null);
                      return { ok: true };
                    })
                  }
                  className="h-8 rounded bg-red-500/90 px-2.5 text-sm text-white hover:bg-red-500 disabled:opacity-50"
                >
                  {t(locale, "deleteForever")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="h-8 rounded px-2 text-sm text-muted hover:bg-surface-2"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                aria-label={`Delete ${page.title || "Untitled"} forever`}
                disabled={pending}
                onClick={() => setConfirming(page.id)}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-red-500",
                  "disabled:opacity-50",
                )}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

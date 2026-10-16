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
import { truncateMiddle } from "@/lib/truncate";
import { offsetForIndex, totalHeight, visibleRange } from "@/lib/virtual-list";
import {
  buildTrashView,
  describeDeleteImpact,
  defaultTrashRetentionPolicy,
  emptyTrash,
  planPermanentDelete,
  planRestore,
  type TrashItem,
  type TrashRecord,
} from "@/lib/trash-view";

/*
 * The list model is `src/lib/trash-view.ts`: it owns the nested grouping of a
 * deleted descendant under its deleted ancestor, the retention badges
 * (`ageLabel` / `daysLeft` / `restorable`), the ancestor-complete restore plan
 * and the permanent-delete plan (cascade refusal + `describeDeleteImpact`).
 * This component is the thin action shell — it renders the view items and
 * forwards the plans to the existing `restorePageAction` / `deletePageAction` /
 * `emptyTrashAction` server actions. Keeping every rule in the pure module means
 * the boundary arithmetic and the tree walks stay testable without a DOM.
 *
 * The trash can grow without bound, so past VIRTUAL_THRESHOLD rows we only mount
 * the slice in view inside a fixed-height scroller (`virtual-list`'s fixed-height
 * path — every row is one `ROW_HEIGHT` line now that nesting replaces the old
 * deletion-day headers).
 */
/** Estimated row height (`py-3` + title + timestamp, controls on one line). */
const ROW_HEIGHT = 64;
/** Height of the windowed scroll viewport. */
const VIEWPORT_HEIGHT = 480;
/** Rows rendered beyond the viewport on each side to hide fast-scroll gaps. */
const OVERSCAN = 4;
/** Below this many rows the whole list renders at once. */
const VIRTUAL_THRESHOLD = 40;
/** Longest title kept before its middle is elided (code points, incl. `…`). */
const TITLE_MAX = 64;

export type TrashRow = {
  id: string;
  title: string;
  icon: string | null;
  deletedAt: string | null;
  /**
   * Original parent, when the query exposes it. `getTrash` does not select
   * `parentId` yet, so this is optional: without it every row is a root. Passing
   * it (with the parent selected in `getTrash`) activates the nested grouping.
   */
  parentId?: string | null;
  /** Acting user id, when the soft-delete engine recorded one. */
  deletedById?: string | null;
};

/**
 * The wire row → the record `buildTrashView` consumes. A missing or unparseable
 * `deletedAt` becomes `null`, which the view model filters out (a row without a
 * delete stamp is never in the trash), so a malformed payload can only drop a
 * row rather than invent a date.
 */
function toRecord(page: TrashRow): TrashRecord {
  const stamp = page.deletedAt ? new Date(page.deletedAt) : null;
  return {
    id: page.id,
    title: page.title,
    icon: page.icon,
    parentId: page.parentId ?? null,
    deletedAt: stamp && !Number.isNaN(stamp.getTime()) ? stamp : null,
    deletedById: page.deletedById ?? null,
  };
}

/**
 * The per-row retention suffix, or `""` when the view model reports no window
 * (`daysLeft === null` — a disabled policy). A whole day of slack is counted:
 * "in 1 day" through its last 24h, then "soon" once it is at or past the purge
 * boundary rather than a negative count.
 */
function retentionSuffix(daysLeft: number | null): string {
  if (daysLeft === null) return "";
  if (daysLeft > 0) return ` · Auto-deletes in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`;
  return " · Auto-deletes soon";
}

/**
 * Trash list. Restoring is reversible and instant; deleting for good asks once
 * inline (no native `confirm()` dialog) and names the sub-pages the cascade
 * takes with it. Descendants render indented under the deleted ancestor they
 * were grouped with.
 */
export function TrashList({
  workspaceId,
  locale,
  pages,
  canEdit,
}: {
  workspaceId: string;
  locale: string;
  pages: TrashRow[];
  /** Guests can browse the trash but every destructive control stays hidden. */
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  // Top of the windowed scroller; only read in windowed mode.
  const [scrollTop, setScrollTop] = useState(0);

  // Trash retention window. One source for the purge rule and this hint, so the
  // "auto-deletes in N days" copy cannot drift from what the policy enforces.
  const retentionDays = defaultTrashRetentionPolicy.retentionDays;
  // One clock read per render, so every row's hint agrees. The metadata line is
  // `suppressHydrationWarning`, so the server/client millisecond gap is safe.
  const now = Date.now();
  const nowDate = new Date(now);

  // The nested, newest-first rows plus the badge data — everything the module
  // derives. `emptyTrash` is the set the retention window has already closed on,
  // surfaced as the header hint (the server's "empty" action purges the trash).
  const view = buildTrashView(pages.map(toRecord), {
    now: nowDate,
    policy: { retentionDays },
  });
  const items = view.items;
  const purgeable = emptyTrash(items, { now: nowDate, retentionDays });

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

  /**
   * Restore a selection through the view model's ancestor-complete plan: every
   * deleted ancestor is put back first, so a child re-attaches under its parent
   * instead of being flung to the workspace root.
   */
  const restore = (id: string) =>
    run("Page restored", async () => {
      const plan = planRestore(items, [id]);
      if (plan.ops.length === 0) {
        return { ok: false, message: "This page is no longer in the trash." };
      }
      for (const op of plan.ops) {
        const result = await restorePageAction(op.id);
        if ("error" in result) return { ok: false, message: result.error };
      }
      return { ok: true };
    });

  /**
   * Permanently delete, children-first. `planPermanentDelete` refuses a
   * still-populated ancestor unless `cascade` is set; the inline confirmation
   * names the sub-pages (`describeDeleteImpact`) so the cascade is explicit, and
   * then the server purges the whole subtree from the selected root.
   */
  const deleteForever = (id: string) =>
    run("Deleted forever", async () => {
      const plan = planPermanentDelete(items, [id], { cascade: true });
      if (plan.ops.length === 0) {
        return { ok: false, message: "This page is no longer in the trash." };
      }
      const result = await deletePageAction(id, workspaceId);
      if ("error" in result) return { ok: false, message: result.error };
      setConfirming(null);
      return { ok: true };
    });

  // The pending permanent-delete's plan: `blocked` is the cascade refusal (the
  // selected page still owns trashed sub-pages), `deleteImpact` its confirmation
  // copy. Both come from the view model, so the dialog and the delete agree.
  const deletePlan = confirming === null ? null : planPermanentDelete(items, [confirming]);
  const cascadeNeeded = deletePlan !== null && deletePlan.blocked.length > 0;
  const deleteImpact = confirming === null ? "" : describeDeleteImpact(items, confirming);

  // Shared row body so the plain and windowed lists stay byte-identical in
  // what they render (only the positioning wrapper differs). Long titles keep
  // both ends (`truncateMiddle`): trashed pages often share a long prefix
  // ("Title (copy)") or end in a disambiguating timestamp.
  const rowBody = (item: TrashItem) => (
    <>
      <span aria-hidden className="text-lg">
        {item.icon ?? "📄"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          {truncateMiddle(item.title, TITLE_MAX)}
        </span>
        <span className="block text-[11px] text-muted" suppressHydrationWarning>
          Deleted {item.ageLabel} · {stableTime(item.deletedAt, "date")}
          {retentionSuffix(item.daysLeft)}
          {item.restorable ? "" : " · Expired"}
        </span>
      </span>

      {canEdit && (
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => restore(item.id)}
            className="flex h-8 items-center gap-1.5 rounded border border-border px-2.5 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            <ArchiveRestore className="h-3.5 w-3.5" /> {t(locale, "restore")}
          </button>

          {confirming === item.id ? (
            <span className="flex items-center gap-2">
              <span className="hidden text-[11px] text-muted sm:inline">{deleteImpact}</span>
              <button
                type="button"
                disabled={pending}
                aria-label={
                  cascadeNeeded
                    ? "Delete this page and its sub-pages forever"
                    : "Delete this page forever"
                }
                onClick={() => deleteForever(item.id)}
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
              aria-label={`Delete ${item.title} forever`}
              disabled={pending}
              onClick={() => setConfirming(item.id)}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-red-500",
                "disabled:opacity-50",
              )}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </>
      )}
    </>
  );

  if (items.length === 0) {
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

  // Long lists mount only the visible slice; short lists keep the plain <ul>.
  const windowed = items.length > VIRTUAL_THRESHOLD;
  const range = windowed
    ? visibleRange({
        scrollTop,
        viewportSize: VIEWPORT_HEIGHT,
        itemHeight: ROW_HEIGHT,
        itemCount: items.length,
        overscan: OVERSCAN,
      })
    : { start: 0, end: items.length };
  const visible = windowed ? items.slice(range.start, range.end) : items;

  return (
    <>
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span suppressHydrationWarning>
          {items.length} {items.length === 1 ? "page" : "pages"}
          {purgeable.length > 0 ? ` · ${purgeable.length} past retention` : ""}
        </span>
        {canEdit &&
        (confirmingEmpty ? (
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
        ))}
      </div>

      {windowed ? (
        <div
          role="region"
          aria-label="Trash pages"
          tabIndex={0}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className="overflow-y-auto rounded-xl border border-border"
          style={{ height: VIEWPORT_HEIGHT }}
        >
          <ul className="relative" style={{ height: totalHeight(items.length, ROW_HEIGHT) }}>
            {visible.map((item, offset) => {
              const index = range.start + offset;
              // Absolute items stacked at their true offset: the spacer <ul>
              // carries the full height so the scrollbar matches the list.
              return (
                <li
                  key={item.id}
                  className={cn(
                    "absolute inset-x-0 flex items-center gap-3 overflow-hidden border-b border-border px-4",
                    item.nested && "ps-8",
                  )}
                  style={{ top: offsetForIndex(index, ROW_HEIGHT), height: ROW_HEIGHT }}
                >
                  {rowBody(item)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {visible.map((item) => (
            <li
              key={item.id}
              className={cn("flex flex-wrap items-center gap-3 px-4 py-3", item.nested && "ps-8")}
            >
              {rowBody(item)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

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
import { bucketKey, bucketLabel } from "@/lib/date-bucket";
import { defaultTrashRetentionPolicy } from "@/lib/trash";
import { truncateMiddle } from "@/lib/truncate";
import { offsetForIndex, totalHeight, visibleRange } from "@/lib/virtual-list";

/*
 * Windowed mode geometry. The trash can grow without bound, so past
 * VIRTUAL_THRESHOLD rows we only mount the slice in view inside a fixed-height
 * scroller. Deletion-day headers are their own lines in that stream, so the
 * window is computed over the flattened `header | page` items with per-item
 * heights (`heightOf`) — the variable-height path of `virtual-list` that
 * `search-results.tsx` already uses — instead of a single uniform stride.
 */
/** Estimated row height (`py-3` + title + timestamp, controls on one line). */
const ROW_HEIGHT = 64;
/** Height of a deletion-day header line. */
const HEADER_HEIGHT = 32;
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
};

/**
 * One line of the trash list: a deletion-day header, or a trashed page.
 * Flattening to a single stream before windowing keeps the virtual geometry (and
 * its arithmetic) over one index space.
 */
type TrashItem =
  | { kind: "header"; key: string; label: string }
  | { kind: "page"; page: TrashRow };

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

/** Milliseconds in a day, matching the retention arithmetic in `lib/trash`. */
const MS_PER_DAY = 86_400_000;

/**
 * Whole days until a trashed page leaves its retention window, or `null` when
 * no window applies: no `deletedAt`, an unparseable one, or a non-positive
 * window (which disables expiry entirely, the `lib/trash` convention). Mirrors
 * `isExpired`'s strict boundary (`deletedAt < now - window`), so a page deleted
 * exactly `retentionDays` ago reads `0` and one already past the window is
 * negative — neither is reported as still having time left. Pure: `now` is
 * injected, never read here.
 */
function daysUntilPurge(
  deletedAt: string | null,
  retentionDays: number,
  now: number,
): number | null {
  if (!deletedAt || !(retentionDays > 0)) return null;
  const deleted = Date.parse(deletedAt);
  if (!Number.isFinite(deleted)) return null;
  return Math.ceil((deleted + retentionDays * MS_PER_DAY - now) / MS_PER_DAY);
}

/**
 * The per-row retention suffix, or `""` when a page has no window. Counts a
 * whole day of slack: "in 1 day" through its last 24h, then "soon" once it is
 * at or past its purge boundary rather than a negative count.
 */
function retentionSuffix(days: number | null): string {
  if (days === null) return "";
  if (days > 0) return ` · Auto-deletes in ${days} ${days === 1 ? "day" : "days"}`;
  return " · Auto-deletes soon";
}

/**
 * Day bucket of a trashed page via `date-bucket`'s UTC `day` unit, so a header
 * always names exactly the calendar day (UTC) the row falls in and never varies
 * with the machine timezone. A page with no usable `deletedAt` is keyed `""` and
 * labelled with a stable fallback rather than being dropped from the list.
 */
function deletedDay(page: TrashRow): { key: string; label: string } {
  const key = page.deletedAt ? bucketKey(page.deletedAt, "day") : "";
  if (!key) return { key: "", label: "Undated" };
  return { key, label: bucketLabel(key, "day") };
}

/**
 * Flatten pages into `header | page` items, one header per consecutive run of
 * the same deletion day. `getTrash` already orders by `deletedAt desc`, so a day's
 * pages are contiguous; run-based grouping therefore preserves the existing
 * order without re-sorting and never emits a duplicate header for a day.
 */
function groupByDay(pages: TrashRow[]): TrashItem[] {
  const items: TrashItem[] = [];
  let current: string | null = null;
  for (const page of pages) {
    const day = deletedDay(page);
    if (day.key !== current) {
      items.push({ kind: "header", key: day.key, label: day.label });
      current = day.key;
    }
    items.push({ kind: "page", page });
  }
  return items;
}

/**
 * Trash list. Restoring is reversible and instant; deleting for good asks once
 * inline (no native `confirm()` dialog). Rows are grouped under the (UTC) day
 * they were deleted.
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

  // Shared row body so the plain and windowed lists stay byte-identical in
  // what they render (only the positioning wrapper differs). Long titles keep
  // both ends (`truncateMiddle`): trashed pages often share a long prefix
  // ("Title (copy)") or end in a disambiguating timestamp.
  const rowBody = (page: TrashRow) => (
    <>
      <span aria-hidden className="text-lg">
        {page.icon ?? "📄"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          {truncateMiddle(page.title || "Untitled", TITLE_MAX)}
        </span>
        <span className="block text-[11px] text-muted" suppressHydrationWarning>{deletedLabel(page.deletedAt)}{retentionSuffix(daysUntilPurge(page.deletedAt, retentionDays, now))}</span>
      </span>

      {canEdit && (
        <>
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
                    const result = await deletePageAction(page.id, workspaceId);

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
        </>
      )}
    </>
  );

  // Shared header body so the plain and windowed lists stay byte-identical.
  const headerBody = (label: string) => (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
  );

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

  // Flattened `header | page` stream the window (and both layouts) render from.
  const items = groupByDay(pages);
  const heightOf = (index: number) =>
    items[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT;

  // Long lists mount only the visible slice; short lists keep the plain <ul>.
  const windowed = pages.length > VIRTUAL_THRESHOLD;
  const range = windowed
    ? visibleRange({
        scrollTop,
        viewportSize: VIEWPORT_HEIGHT,
        itemHeight: ROW_HEIGHT,
        itemCount: items.length,
        overscan: OVERSCAN,
        heightOf,
      })
    : { start: 0, end: items.length };
  const visible = windowed ? items.slice(range.start, range.end) : items;

  return (
    <>
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span>
          {pages.length} {pages.length === 1 ? "page" : "pages"}
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
          <ul className="relative" style={{ height: totalHeight(items.length, ROW_HEIGHT, heightOf) }}>
            {visible.map((item, offset) => {
              const index = range.start + offset;
              // Absolute items stacked at their true offset: the spacer <ul>
              // carries the full height so the scrollbar matches the list.
              const style = { top: offsetForIndex(index, ROW_HEIGHT, heightOf) };
              return item.kind === "header" ? (
                <li
                  key={`header:${item.key}`}
                  className="absolute inset-x-0 flex items-center border-b border-border bg-surface-2 px-4"
                  style={{ ...style, height: HEADER_HEIGHT }}
                >
                  {headerBody(item.label)}
                </li>
              ) : (
                <li
                  key={item.page.id}
                  className="absolute inset-x-0 flex items-center gap-3 overflow-hidden border-b border-border px-4"
                  style={{ ...style, height: ROW_HEIGHT }}
                >
                  {rowBody(item.page)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {visible.map((item) =>
            item.kind === "header" ? (
              <li key={`header:${item.key}`} className="bg-surface-2 px-4 py-2">
                {headerBody(item.label)}
              </li>
            ) : (
              <li key={item.page.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                {rowBody(item.page)}
              </li>
            ),
          )}
        </ul>
      )}
    </>
  );
}

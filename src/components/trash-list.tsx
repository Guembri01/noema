"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  archivePageAction,
  deletePageAction,
  emptyTrashAction,
  restorePageAction,
} from "@/server/actions/pages";
import { feedbackFor, safeAction, withUndo } from "@/lib/actions-client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { stableTime } from "@/lib/time";
import { truncateMiddle } from "@/lib/truncate";
import { useScrollRestore } from "@/lib/scroll-restore";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { VirtualList } from "@/components/ui/virtual-list";
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
 * This component is the thin action shell — it renders the view items through
 * the design-system primitives and forwards the plans to the existing
 * `restorePageAction` / `deletePageAction` / `emptyTrashAction` server actions.
 *
 * Keeping every rule in the pure module means the boundary arithmetic and the
 * tree walks stay testable without a DOM; this file only keeps the *presentation*
 * rules that are also pure (retention → badge tone, nested indent, delete-impact
 * copy) so they can be pinned by node tests too.
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
/** Placeholder rows shown while the list is loading (matches a screen of rows). */
const SKELETON_ROWS = 6;

/* -------------------------------------------------------------------------- */
/* Pure presentation mappings                                                 */
/* -------------------------------------------------------------------------- */

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
 * At or below this many days left the retention badge steps up from `neutral`
 * to `warning`; at or past the boundary it is `danger`. One knob, so the tone
 * and the copy can never disagree.
 */
export const RETENTION_WARN_DAYS = 3;

/** The retention countdown as a badge: tone steps warning → danger as it shrinks. */
export type RetentionBadgeInfo = {
  tone: BadgeTone;
  /** Short, self-contained label ("Auto-deletes in 3 days", "Expired"). */
  label: string;
};

/**
 * Map a row's retention window onto a badge.
 *
 * - purging disabled (`daysLeft === null`) → `neutral` / "Kept indefinitely"
 * - comfortably inside the window → `neutral`
 * - within {@link RETENTION_WARN_DAYS} → `warning`
 * - at/over the boundary, or already expired → `danger`
 *
 * Pure, so the node tests pin every boundary without a clock.
 */
export function retentionBadge(
  item: Pick<TrashItem, "daysLeft" | "restorable">,
): RetentionBadgeInfo {
  if (!item.restorable) return { tone: "danger", label: "Expired" };
  const { daysLeft } = item;
  if (daysLeft === null) return { tone: "neutral", label: "Kept indefinitely" };
  if (daysLeft <= 0) return { tone: "danger", label: "Auto-deletes soon" };
  const label =
    daysLeft === 1 ? "Auto-deletes in 1 day" : `Auto-deletes in ${daysLeft} days`;
  return {
    tone: daysLeft <= RETENTION_WARN_DAYS ? "warning" : "neutral",
    label,
  };
}

/** Left padding (logical, RTL-safe) that offsets a nested row under its ancestor. */
export const NESTED_INDENT_CLASS = "ps-8";

/**
 * The vertical indent guide drawn beside a nested row. Colour is the
 * `--border-strong` token (`bg-border-strong`) — never a raw grey.
 */
export const INDENT_GUIDE_CLASS =
  "pointer-events-none absolute inset-y-1 start-4 w-px bg-border-strong";

/** Indent for a nested row, or nothing for a root. Pure — pinned by the test. */
export function nestedIndentClass(nested: boolean): string {
  return nested ? NESTED_INDENT_CLASS : "";
}

/** The indent guide for a nested row, or nothing for a root. */
export function indentGuideClass(nested: boolean): string {
  return nested ? INDENT_GUIDE_CLASS : "";
}

/**
 * The muted "deleted-by / age" metadata line. The age always leads; the acting
 * user is appended only when the query exposed one.
 */
export function deletedMetaText(
  item: Pick<TrashItem, "ageLabel" | "deletedBy">,
): string {
  const ago = item.ageLabel.trim();
  const parts = [ago ? `Deleted ${ago}` : "Deleted"];
  if (item.deletedBy) parts.push(`by ${item.deletedBy}`);
  return parts.join(" · ");
}

/**
 * The confirmation copy for permanently deleting `item`: the cascade size from
 * the view model (`describeDeleteImpact`), so the dialog and the delete agree.
 * An unknown id returns `""` — the caller skips the sentence rather than lying.
 */
export function deleteImpactCopy(
  items: ReadonlyArray<TrashItem>,
  item: Pick<TrashItem, "id">,
): string {
  return describeDeleteImpact(items, item.id);
}

/* -------------------------------------------------------------------------- */
/* Loading / empty states                                                     */
/* -------------------------------------------------------------------------- */

/** Placeholder rows sized to `ROW_HEIGHT`, so nothing shifts when data lands. */
function TrashSkeleton() {
  return (
    <div
      data-testid="trash-loading"
      aria-busy="true"
      aria-live="polite"
      className="overflow-hidden rounded-xl border border-border"
    >
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <Skeleton
          key={index}
          variant="row"
          className="h-16 rounded-none border-b border-border last:border-b-0"
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

/** Busy key for the bulk "empty trash" action (no single row owns it). */
const EMPTY_BUSY = "__empty__";

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
 * Trash list. Restoring is reversible and instant (it also carries an Undo that
 * re-archives the restored chain); deleting for good and emptying the trash are
 * destructive and go through a danger `ConfirmDialog` that names the sub-pages
 * the cascade takes with it. Descendants render indented under the deleted
 * ancestor they were grouped with, behind a `--border-strong` guide.
 */
export function TrashList({
  workspaceId,
  locale,
  pages,
  canEdit,
  loading = false,
}: {
  workspaceId: string;
  locale: string;
  pages: TrashRow[];
  /** Guests can browse the trash but every destructive control stays hidden. */
  canEdit: boolean;
  /** Render placeholder rows while the route data is still resolving. */
  loading?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  // Top of the windowed scroller; only read in windowed mode. Restored per
  // workspace when the user comes back to the trash, saved on every scroll.
  const [scrollTop, setScrollTop] = useState(0);
  const restoreScroll = useScrollRestore(`trash:${workspaceId}`, {
    onRestore: setScrollTop,
  });

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

  /**
   * Run a server action behind the shared feedback layer: one error toast for a
   * transport failure *or* a rejected action, one success toast on the way out,
   * and — when the caller passes `undo` — a six-second `withUndo` action on that
   * success toast. `router.refresh()` keeps the server-rendered list in step.
   */
  const run = (
    busyKey: string,
    label: string,
    task: () => Promise<{ ok: boolean; message?: string }>,
    options?: { undoLabel: string; undo: () => Promise<unknown> },
  ) =>
    startTransition(async () => {
      setBusyId(busyKey);
      try {
        const outcome = await safeAction(task, { locale });
        const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
        if (!value.ok) {
          toast.error(
            feedbackFor({ status: "error", message: value.message }, locale).message,
          );
          return;
        }
        const feedback = feedbackFor(
          { status: "success", message: label, undoable: Boolean(options) },
          locale,
        );
        if (options) {
          toast.success(
            feedback.message,
            withUndo({
              label: options.undoLabel,
              undo: options.undo,
              locale,
              successMessage: `${options.undoLabel} undone`,
            }),
          );
        } else {
          toast.success(feedback.message);
        }
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });

  /**
   * Restore a selection through the view model's ancestor-complete plan: every
   * deleted ancestor is put back first, so a child re-attaches under its parent
   * instead of being flung to the workspace root.
   *
   * Restoring is non-destructive and its reversal genuinely exists — re-archiving
   * a restored page returns it to the trash — so the success toast offers an Undo
   * (`withUndo`) that runs the plan in reverse. Permanent delete offers none.
   */
  const restore = (id: string) => {
    const plan = planRestore(items, [id]);
    const restoredIds = plan.ops.map((op) => op.id);
    run(
      id,
      "Page restored",
      async () => {
        if (plan.ops.length === 0) {
          return { ok: false, message: "This page is no longer in the trash." };
        }
        for (const op of plan.ops) {
          const result = await restorePageAction(op.id);
          if ("error" in result) return { ok: false, message: result.error };
        }
        return { ok: true };
      },
      {
        undoLabel: t(locale, "restore"),
        undo: async () => {
          // Children-first, mirroring the delete ordering.
          for (const pageId of [...restoredIds].reverse()) {
            const result = await archivePageAction(pageId);
            if ("error" in result) return result;
          }
          return { ok: true };
        },
      },
    );
  };

  /**
   * Permanently delete, children-first. `planPermanentDelete` refuses a
   * still-populated ancestor unless `cascade` is set; the dialog names the
   * sub-pages (`describeDeleteImpact`) so the cascade is explicit, and then the
   * server purges the whole subtree from the selected root. No Undo: this is the
   * irreversible half.
   */
  const deleteForever = (id: string) =>
    run(id, "Deleted forever", async () => {
      const plan = planPermanentDelete(items, [id], { cascade: true });
      if (plan.ops.length === 0) {
        return { ok: false, message: "This page is no longer in the trash." };
      }
      const result = await deletePageAction(id, workspaceId);
      if ("error" in result) return { ok: false, message: result.error };
      setConfirming(null);
      return { ok: true };
    });

  /** Empty the whole trash in one server call. Irreversible — no Undo. */
  const emptyAll = () =>
    run(
      EMPTY_BUSY,
      "Trash emptied",
      async () => {
        const result = await emptyTrashAction(workspaceId);
        if ("error" in result) return { ok: false, message: result.error };
        setConfirmingEmpty(false);
        return { ok: true };
      },
    );

  // The item whose permanent-delete dialog is open, and the impact copy that
  // names the sub-pages the cascade takes with it. Both come from the view model,
  // so the dialog and the delete agree.
  const confirmItem = confirming === null ? null : (items.find((i) => i.id === confirming) ?? null);
  const emptyCount = items.length;

  if (loading) {
    return (
      <div className="mb-3">
        <TrashSkeleton />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="animate-fade rounded-lg border border-dashed border-border">
        <EmptyState
          variant="full"
          icon={<Trash2 className="h-5 w-5" aria-hidden />}
          title="Nothing in the trash"
          description="Deleted pages will show up here, with their content, until you restore them."
          primaryAction={
            <Button asChild variant="secondary" size="sm">
              <Link href="/app">Go to workspace</Link>
            </Button>
          }
        />
      </div>
    );
  }

  // Long lists mount only the visible slice; short lists keep the plain <ul>.
  const windowed = items.length > VIRTUAL_THRESHOLD;

  /**
   * The shared row body — the plain and windowed lists render byte-identical
   * content, only the positioning wrapper differs. Long titles keep both ends
   * (`truncateMiddle`): trashed pages often share a long prefix ("Title (copy)")
   * or end in a disambiguating timestamp.
   */
  const rowBody = (item: TrashItem) => {
    const retention = retentionBadge(item);
    return (
      <>
        {item.nested ? (
          <span aria-hidden data-indent-guide className={indentGuideClass(true)} />
        ) : null}

        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center text-lg leading-none"
        >
          {item.icon ?? "📄"}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm" title={item.title}>
            {truncateMiddle(item.title, TITLE_MAX)}
          </span>
          <span
            className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted"
            suppressHydrationWarning
          >
            <span data-testid="deleted-meta">{deletedMetaText(item)}</span>
            <span aria-hidden>·</span>
            <time dateTime={item.deletedAt.toISOString()}>
              {stableTime(item.deletedAt, "date")}
            </time>
          </span>
        </span>

        <Badge tone={retention.tone} size="sm" title={retention.label}>
          <span data-testid="retention-label">{retention.label}</span>
        </Badge>

        {canEdit ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              loading={busyId === item.id && pending}
              leftIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
              onClick={() => restore(item.id)}
            >
              {t(locale, "restore")}
            </Button>
            <Button
              variant="danger"
              tone="soft"
              size="iconOnly"
              aria-label={`Delete ${item.title} forever`}
              disabled={pending}
              onClick={() => setConfirming(item.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </span>
        ) : null}
      </>
    );
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted">
        <span suppressHydrationWarning>
          {items.length} {items.length === 1 ? "page" : "pages"}
          {purgeable.length > 0 ? ` · ${purgeable.length} past retention` : ""}
        </span>
        {canEdit && !confirmingEmpty ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            loading={busyId === EMPTY_BUSY && pending}
            onClick={() => setConfirmingEmpty(true)}
          >
            {t(locale, "emptyTrash")}
          </Button>
        ) : null}
      </div>

      {windowed ? (
        <VirtualList
          items={items}
          scrollTop={scrollTop}
          onScrollTopChange={(top) => {
            setScrollTop(top);
            restoreScroll.save(top);
          }}
          viewportHeight={VIEWPORT_HEIGHT}
          itemHeight={ROW_HEIGHT}
          overscan={OVERSCAN}
          getKey={(item) => item.id}
          renderItem={(item) => rowBody(item)}
          scrollerRef={restoreScroll.ref}
          scrollerProps={{
            role: "region",
            "aria-label": t(locale, "trash"),
            "aria-busy": pending || undefined,
            tabIndex: 0,
          }}
          className="overflow-y-auto rounded-xl border border-border"
          // Absolute items stacked at their true offset: the spacer <ul> carries
          // the full height so the scrollbar matches the list.
          rowClassName={(item) =>
            cn(
              "relative flex items-center gap-3 overflow-hidden px-4 u-colors hover:bg-surface-2",
              "absolute inset-x-0",
              nestedIndentClass(item.nested),
            )
          }
          rowAttributes={() => ({ "data-trash-row": "" })}
          rowStyle={{ height: ROW_HEIGHT }}
        />
      ) : (
        <ul
          aria-busy={pending || undefined}
          className="divide-y divide-border overflow-hidden rounded-xl border border-border"
        >
          {items.map((item) => (
            <li
              key={item.id}
              data-trash-row=""
              className={cn(
                "relative flex flex-wrap items-center gap-3 px-4 py-3 u-colors hover:bg-surface-2 animate-rise",
                nestedIndentClass(item.nested),
              )}
            >
              {rowBody(item)}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <>
          <ConfirmDialog
            open={confirmingEmpty}
            onOpenChange={setConfirmingEmpty}
            tone="danger"
            className="animate-scale-in"
            title="Empty the trash?"
            description={`This permanently deletes ${emptyCount} ${
              emptyCount === 1 ? "page" : "pages"
            }. It cannot be undone.`}
            confirmLabel={t(locale, "deleteForever")}
            cancelLabel="Cancel"
            pending={pending}
            onConfirm={emptyAll}
          />
          <ConfirmDialog
            open={confirmItem !== null}
            onOpenChange={(open) => {
              if (!open) setConfirming(null);
            }}
            tone="danger"
            className="animate-scale-in"
            title={confirmItem ? `${t(locale, "deleteForever")} “${confirmItem.title}”?` : t(locale, "deleteForever")}
            description={confirmItem ? deleteImpactCopy(items, confirmItem) : ""}
            confirmLabel={t(locale, "deleteForever")}
            cancelLabel="Cancel"
            pending={pending}
            onConfirm={() => {
              if (confirmItem) deleteForever(confirmItem.id);
            }}
          />
        </>
      ) : null}
    </>
  );
}

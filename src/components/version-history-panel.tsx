"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { History, RotateCcw, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { restorePageVersionAction } from "@/server/actions/page-versions";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { cn, initials, avatarColor } from "@/lib/utils";
import { diffStats, diffText, type DiffSegment } from "@/lib/text-diff";
import { MAX_VERSION_LABEL_LENGTH, normalizeVersionLabel } from "@/lib/version-history";
import { applyDirAttr } from "@/lib/bidi";
import {
  focusableSelector,
  resolveReturnTarget,
  type Focusable,
} from "@/lib/focus-trap";
import { planVersionHistoryTab, type VersionRow } from "@/components/version-history";

export type VersionHistoryCurrent = {
  title: string;
  updatedAt: string;
  content?: string | null;
};

export type VersionHistoryPanelProps = {
  pageId: string;
  versions: VersionRow[];
  current: VersionHistoryCurrent;
  locale: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
};

function relative(value: string, locale: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return t(locale, "justNow");
  if (minutes < 60) return t(locale, "minAgo").replace("{n}", String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t(locale, "hoursAgo").replace("{n}", String(hours));
  const days = Math.round(hours / 24);
  if (days < 7) return t(locale, "daysAgo").replace("{n}", String(days));
  return new Date(value).toLocaleDateString();
}

/**
 * Resolved display label for a snapshot: trimmed via the shared R30.10 helper,
 * with an over-cap stored label degraded to a trimmed preview instead of
 * throwing mid-render. `null` means an ordinary, unnamed auto snapshot, whose
 * row shows only the relative timestamp.
 */
function displayLabel(label: string | null | undefined): string | null {
  try {
    return normalizeVersionLabel(label);
  } catch {
    const raw = label?.trim() ?? "";
    return raw.length > 0 ? raw.slice(0, MAX_VERSION_LABEL_LENGTH) : null;
  }
}

/**
 * Above this combined length the inline diff is skipped: Myers' greedy pass is
 * quadratic in the worst case, and a version *preview* stays well under it. The
 * fallback still renders the target text verbatim (just without the spans).
 */
const MAX_INLINE_DIFF_LENGTH = 2000;

const INLINE_DIFF_CLASS: Record<DiffSegment["op"], string> = {
  equal: "",
  insert: "rounded bg-success-soft text-success",
  delete: "rounded bg-danger-soft text-danger",
};

/** The panel's real tabbable elements, tagged with their index as the id. */
function historyStops(root: HTMLElement): {
  stops: Focusable[];
  nodes: HTMLElement[];
} {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
  const stops = nodes.map((element, index) => ({
    id: String(index),
    disabled:
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true",
    hidden: element.hidden || element.getAttribute("aria-hidden") === "true",
    tabIndex: element.tabIndex,
  }));
  return { stops, nodes };
}

/**
 * Which baseline the inline diff is read against: the live page (`current`,
 * the pre-existing behaviour) or the next-older snapshot in the list
 * (`previous`). `versions` arrives newest-first (see `getPageDetail`), so a
 * row's predecessor is simply the next array entry.
 */
type DiffComparison = "current" | "previous";

/**
 * Toggle labels. Durable translations live in `src/lib/i18n.ts`, which is
 * out of scope for this slice (single-file change), so the two modes use
 * literal English here and the i18n keys are a reported follow-up.
 */
const DIFF_MODE_LABEL: Record<DiffComparison, string> = {
  current: "vs current",
  previous: "vs previous snapshot",
};

/**
 * Inline character-level diff of the selected snapshot against the live page
 * (F7 `diffText`): `equal` runs render plainly, while `insert`/`delete` use the
 * semantic `<ins>`/`<del>` elements so a change is conveyed by more than colour
 * alone. The `diffStats` tally rides along as +added / -removed badges.
 */
function InlineDiff({ before, after }: { before: string; after: string }) {
  const diff = useMemo(
    () => (before.length + after.length > MAX_INLINE_DIFF_LENGTH ? null : diffText(before, after)),
    [before, after],
  );
  // Per-block direction from the shared bidi engine: a Latin snapshot that
  // quotes Arabic (or vice versa) is laid out with its own `dir`/`dir-*`.
  const direction = applyDirAttr(after);

  if (diff === null) {
    return (
      <p
        dir={direction.dir}
        className={cn("whitespace-pre-wrap break-words text-sm", direction.className)}
      >
        {after}
      </p>
    );
  }

  const stats = diffStats(diff);

  return (
    <div className="space-y-1">
      <p
        dir={direction.dir}
        className={cn(
          "whitespace-pre-wrap break-words text-sm leading-relaxed",
          direction.className,
        )}
      >
        {diff.map((segment, index) =>
          segment.op === "insert" ? (
            <ins key={index} data-op="insert" className={INLINE_DIFF_CLASS.insert}>
              {segment.text}
            </ins>
          ) : segment.op === "delete" ? (
            <del key={index} data-op="delete" className={INLINE_DIFF_CLASS.delete}>
              {segment.text}
            </del>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>
      <p className="flex items-center gap-2 text-2xs text-muted">
        <span className="rounded bg-success-soft px-1.5 py-0.5 text-success">
          +{stats.added}
        </span>
        <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger">
          -{stats.removed}
        </span>
      </p>
    </div>
  );
}

/**
 * Version history as a slide-over panel: the page body stays readable instead
 * of ending with a long list, and each entry says who changed what.
 */
export function VersionHistoryPanel({
  versions,
  current,
  locale,
  onClose,
  returnFocusRef,
}: VersionHistoryPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /** Version id whose inline diff is expanded, or null when none is open. */
  const [selected, setSelected] = useState<string | null>(null);
  /** Diff baseline for the expanded row; `current` preserves old behaviour. */
  const [comparison, setComparison] = useState<DiffComparison>("current");
  /**
   * Version id whose diff-panel restore is awaiting a confirmation click, or
   * null. Keyed by the row so collapsing or switching rows drops the prompt.
   */
  const [confirmingRestore, setConfirmingRestore] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => {
      const invoker = returnFocusRef.current;
      const target = resolveReturnTarget({
        invoker: invoker
          ? { id: "history-invoker", connected: invoker.isConnected }
          : null,
      });
      if (target) invoker?.focus();
    };
  }, [returnFocusRef]);

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const { stops, nodes } = historyStops(event.currentTarget);
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? nodes.indexOf(active) : -1;
    const plan = planVersionHistoryTab(stops, {
      activeId: activeIndex >= 0 ? String(activeIndex) : null,
      shift: event.shiftKey,
    });
    if (!plan) return;
    const target = nodes[Number(plan.target.id)];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  /**
   * Single restore path shared by the per-row control and the diff-panel
   * affordance (same `restorePageVersionAction`, same toast/refresh): the row
   * button stays one-click, the affordance asks first. Closing the panel on
   * success shows the refreshed page content.
   */
  const restoreVersion = (versionId: string) =>
    startTransition(async () => {
      const outcome = await safeAction(
        () => restorePageVersionAction(versionId),
        { locale },
      );
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("error" in value) {
        toast.error(value.error);
        return;
      }
      toast.success(t(locale, "restoredVersion"));
      setConfirmingRestore(null);
      onClose();
      router.refresh();
    });

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label={t(locale, "closeVersionHistory")}
        onClick={onClose}
        className="focus-ring absolute inset-0 bg-black/30"
      />
      <aside
        ref={dialogRef}
        data-testid="version-history-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t(locale, "history")}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="relative z-10 flex h-full w-full max-w-sm flex-col border-l border-border bg-bg shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <History className="h-4 w-4 text-muted" />
          <h2 className="flex-1 text-sm font-medium">{t(locale, "history")}</h2>
          <button
            type="button"
            aria-label={t(locale, "close")}
            onClick={onClose}
            className="focus-ring u-interactive flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-3">
          <ul className="space-y-2">
            {/* Live page state (R30.6): a distinct, non-restorable header
                row - snapshots below always store the state BEFORE a save,
                so the newest one is not "current" and must stay restorable
                ("undo the last edit from history"). */}
            <li
              data-testid="version-current-row"
              className="rounded-lg border border-dashed border-border bg-surface p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {current.title || t(locale, "untitled")}
                </p>
                <p className="text-2xs text-muted" suppressHydrationWarning>
                  {relative(current.updatedAt, locale)}
                  {t(locale, "currentSuffix")}
                </p>
              </div>
            </li>
            {versions.length === 0 && (
              <li className="p-2 text-sm text-muted">{t(locale, "noVersionsYet")}</li>
            )}
            {versions.map((version, index) => {
              // Newest-first list: the next entry is the previous (older)
              // snapshot. The oldest row has none, so "vs previous" is
              // disabled there and the view falls back to "vs current".
              const hasPrevious = index + 1 < versions.length;
              // Named versions (R30.10): a stored label reads as a badge
              // beside the timestamp, which stays as the unnamed fallback.
              const label = displayLabel(version.label);
              const effectiveComparison: DiffComparison =
                comparison === "previous" && hasPrevious ? "previous" : "current";
              // Non-null only while comparing against a predecessor, so the
              // baseline is the older snapshot and the target is this one.
              const previousSnapshot =
                effectiveComparison === "previous" ? versions[index + 1] : null;
              // The stored snapshot the open diff is based on: the selected
              // row in "vs current" mode, or the predecessor it is read
              // against in "vs previous" mode. The restore affordance acts
              // on this one, so "this version" always matches what the diff
              // shows while still respecting the chosen comparison mode.
              const restoreTarget = previousSnapshot ?? version;
              const before = previousSnapshot
                ? previousSnapshot.content ?? previousSnapshot.title
                : version.content ?? version.title;
              const after = previousSnapshot
                ? version.content ?? version.title
                : current.content ?? current.title;
              return (
                <li key={version.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="grid h-6 w-6 place-items-center rounded-full text-3xs font-medium text-white"
                      style={{
                        backgroundColor: avatarColor(version.author?.email ?? "unknown"),
                      }}
                      aria-hidden
                    >
                      {initials(version.author?.name ?? "?")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {version.author?.name ?? t(locale, "unknown")}
                      </p>
                      <p
                        className="flex flex-wrap items-center gap-1 text-2xs text-muted"
                        suppressHydrationWarning
                      >
                        {label !== null && (
                          <span
                            data-testid="version-label"
                            className="inline-flex items-center gap-0.5 rounded bg-warning-soft px-1.5 py-0.5 text-warning"
                          >
                            <Tag className="h-2.5 w-2.5" aria-hidden />
                            {label}
                          </span>
                        )}
                        {/* Timestamp is always kept; it is the fallback when
                            the snapshot is unnamed. */}
                        {relative(version.createdAt, locale)}
                      </p>
                    </div>
                    {typeof version.charDelta === "number" && version.charDelta !== 0 && (
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-3xs",
                          version.charDelta > 0
                            ? "bg-success-soft text-success"
                            : "bg-danger-soft text-danger",
                        )}
                      >
                        {version.charDelta > 0 ? "+" : ""}
                        {version.charDelta}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm">
                    {version.summary ?? t(locale, "editedContent")}
                  </p>
                  <p className="mt-0.5 truncate text-2xs text-muted">
                    {t(locale, "titledPrefix")}
                    {version.title || t(locale, "untitled")}
                    {t(locale, "titledSuffix")}
                  </p>
                  {/* Every snapshot row is restorable - including the newest,
                      which stores the pre-latest-edit state (R30.6). */}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => restoreVersion(version.id)}
                    className="focus-ring u-interactive mt-2 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50"
                  >
                    <RotateCcw className="h-3 w-3" /> {t(locale, "restore")}
                  </button>
                  {/* Inline character-level diff (F7 text-diff) of this
                      snapshot against the live page or the previous
                      snapshot - additive to the existing row controls,
                      collapses when re-toggled. */}
                  <button
                    type="button"
                    aria-expanded={selected === version.id}
                    onClick={() => {
                      setConfirmingRestore(null);
                      setSelected((previous) => (previous === version.id ? null : version.id));
                    }}
                    className="focus-ring u-interactive mt-2 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                  >
                    {t(locale, "suggestionReplaced")}
                  </button>
                  {selected === version.id && (
                    <div
                      data-testid="version-inline-diff"
                      className="mt-3 rounded border border-border bg-surface-2 p-2"
                    >
                      <div
                        role="group"
                        aria-label={t(locale, "compareVersionWith")}
                        className="mb-2 flex items-center gap-0.5"
                      >
                        <button
                          type="button"
                          aria-pressed={effectiveComparison === "current"}
                          onClick={() => {
                            setComparison("current");
                            setConfirmingRestore(null);
                          }}
                          className={cn(
                            "focus-ring u-interactive rounded px-2 py-0.5 text-2xs",
                            effectiveComparison === "current"
                              ? "bg-surface text-fg"
                              : "text-muted hover:bg-surface",
                          )}
                        >
                          {DIFF_MODE_LABEL.current}
                        </button>
                        <button
                          type="button"
                          aria-pressed={effectiveComparison === "previous"}
                          disabled={!hasPrevious}
                          onClick={() => {
                            setComparison("previous");
                            setConfirmingRestore(null);
                          }}
                          className={cn(
                            "focus-ring u-interactive rounded px-2 py-0.5 text-2xs",
                            effectiveComparison === "previous"
                              ? "bg-surface text-fg"
                              : "text-muted hover:bg-surface",
                            !hasPrevious && "cursor-not-allowed opacity-40",
                          )}
                        >
                          {DIFF_MODE_LABEL.previous}
                        </button>
                      </div>
                      <InlineDiff before={before} after={after} />
                      {/* Restore affordance scoped to the open comparison:
                          it reuses the row's restore action on
                          `restoreTarget` and asks for confirmation first.
                          Labels are literal English pending i18n keys. */}
                      <div className="mt-3 border-t border-border pt-2">
                        {confirmingRestore === version.id ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-2xs text-muted">
                              {effectiveComparison === "previous"
                                ? "Restore the previous snapshot and replace the current page?"
                                : "Restore this version and replace the current page?"}
                            </span>
                            <button
                              type="button"
                              data-testid="version-restore-confirm"
                              disabled={pending}
                              onClick={() => restoreVersion(restoreTarget.id)}
                              className="focus-ring u-interactive rounded bg-danger/90 px-2 py-0.5 text-2xs text-white hover:bg-danger disabled:opacity-50"
                            >
                              {t(locale, "restore")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingRestore(null)}
                              className="focus-ring u-interactive rounded px-2 py-0.5 text-2xs text-muted hover:bg-surface"
                            >
                              {t(locale, "close")}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            data-testid="version-restore-affordance"
                            data-comparison={effectiveComparison}
                            disabled={pending}
                            onClick={() => setConfirmingRestore(version.id)}
                            className="focus-ring u-interactive inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50"
                          >
                            <RotateCcw className="h-3 w-3" /> Restore this version
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}

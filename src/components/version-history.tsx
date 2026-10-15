"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { History, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { restorePageVersionAction } from "@/server/actions/page-versions";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { cn, initials, avatarColor } from "@/lib/utils";
import { diffStats, diffText, type DiffSegment } from "@/lib/text-diff";

export type VersionRow = {
  id: string;
  title: string;
  /**
   * Snapshot body as plain text, when the caller has it (F7 `text-diff` reads
   * raw strings). Optional and additive: rows without it fall back to `title`
   * for the inline character diff, so existing callers keep type-checking.
   */
  content?: string | null;
  summary: string | null;
  charDelta: number | null;
  createdAt: string;
  author: { id: string; name: string; email: string } | null;
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
 * Above this combined length the inline diff is skipped: Myers' greedy pass is
 * quadratic in the worst case, and a version *preview* stays well under it. The
 * fallback still renders the target text verbatim (just without the spans).
 */
const MAX_INLINE_DIFF_LENGTH = 2000;

const INLINE_DIFF_CLASS: Record<DiffSegment["op"], string> = {
  equal: "",
  insert: "rounded bg-emerald-500/15 text-emerald-700",
  delete: "rounded bg-red-500/15 text-red-600",
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

  if (diff === null) {
    return <p className="whitespace-pre-wrap break-words text-sm">{after}</p>;
  }

  const stats = diffStats(diff);

  return (
    <div className="space-y-1">
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
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
      <p className="flex items-center gap-2 text-[11px] text-muted">
        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">
          +{stats.added}
        </span>
        <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-500">
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
export function VersionHistory({
  pageId,
  versions,
  current,
  locale,
}: {
  pageId: string;
  versions: VersionRow[];
  /** The live page state (R30.6) - rendered as a distinct, non-restorable header row. */
  current: { title: string; updatedAt: string; content?: string | null };
  locale: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  /** Version id whose inline diff is expanded, or null when none is open. */
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <History className="h-4 w-4" />
        {t(locale, "history")}
        {versions.length > 0 && (
          <span className="rounded bg-surface-2 px-1 text-[10px]">{versions.length}</span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            aria-label={t(locale, "closeVersionHistory")}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/30"
          />
          <aside
            role="dialog"
            aria-label={t(locale, "history")}
            className="relative z-10 flex h-full w-full max-w-sm flex-col border-l border-border bg-bg shadow-2xl"
          >
            <header className="flex items-center gap-2 border-b border-border px-4 py-3">
              <History className="h-4 w-4 text-muted" />
              <h2 className="flex-1 text-sm font-medium">{t(locale, "history")}</h2>
              <button
                type="button"
                aria-label={t(locale, "close")}
                onClick={() => setOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
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
                    <p className="text-[11px] text-muted" suppressHydrationWarning>
                      {relative(current.updatedAt, locale)}
                      {t(locale, "currentSuffix")}
                    </p>
                  </div>
                </li>
                {versions.length === 0 && (
                  <li className="p-2 text-sm text-muted">{t(locale, "noVersionsYet")}</li>
                )}
                {versions.map((version) => (
                  <li key={version.id} className="rounded-lg border border-border p-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-medium text-white"
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
                          <p className="text-[11px] text-muted" suppressHydrationWarning>
                            {relative(version.createdAt, locale)}
                          </p>
                        </div>
                        {typeof version.charDelta === "number" && version.charDelta !== 0 && (
                          <span
                            className={cn(
                              "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                              version.charDelta > 0
                                ? "bg-emerald-500/10 text-emerald-600"
                                : "bg-red-500/10 text-red-500",
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
                      <p className="mt-0.5 truncate text-[11px] text-muted">
                        {t(locale, "titledPrefix")}
                        {version.title || t(locale, "untitled")}
                        {t(locale, "titledSuffix")}
                      </p>
                      {/* Every snapshot row is restorable - including the newest,
                          which stores the pre-latest-edit state (R30.6). */}
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const outcome = await safeAction(
                              () => restorePageVersionAction(version.id),
                              { locale },
                            );
                            const value = outcome.ok ? outcome.value : { error: outcome.error };
                            if ("error" in value) {
                              toast.error(value.error);
                              return;
                            }
                            toast.success(t(locale, "restoredVersion"));
                            setOpen(false);
                            router.refresh();
                          })
                        }
                        className="mt-2 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" /> {t(locale, "restore")}
                      </button>
                      {/* Inline character-level diff (F7 text-diff) of this
                          snapshot against the live page - additive to the
                          existing row controls, collapses when re-toggled. */}
                      <button
                        type="button"
                        aria-expanded={selected === version.id}
                        onClick={() =>
                          setSelected((previous) => (previous === version.id ? null : version.id))
                        }
                        className="mt-2 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        {t(locale, "suggestionReplaced")}
                      </button>
                      {selected === version.id && (
                        <div
                          data-testid="version-inline-diff"
                          className="mt-3 rounded border border-border bg-surface-2 p-2"
                        >
                          <InlineDiff
                            before={version.content ?? version.title}
                            after={current.content ?? current.title}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, History, RotateCcw, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { restorePageVersionAction } from "@/server/actions/page-versions";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { cn, initials, avatarColor } from "@/lib/utils";
import { diffStats, diffText, type DiffSegment } from "@/lib/text-diff";
import { MAX_VERSION_LABEL_LENGTH, normalizeVersionLabel } from "@/lib/version-history";

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
  /**
   * Optional human-readable name for this snapshot (R30.10-lite named
   * versions). Additive: when the host has no label column yet it simply omits
   * this, and the list falls back to the relative timestamp. Blank/whitespace
   * labels are treated as unnamed.
   */
  label?: string | null;
};

/**
 * Result shape of an optional label-persistence action. Mirrors the
 * `{ ok: true } | { error }` contract the restore action already uses, so a
 * host can hand `VersionHistory` a real server action once a label column
 * exists without the component coupling to it.
 */
export type VersionLabelResult = { ok: true } | { error: string };

/**
 * Optional new action hook (named versions, 🧭): persist `label` (or clear it
 * with `null`) for a snapshot. `VersionHistory` calls it when provided and
 * otherwise keeps labels client-side only, so this stays additive and the
 * restore/diff behaviour is untouched.
 */
export type VersionLabelAction = (
  versionId: string,
  label: string | null,
) => Promise<VersionLabelResult>;

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
  onNameVersion,
}: {
  pageId: string;
  versions: VersionRow[];
  /** The live page state (R30.6) - rendered as a distinct, non-restorable header row. */
  current: { title: string; updatedAt: string; content?: string | null };
  locale: string;
  /**
   * Optional label-persistence action (named versions). When omitted, names
   * are kept client-side (session + `localStorage` scoped to `pageId`) so the
   * feature works before the `PageVersion.label` schema follow-up lands.
   */
  onNameVersion?: VersionLabelAction;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  /** Version id whose inline diff is expanded, or null when none is open. */
  const [selected, setSelected] = useState<string | null>(null);
  /** Diff baseline for the expanded row; `current` preserves old behaviour. */
  const [comparison, setComparison] = useState<DiffComparison>("current");
  /**
   * Client-side labels for snapshots the host could not label server-side,
   * merged over `version.label`. Persisted per page so names survive a refresh
   * without needing the read-only schema/action layer.
   */
  const [labelOverrides, setLabelOverrides] = useState<Record<string, string>>({});
  /** Version id whose inline name editor is open, or null. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const labelStorageKey = `version-history-labels:${pageId}`;

  // Label overrides live in `localStorage` because persisting a label needs the
  // reported `PageVersion.label` follow-up. Loaded in an effect (never during
  // render) so SSR output stays stable and hydration cannot mismatch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(labelStorageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const next: Record<string, string> = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim().length > 0) next[id] = value;
      }
      setLabelOverrides(next);
    } catch {
      // Unreadable/absent storage is non-fatal: labels stay session-only.
    }
  }, [labelStorageKey]);

  /** Resolved label for a row: client override, then host label, else null. */
  const labelOf = (version: VersionRow): string | null => {
    const override = labelOverrides[version.id];
    if (override !== undefined) return override;
    try {
      return normalizeVersionLabel(version.label);
    } catch {
      // A host-supplied label over the R30.10 cap degrades to a trimmed preview
      // rather than throwing during render.
      const raw = version.label?.trim() ?? "";
      return raw.length > 0 ? raw.slice(0, MAX_VERSION_LABEL_LENGTH) : null;
    }
  };

  const persistLabels = (next: Record<string, string>) => {
    try {
      window.localStorage.setItem(labelStorageKey, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode / quota): keep the in-memory label.
    }
  };

  const startRenaming = (version: VersionRow) => {
    setRenaming(version.id);
    setNameDraft(labelOf(version) ?? "");
    setNameError(null);
  };

  const cancelRenaming = () => {
    setRenaming(null);
    setNameDraft("");
    setNameError(null);
  };

  const commitName = async (version: VersionRow) => {
    let normalized: string | null;
    try {
      normalized = normalizeVersionLabel(nameDraft);
    } catch {
      setNameError(`Name must be at most ${MAX_VERSION_LABEL_LENGTH} characters.`);
      return;
    }

    setSavingName(true);
    try {
      if (onNameVersion) {
        const outcome = await onNameVersion(version.id, normalized);
        if ("error" in outcome) {
          setNameError(outcome.error);
          return;
        }
      }
      setLabelOverrides((previous) => {
        const next = { ...previous };
        if (normalized === null) delete next[version.id];
        else next[version.id] = normalized;
        persistLabels(next);
        return next;
      });
      cancelRenaming();
    } finally {
      setSavingName(false);
    }
  };

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
                {versions.map((version, index) => {
                  // Newest-first list: the next entry is the previous (older)
                  // snapshot. The oldest row has none, so "vs previous" is
                  // disabled there and the view falls back to "vs current".
                  const hasPrevious = index + 1 < versions.length;
                  const effectiveComparison: DiffComparison =
                    comparison === "previous" && hasPrevious ? "previous" : "current";
                  // Named versions (R30.10-lite): override -> host label -> null,
                  // in which case the row shows the timestamp below.
                  const label = labelOf(version);
                  // Non-null only while comparing against a predecessor, so the
                  // baseline is the older snapshot and the target is this one.
                  const previousSnapshot =
                    effectiveComparison === "previous" ? versions[index + 1] : null;
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
                          <p
                            className="flex flex-wrap items-center gap-1 text-[11px] text-muted"
                            suppressHydrationWarning
                          >
                            {label !== null && (
                              <span
                                data-testid="version-label"
                                className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700"
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
                      {/* Named versions (R30.10-lite): label this snapshot, or
                          rename/clear an existing label. Additive to the restore
                          control above; the inline diff below is untouched. */}
                      {renaming === version.id ? (
                        <span className="mt-2 flex items-center gap-1">
                          <input
                            autoFocus
                            value={nameDraft}
                            maxLength={MAX_VERSION_LABEL_LENGTH}
                            onChange={(event) => setNameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void commitName(version);
                              } else if (event.key === "Escape") {
                                cancelRenaming();
                              }
                            }}
                            placeholder="Name this version"
                            aria-label="Version name"
                            className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent"
                          />
                          <button
                            type="button"
                            disabled={savingName}
                            onClick={() => void commitName(version)}
                            aria-label="Save version name"
                            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50"
                          >
                            <Check className="h-3 w-3" /> {t(locale, "save")}
                          </button>
                          <button
                            type="button"
                            onClick={cancelRenaming}
                            aria-label="Cancel naming this version"
                            className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                          >
                            {t(locale, "cancel")}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => startRenaming(version)}
                          className="mt-2 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50"
                        >
                          <Tag className="h-3 w-3" /> {label !== null ? "Rename" : "Name"}
                        </button>
                      )}
                      {renaming === version.id && nameError !== null && (
                        <p role="alert" className="mt-1 text-[11px] text-red-500">
                          {nameError}
                        </p>
                      )}
                      {/* Inline character-level diff (F7 text-diff) of this
                          snapshot against the live page or the previous
                          snapshot - additive to the existing row controls,
                          collapses when re-toggled. */}
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
                          <div
                            role="group"
                            aria-label="Compare version with"
                            className="mb-2 flex items-center gap-0.5"
                          >
                            <button
                              type="button"
                              aria-pressed={effectiveComparison === "current"}
                              onClick={() => setComparison("current")}
                              className={cn(
                                "rounded px-2 py-0.5 text-[11px]",
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
                              onClick={() => setComparison("previous")}
                              className={cn(
                                "rounded px-2 py-0.5 text-[11px]",
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
                        </div>
                      )}
                    </li>
                  );
                })}
                </ul>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

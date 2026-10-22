"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { History } from "lucide-react";
import { t } from "@/lib/i18n";
import { trapPlan, type Focusable, type FocusPlan } from "@/lib/focus-trap";

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
   * Optional human-readable name for this snapshot (R30.10 named versions).
   * Additive: `PageVersion.label` now exists, so hosts that select it pass it
   * straight through; rows without one fall back to the relative timestamp.
   * Blank/whitespace labels are treated as unnamed.
   */
  label?: string | null;
};

/**
 * Tab / Shift+Tab plan for the history panel, delegated to the shared
 * `@/lib/focus-trap` kernel. `activeId` is the focused stop's id (`null` when
 * focus is outside the ring, which enters at the first stop — last on
 * Shift+Tab). `null` means "nothing to trap".
 */
export function planVersionHistoryTab(
  stops: readonly Focusable[],
  { activeId = null, shift = false }: { activeId?: string | null; shift?: boolean } = {},
): FocusPlan | null {
  return trapPlan(stops, {
    initial: activeId === null ? null : { id: activeId },
    shift,
  });
}

const VersionHistoryPanel = dynamic(
  () =>
    import("@/components/version-history-panel").then((mod) => ({
      default: mod.VersionHistoryPanel,
    })),
  { ssr: false },
);

/**
 * Version history as a slide-over panel: the page body stays readable instead
 * of ending with a long list, and each entry says who changed what. The heavy
 * diff/restore/focus panel is a separate chunk, loaded on first open.
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
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring u-interactive inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <History className="h-4 w-4" />
        {t(locale, "history")}
        {versions.length > 0 && (
          <span className="rounded bg-surface-2 px-1 text-3xs">{versions.length}</span>
        )}
      </button>

      {open && (
        <VersionHistoryPanel
          pageId={pageId}
          versions={versions}
          current={current}
          locale={locale}
          onClose={() => setOpen(false)}
          returnFocusRef={triggerRef}
        />
      )}
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Users } from "lucide-react";
import {
  listPagePermissionsAction,
  setPagePermissionAction,
} from "@/server/actions/page-permissions";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import {
  focusableSelector,
  resolveReturnTarget,
  trapPlan,
  type Focusable,
  type FocusPlan,
} from "@/lib/focus-trap";

type Row = { userId: string; name: string; email: string; level: string | null };

const LEVEL_KEYS: Record<string, "inheritRole" | "canView" | "canComment" | "canEdit" | "fullAccess"> = {
  NONE: "inheritRole",
  READ: "canView",
  COMMENT: "canComment",
  EDIT: "canEdit",
  FULL: "fullAccess",
};
const LEVELS = ["NONE", "READ", "COMMENT", "EDIT", "FULL"];

/* ------------------------------------------------------------------------- *
 * Focus management (shared kernel: @/lib/focus-trap)
 *
 * The "Who has access" modal is hand-rolled — it bypasses `ui/dialog` — so it
 * owns its own Tab trap: the roster's level `<select>`s plus the footer button
 * are mapped to `Focusable` descriptors, `trapPlan` decides the next stop
 * (wrapping at the ends), and `resolveReturnTarget` restores focus to the
 * invoking control when the modal unmounts. Escape is intentionally untouched:
 * this overlay never closed on Escape, so adding it would change behaviour.
 * ------------------------------------------------------------------------- */

/**
 * Tab / Shift+Tab plan for the access modal, delegated to the shared
 * `@/lib/focus-trap` kernel. `activeId` is the focused stop's id (`null` when
 * focus is outside the ring, which enters at the first stop — last on
 * Shift+Tab). `null` means "nothing to trap".
 */
export function planWhoHasAccessTab(
  stops: readonly Focusable[],
  { activeId = null, shift = false }: { activeId?: string | null; shift?: boolean } = {},
): FocusPlan | null {
  return trapPlan(stops, {
    initial: activeId === null ? null : { id: activeId },
    shift,
  });
}

/** The modal's real tabbable elements, tagged with their index as the id. */
function accessStops(root: HTMLElement): {
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
 * The member roster with per-person access levels — the shared body of both
 * share surfaces (the "Who has access" modal and the Share panel). Exported so
 * the Share dialog embeds exactly the same list instead of a second copy.
 *
 * The server answers guests and revoked users with an empty list, so this
 * renders an empty state rather than a roster they must not see.
 */
export function AccessList({
  pageId,
  locale = "en",
}: {
  pageId: string;
  locale?: string;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const { run, pending, error } = useAction(locale);

  useEffect(() => {
    let live = true;
    void listPagePermissionsAction(pageId)
      .then((rows) => {
        if (live) setRows(rows as Row[]);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [pageId]);

  const change = (userId: string, level: string) =>
    run(() => setPagePermissionAction(pageId, userId, level as "NONE"), {
      onSuccess: () =>
        setRows((current) =>
          current
            ? current.map((row) =>
                row.userId === userId ? { ...row, level: level === "NONE" ? null : level } : row,
              )
            : current,
        ),
    });

  return (
    <div className="max-h-80 overflow-y-auto">
      {rows === null ? (
        <p className="flex items-center gap-2 px-1 py-4 text-sm text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t(locale, "loadingMembers")}
        </p>
      ) : rows.length === 0 ? (
        <p className="px-1 py-4 text-sm text-muted">{t(locale, "noMembers")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.userId} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{row.name}</span>
                <span className="block truncate text-[11px] text-muted">{row.email}</span>
              </span>
              <select
                value={row.level ?? "NONE"}
                aria-label={`Access for ${row.name}`}
                disabled={pending}
                onChange={(event) => change(row.userId, event.target.value)}
                className="h-8 rounded border border-border bg-bg px-2 text-xs disabled:opacity-50"
              >
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(locale, LEVEL_KEYS[level])}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Who can open this page, member by member. Lists the effective explicit level
 * (or "inherit") and lets an editor change it — the capability the page menu was
 * missing even though the server could already answer it.
 */
export function WhoHasAccess({
  pageId,
  locale = "en",
  onClose,
}: {
  pageId: string;
  onClose: () => void;
  locale?: string;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  // Record the invoking control, move focus into the modal, and restore the
  // invoker on unmount (only while it is still connected).
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      invokerRef.current = active;
    }
    dialogRef.current?.focus();
    return () => {
      const invoker = invokerRef.current;
      invokerRef.current = null;
      const target = resolveReturnTarget({
        invoker: invoker
          ? { id: "access-invoker", connected: invoker.isConnected }
          : null,
      });
      if (target) invoker?.focus();
    };
  }, []);

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const { stops, nodes } = accessStops(event.currentTarget);
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? nodes.indexOf(active) : -1;
    const plan = planWhoHasAccessTab(stops, {
      activeId: activeIndex >= 0 ? String(activeIndex) : null,
      shift: event.shiftKey,
    });
    if (!plan) return;
    const target = nodes[Number(plan.target.id)];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={t(locale, "whoHasAccess")}
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-bg p-4 shadow-2xl outline-none"
      >
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Users className="h-4 w-4 text-muted" aria-hidden /> {t(locale, "whoHasAccess")}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {t(locale, "whoHasAccessIntro")}
        </p>

        <div className="mt-4">
          <AccessList pageId={pageId} locale={locale} />
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded border border-border px-3 text-sm hover:bg-surface-2"
          >
            {t(locale, "done")}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Loader2, Users } from "lucide-react";
import {
  listPagePermissionsAction,
  setPagePermissionAction,
} from "@/server/actions/page-permissions";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";

type Row = { userId: string; name: string; email: string; level: string | null };

const LEVEL_KEYS: Record<string, "inheritRole" | "canView" | "canComment" | "canEdit" | "fullAccess"> = {
  NONE: "inheritRole",
  READ: "canView",
  COMMENT: "canComment",
  EDIT: "canEdit",
  FULL: "fullAccess",
};
const LEVELS = ["NONE", "READ", "COMMENT", "EDIT", "FULL"];

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div
        role="dialog"
        aria-label={t(locale, "whoHasAccess")}
        aria-modal="true"
        className="relative z-10 w-full max-w-lg rounded-xl border border-border bg-bg p-4 shadow-2xl"
      >
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Users className="h-4 w-4 text-muted" aria-hidden /> {t(locale, "whoHasAccess")}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {t(locale, "whoHasAccessIntro")}
        </p>

        <div className="mt-4 max-h-80 overflow-y-auto">
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
        </div>

        {error && (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

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

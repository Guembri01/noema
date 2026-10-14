"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { deleteWorkspaceAction } from "@/server/actions/workspaces";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";

/**
 * Owner-only workspace deletion. Two guards: the owner must type the workspace
 * name, and the server re-checks the name before deleting anything.
 */
export function DangerZone({
  workspaceId,
  workspaceName,
  locale,
  canDelete,
}: {
  workspaceId: string;
  workspaceName: string;
  canDelete: boolean;
  locale: string;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  if (!canDelete) return null;

  return (
    <section className="mt-10 rounded-xl border border-red-500/30 p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
        <AlertTriangle className="h-4 w-4" aria-hidden /> {t(locale, "dangerZone")}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {t(locale, "dangerZoneBody")}
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 h-9 rounded border border-red-500/40 px-3 text-sm text-red-600 hover:bg-red-500/10 dark:text-red-400"
        >
          {t(locale, "deleteWorkspace")}
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="block text-sm">
            {t(locale, "typeToConfirm")} <strong>{workspaceName}</strong>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-label={t(locale, "typeToConfirm")}
              className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-red-500"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending || typed.trim() !== workspaceName}
              onClick={() =>
                run(() => deleteWorkspaceAction(workspaceId, typed), {
                  success: "Workspace deleted",
                  onSuccess: () => {
                    router.push("/app");
                    router.refresh();
                  },
                })
              }
              className="h-9 rounded bg-red-600 px-3 text-sm text-white hover:bg-red-500 disabled:opacity-40"
            >
              {pending ? t(locale, "working") : t(locale, "deleteWorkspaceConfirm")}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTyped("");
              }}
              className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
            >
              {t(locale, "cancel")}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

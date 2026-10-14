"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { History, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { restorePageVersionAction } from "@/server/actions/page-versions";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { cn, initials, avatarColor } from "@/lib/utils";

export type VersionRow = {
  id: string;
  title: string;
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
 * Version history as a slide-over panel: the page body stays readable instead
 * of ending with a long list, and each entry says who changed what.
 */
export function VersionHistory({
  pageId,
  versions,
  locale,
}: {
  pageId: string;
  versions: VersionRow[];
  locale: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

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
              {versions.length === 0 ? (
                <p className="p-2 text-sm text-muted">
                  {t(locale, "noVersionsYet")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {versions.map((version, index) => (
                    <li
                      key={version.id}
                      className={cn(
                        "rounded-lg border border-border p-3",
                        index === 0 && "bg-surface",
                      )}
                    >
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
                            {index === 0 ? t(locale, "currentSuffix") : ""}
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
                      {index !== 0 && (
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
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

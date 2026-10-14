"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { importNotionPageAction } from "@/server/actions/notion-import";
import { t } from "@/lib/i18n";

export function NotionImportDialog({
  locale = "en",
  open,
  onOpenChange,
  workspaceId,
  slug,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  slug: string;
  locale?: string;
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [pageId, setPageId] = useState("");
  const [pending, startTransition] = useTransition();
  /**
   * B71 (D23.4 / spec §12 dialog sketch): a real stage/count line instead of
   * the bare `pending` boolean — stage while the action runs, counts when it
   * finishes, the server error inline on failure.
   */
  const [stage, setStage] = useState<"idle" | "running" | "done">("idle");
  const [summary, setSummary] = useState("");
  const [failure, setFailure] = useState("");
  const [importedId, setImportedId] = useState("");

  const reset = () => {
    setStage("idle");
    setSummary("");
    setFailure("");
    setImportedId("");
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = () =>
    startTransition(async () => {
      setFailure("");
      setSummary("");
      setStage("running");
      const result = await importNotionPageAction({ workspaceId, token, pageId });

      if ("ok" in result) {
        const counts = result.counts;
        setSummary(
          t(locale, "importSummary")
            .replace("{imported}", String(counts.imported))
            .replace("{skipped}", String(counts.skippedColumns + counts.skippedCells))
            .replace("{failed}", String(counts.failed)),
        );
        setImportedId(result.id);
        setStage("done");
        setToken("");
        setPageId("");
        toast.success(
          result.pages === 1
            ? t(locale, "importedOne")
            : t(locale, "importedMany").replace("{n}", String(result.pages)),
        );
      } else {
        setStage("idle");
        setFailure(result.error);
        toast.error(result.error);
      }
    });

  const openImported = () => {
    const target = importedId;
    handleOpenChange(false);
    if (target) {
      router.push(`/w/${slug}/${target}`);
      router.refresh();
    }
  };

  const showStatus = stage === "running" || summary !== "" || failure !== "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg p-6" aria-describedby={undefined}>
        <h2 className="text-lg font-semibold">{t(locale, "importFromNotion")}</h2>
        <p className="mt-1 text-sm text-muted">
          {t(locale, "importNotionIntro")}
        </p>
        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-muted" htmlFor="notion-token">
          {t(locale, "integrationToken")}
        </label>
        <input
          id="notion-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="ntn_… / secret_…"
          className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-muted" htmlFor="notion-page">
          {t(locale, "pageUrlOrId")}
        </label>
        <input
          id="notion-page"
          value={pageId}
          onChange={(event) => setPageId(event.target.value)}
          placeholder="https://www.notion.so/My-page-1a2b3c…"
          className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
        {showStatus && (
          <div
            className="mt-3 rounded border border-border bg-surface p-2 text-sm"
            data-testid="notion-import-status"
            aria-live="polite"
          >
            {stage === "running" && (
              <p role="status" className="text-muted">
                {t(locale, "importStageRunning")}
              </p>
            )}
            {summary !== "" && (
              <p role="status" className="text-muted">
                {summary}
              </p>
            )}
            {failure !== "" && (
              <p role="alert" className="text-red-500">
                {failure}
              </p>
            )}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
          >
            {t(locale, "cancel")}
          </button>
          {stage === "done" ? (
            <button
              type="button"
              onClick={openImported}
              className="h-9 rounded bg-accent px-3 text-sm text-accent-fg"
            >
              {t(locale, "openImportedPage")}
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || !token.trim() || !pageId.trim()}
              onClick={submit}
              className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
            >
              {pending ? t(locale, "importing") : t(locale, "importAction")}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

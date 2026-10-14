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

  const submit = () =>
    startTransition(async () => {
      const result = await importNotionPageAction({ workspaceId, token, pageId });

      if ("ok" in result) {
        toast.success(
          result.pages === 1
            ? t(locale, "importedOne")
            : t(locale, "importedMany").replace("{n}", String(result.pages)),
        );
        setToken("");
        setPageId("");
        onOpenChange(false);
        router.push(`/w/${slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
          >
            {t(locale, "cancel")}
          </button>
          <button
            type="button"
            disabled={pending || !token.trim() || !pageId.trim()}
            onClick={submit}
            className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
          >
            {pending ? t(locale, "importing") : t(locale, "importAction")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

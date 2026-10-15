"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { importNotionPageAction } from "@/server/actions/notion-import";
import { t } from "@/lib/i18n";
import {
  mapNotionBlockType,
  mapNotionPropertyType,
  unmappedBlocks,
} from "@/lib/import-notion-map";

/** Distinct, non-empty type strings in first-seen order (mirrors `unmappedBlocks`). */
function distinctTypes(types: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of types as readonly unknown[]) {
    if (typeof raw !== "string" || raw.trim() === "" || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Mapped-vs-unmapped tally for a Notion import preview. */
type NotionPreview = {
  blockTotal: number;
  blockMapped: number;
  blockUnmapped: string[];
  propertyTotal: number;
  propertyMapped: number;
  propertyUnmapped: string[];
};

/**
 * Summarise what an import will map using the vocabulary layer
 * (`src/lib/import-notion-map.ts`) rather than a second copy of the rules.
 */
function summarizeNotionPreview(
  blockTypes: readonly string[],
  propertyTypes: readonly string[],
): NotionPreview {
  const blocks = distinctTypes(blockTypes);
  const properties = distinctTypes(propertyTypes);
  return {
    blockTotal: blocks.length,
    blockMapped: blocks.filter((type) => mapNotionBlockType(type) !== null).length,
    blockUnmapped: unmappedBlocks(blocks),
    propertyTotal: properties.length,
    propertyMapped: properties.filter((type) => mapNotionPropertyType(type) !== null).length,
    propertyUnmapped: properties.filter((type) => mapNotionPropertyType(type) === null),
  };
}

export function NotionImportDialog({
  locale = "en",
  open,
  onOpenChange,
  workspaceId,
  slug,
  blockTypes = [],
  propertyTypes = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  slug: string;
  locale?: string;
  /**
   * Optional import-preview input: the Notion block / property types the page
   * contains. When supplied, the dialog tallies how many map to Noema
   * (`mapNotionBlockType` / `mapNotionPropertyType`) and warns about the ones
   * that do not (`unmappedBlocks`) before the user confirms. Purely additive:
   * a caller that passes neither sees the dialog exactly as before.
   */
  blockTypes?: readonly string[];
  propertyTypes?: readonly string[];
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
  /**
   * J30: mapped-vs-unmapped preview so the user sees what will be dropped
   * before confirming. The submission path below is untouched; the
   * acknowledgement only gates the button when a preview reports a loss.
   */
  const preview = useMemo(
    () => summarizeNotionPreview(blockTypes, propertyTypes),
    [blockTypes, propertyTypes],
  );
  const hasPreview = preview.blockTotal > 0 || preview.propertyTotal > 0;
  const unmappedCount = preview.blockUnmapped.length + preview.propertyUnmapped.length;
  const [acknowledged, setAcknowledged] = useState(false);

  const reset = () => {
    setStage("idle");
    setSummary("");
    setFailure("");
    setImportedId("");
    setAcknowledged(false);
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
        {hasPreview && (
          <div
            className="mt-3 rounded border border-border bg-surface p-2 text-sm"
            data-testid="notion-import-preview"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Import preview
            </p>
            {preview.blockTotal > 0 && (
              <p className="mt-1 text-muted">
                Blocks: {preview.blockMapped} of {preview.blockTotal} types mapped
                {preview.blockUnmapped.length > 0
                  ? ` · ${preview.blockUnmapped.length} unsupported`
                  : ""}
              </p>
            )}
            {preview.propertyTotal > 0 && (
              <p className="mt-1 text-muted">
                Properties: {preview.propertyMapped} of {preview.propertyTotal} types mapped
                {preview.propertyUnmapped.length > 0
                  ? ` · ${preview.propertyUnmapped.length} unsupported`
                  : ""}
              </p>
            )}
            {unmappedCount > 0 && (
              <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2" role="alert">
                <p className="text-red-500">
                  {unmappedCount} Notion {unmappedCount === 1 ? "type has" : "types have"} no
                  equivalent and will be skipped:
                </p>
                <ul className="mt-1 list-disc pl-4 text-red-500">
                  {preview.blockUnmapped.map((type) => (
                    <li key={`block:${type}`}>block · {type}</li>
                  ))}
                  {preview.propertyUnmapped.map((type) => (
                    <li key={`property:${type}`}>property · {type}</li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2 text-red-500">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  Import anyway
                </label>
              </div>
            )}
          </div>
        )}
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
              disabled={pending || !token.trim() || !pageId.trim() || (unmappedCount > 0 && !acknowledged)}
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

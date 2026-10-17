"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  importNotionPageAction,
  type NotionImportOptions,
} from "@/server/actions/notion-import";
import type { NotionMappingSummary } from "@/server/actions/import";
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

/** The three Notion import steps, shown as a token-styled header. */
type NotionStep = "connect" | "review" | "import";
const NOTION_STEPS: readonly { id: NotionStep; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "review", label: "Review" },
  { id: "import", label: "Import" },
];

function notionStepIndex(step: NotionStep): number {
  return NOTION_STEPS.findIndex((entry) => entry.id === step);
}

function NotionSteps({ step }: { step: NotionStep }) {
  const active = notionStepIndex(step);
  return (
    <ol data-testid="notion-import-steps" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {NOTION_STEPS.map((entry, index) => {
        const state = index < active ? "done" : index === active ? "current" : "upcoming";
        return (
          <li
            key={entry.id}
            className="flex items-center gap-2"
            aria-current={state === "current" ? "step" : undefined}
          >
            {index > 0 ? <span aria-hidden className="h-px w-4 bg-border-strong" /> : null}
            <span
              data-state={state}
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-medium",
                state === "current" && "border-accent bg-accent text-accent-fg",
                state === "done" && "border-accent bg-accent-soft text-accent",
                state === "upcoming" && "border-border bg-surface-2 text-muted",
              )}
            >
              {state === "done" ? "✓" : index + 1}
            </span>
            <span className={cn("whitespace-nowrap", state === "upcoming" ? "text-muted" : "text-fg")}>
              {entry.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
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
  const [submitted, setSubmitted] = useState(false);
  const [step, setStep] = useState<NotionStep>("connect");
  const [pending, startTransition] = useTransition();
  /**
   * B71 (D23.4 / spec §12 dialog sketch): a real stage/count line instead of
   * the bare `pending` boolean — stage while the action runs, counts when it
   * finishes, the server error inline on failure.
   */
  const [runState, setRunState] = useState<"idle" | "running" | "done">("idle");
  const [summary, setSummary] = useState<{ imported: number; skipped: number; failed: number; id: string } | null>(
    null,
  );
  const [failure, setFailure] = useState("");
  const [importedId, setImportedId] = useState("");
  /**
   * K32: server-reported loss report `result.unmapped` for the last successful
   * import, so the result UI can show how many Notion block/property types were
   * dropped instead of only the pre-import preview estimate.
   */
  const [importedUnmapped, setImportedUnmapped] = useState<NotionMappingSummary | null>(null);
  /**
   * R24: the options the server action reported honouring on the last
   * successful import. Surfaced under the status line so the user can see that
   * e.g. subpages were actually skipped, not just that the toggle was ticked.
   */
  const [honouredOptions, setHonouredOptions] = useState<NotionImportOptions | null>(null);
  /**
   * Q20: additive import options the user can toggle before confirming. Both
   * default to `true`, which reproduces the pre-existing behaviour (properties
   * imported, nested subpages included). R24 wires them to the server action
   * (`importNotionPageAction`), which now honours them and echoes back the
   * applied values on `result.options`.
   */
  const [importProperties, setImportProperties] = useState(true);
  const [includeSubpages, setIncludeSubpages] = useState(true);
  /**
   * J30: mapped-vs-unmapped preview so the user sees what will be dropped
   * before confirming. The submission path below is untouched; the danger
   * `ConfirmDialog` only gates the destructive part (skipping unmapped types).
   */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const preview = useMemo(
    () => summarizeNotionPreview(blockTypes, propertyTypes),
    [blockTypes, propertyTypes],
  );
  const hasPreview = preview.blockTotal > 0 || preview.propertyTotal > 0;
  const unmappedCount = preview.blockUnmapped.length + preview.propertyUnmapped.length;

  /**
   * K32: what the server actually dropped on the last successful import
   * (`result.unmapped`), surfaced as counts after the fact. Empty when the
   * import had no losses or none has run yet.
   */
  const importedBlocksUnmapped = importedUnmapped?.blocks.unmapped ?? [];
  const importedPropertiesUnmapped = importedUnmapped?.properties.unmapped ?? [];
  const importedUnmappedCount = importedBlocksUnmapped.length + importedPropertiesUnmapped.length;

  const reset = () => {
    setStep("connect");
    setSubmitted(false);
    setRunState("idle");
    setSummary(null);
    setFailure("");
    setImportedId("");
    setImportedUnmapped(null);
    setHonouredOptions(null);
    setConfirmOpen(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const canReview = token.trim() !== "" && pageId.trim() !== "";

  const goReview = () => {
    setSubmitted(true);
    if (!canReview) return;
    setStep("review");
  };

  const submit = () => {
    setConfirmOpen(false);
    setStep("import");
    startTransition(async () => {
      setFailure("");
      setRunState("running");
      const result = await importNotionPageAction({
        workspaceId,
        token,
        pageId,
        importProperties,
        includeSubpages,
      });

      if ("ok" in result) {
        const counts = result.counts;
        setSummary({
          imported: counts.imported,
          skipped: counts.skippedColumns + counts.skippedCells,
          failed: counts.failed,
          id: result.id,
        });
        setImportedId(result.id);
        setImportedUnmapped(result.unmapped);
        setHonouredOptions(result.options);
        setRunState("done");
        setToken("");
        setPageId("");
        toast.success(
          result.pages === 1
            ? t(locale, "importedOne")
            : t(locale, "importedMany").replace("{n}", String(result.pages)),
        );
      } else {
        setRunState("idle");
        setFailure(result.error);
        toast.error(result.error);
      }
    });
  };

  /** The destructive gate: skipping unmapped types asks for confirmation. */
  const requestImport = () => {
    if (unmappedCount > 0) {
      setConfirmOpen(true);
      return;
    }
    submit();
  };

  const openImported = () => {
    const target = importedId;
    handleOpenChange(false);
    if (target) {
      router.push(`/w/${slug}/${target}`);
      router.refresh();
    }
  };

  const footer =
    step === "import" ? (
      <div className="flex justify-end gap-2">
        {runState === "done" && importedId ? (
          <Button type="button" variant="primary" onClick={openImported}>
            {t(locale, "openImportedPage")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            {t(locale, "cancel")}
          </Button>
        )}
      </div>
    ) : (
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => (step === "review" ? setStep("connect") : handleOpenChange(false))}
          disabled={pending}
        >
          {step === "review" ? "Back" : t(locale, "cancel")}
        </Button>
        {step === "connect" ? (
          <Button type="button" variant="primary" onClick={goReview}>
            Continue
          </Button>
        ) : (
          <Button type="button" variant="primary" loading={pending} onClick={requestImport}>
            {pending ? t(locale, "importing") : t(locale, "importAction")}
          </Button>
        )}
      </div>
    );

  return (
    <Sheet
      open={open}
      onOpenChange={handleOpenChange}
      side="right"
      size="md"
      title={t(locale, "importFromNotion")}
      description={t(locale, "importNotionIntro")}
      data-testid="notion-import-panel"
      footer={footer}
    >
      <NotionSteps step={step} />

      {step === "connect" ? (
        <div className="mt-5 flex flex-col gap-4" data-testid="notion-step-connect">
          <Field
            id="notion-token"
            label={t(locale, "integrationToken")}
            error={submitted && !token.trim() ? "A token is required." : undefined}
          >
            <Input
              id="notion-token"
              type="password"
              value={token}
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
              placeholder="ntn_… / secret_…"
            />
          </Field>
          <Field
            id="notion-page"
            label={t(locale, "pageUrlOrId")}
            error={submitted && !pageId.trim() ? "A page URL or id is required." : undefined}
          >
            <Input
              id="notion-page"
              value={pageId}
              onChange={(event) => setPageId(event.target.value)}
              placeholder="https://www.notion.so/My-page-1a2b3c…"
            />
          </Field>

          <fieldset
            className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
            data-testid="notion-import-options"
          >
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted">
              Import options
            </legend>
            <span data-testid="notion-import-include-properties">
              <Switch
                checked={importProperties}
                onCheckedChange={setImportProperties}
                label="Import page properties"
              />
            </span>
            <span data-testid="notion-import-include-subpages">
              <Switch
                checked={includeSubpages}
                onCheckedChange={setIncludeSubpages}
                label="Include subpages"
              />
            </span>
          </fieldset>
        </div>
      ) : null}

      {step === "review" ? (
        <div className="mt-5 flex flex-col gap-4" data-testid="notion-import-preview">
          {hasPreview ? (
            <div className="flex flex-wrap items-center gap-2">
              {preview.blockTotal > 0 ? (
                <Badge tone={preview.blockUnmapped.length > 0 ? "warning" : "success"}>
                  {`Blocks ${preview.blockMapped}/${preview.blockTotal}`}
                </Badge>
              ) : null}
              {preview.propertyTotal > 0 ? (
                <Badge tone={preview.propertyUnmapped.length > 0 ? "warning" : "success"}>
                  {`Properties ${preview.propertyMapped}/${preview.propertyTotal}`}
                </Badge>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted">
              Ready to import. Types are detected from the page on the server.
            </p>
          )}

          {unmappedCount > 0 ? (
            <div className="rounded-md border border-warning bg-warning-soft p-2 text-sm text-warning" role="alert">
              <p>
                {unmappedCount} Notion {unmappedCount === 1 ? "type has" : "types have"} no equivalent
                and will be skipped:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {preview.blockUnmapped.map((type) => (
                  <li key={`block:${type}`}>block · {type}</li>
                ))}
                {preview.propertyUnmapped.map((type) => (
                  <li key={`property:${type}`}>property · {type}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <dl className="grid grid-cols-2 gap-2 rounded-md border border-border bg-surface p-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Properties</dt>
              <dd className="text-fg">{importProperties ? "Imported" : "Skipped"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Subpages</dt>
              <dd className="text-fg">{includeSubpages ? "Included" : "Skipped"}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {step === "import" ? (
        <div className="mt-5 flex flex-col gap-4" data-testid="notion-import-status" aria-live="polite">
          {runState !== "done" ? (
            <Progress label={t(locale, "importStageRunning")} />
          ) : null}

          {failure !== "" ? (
            <p role="alert" className="rounded-md border border-danger bg-danger-soft p-2 text-sm text-danger">
              {failure}
            </p>
          ) : null}

          {summary ? (
            <div className="flex flex-wrap items-center gap-2" role="status">
              <Badge tone="success" count={summary.imported}>
                Imported
              </Badge>
              {summary.skipped > 0 ? (
                <Badge tone="warning" count={summary.skipped}>
                  Skipped
                </Badge>
              ) : null}
              {summary.failed > 0 ? (
                <Badge tone="danger" count={summary.failed}>
                  Failed
                </Badge>
              ) : null}
            </div>
          ) : null}

          {runState === "done" && honouredOptions ? (
            <p className="text-xs text-muted" data-testid="notion-import-honoured-options">
              Options applied:{" "}
              {honouredOptions.importProperties ? "properties imported" : "properties skipped"}
              {" · "}
              {honouredOptions.includeSubpages ? "subpages included" : "subpages skipped"}
            </p>
          ) : null}

          {runState === "done" && importedUnmappedCount > 0 ? (
            <div
              className="rounded-md border border-warning bg-warning-soft p-2 text-sm text-warning"
              data-testid="notion-import-unmapped"
            >
              <p>
                {importedUnmappedCount} Notion{" "}
                {importedUnmappedCount === 1 ? "type was" : "types were"} skipped and not imported:
              </p>
              <p className="mt-1">
                Blocks: {importedBlocksUnmapped.length} unmapped
                {importedPropertiesUnmapped.length > 0
                  ? ` · Properties: ${importedPropertiesUnmapped.length} unmapped`
                  : ""}
              </p>
              <ul className="mt-1 list-disc pl-5">
                {importedBlocksUnmapped.map((type) => (
                  <li key={`imported-block:${type}`}>block · {type}</li>
                ))}
                {importedPropertiesUnmapped.map((type) => (
                  <li key={`imported-property:${type}`}>property · {type}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="danger"
        title="Import anyway?"
        description={`${unmappedCount} Notion ${unmappedCount === 1 ? "type has" : "types have"} no equivalent and will be skipped.`}
        confirmLabel="Import anyway"
        cancelLabel="Review"
        onConfirm={submit}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {preview.blockUnmapped.map((type) => (
            <li key={`confirm-block:${type}`}>block · {type}</li>
          ))}
          {preview.propertyUnmapped.map((type) => (
            <li key={`confirm-property:${type}`}>property · {type}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </Sheet>
  );
}

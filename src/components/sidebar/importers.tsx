"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Database as DatabaseIcon, Upload } from "lucide-react";
import {
  importCsvDatabaseAction,
  importDocxAction,
  importMarkdownAction,
  importTrelloAction,
  importZipAction,
} from "@/server/actions/import";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { csvToMatrix, matrixToCsv } from "@/lib/serialize";
import {
  buildCreatePlan,
  detectDuplicateHeaders,
  placeholderFor,
  suggestPropertyMapping,
  type ColumnMapping,
  type InferredColumnType,
} from "@/lib/csv-mapping";
import { parseTrelloBoard, type TrelloImportMeta } from "@/lib/trello-import";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { safeAction } from "@/lib/actions-client";

type StartTransition = (callback: () => void) => void;

type ImportSectionProps = {
  workspace: { id: string; slug: string };
  addPage: (parentId: string | null, type: "PAGE" | "DATABASE") => void;
  locale: string;
  startTransition: StartTransition;
  onOpenNotion: () => void;
};

/** Column types the CSV mapping step can create (mirrors `InferredColumnType`). */
const COLUMN_TYPES: InferredColumnType[] = [
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "url",
  "email",
];

/** How many data rows the type heuristic samples (bounded for large files). */
const SAMPLE_ROWS = 50;

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * A parsed CSV awaiting its mapping step. `mapping`/`include`/`types` are
 * index-aligned with `headers`; `types` starts from the inferred suggestions
 * and is what the user can override before the create-database payload is
 * built with `buildCreatePlan`.
 */
type CsvDraft = {
  fileName: string;
  title: string;
  headers: string[];
  rows: string[][];
  mapping: ColumnMapping[];
  include: boolean[];
  types: InferredColumnType[];
};

/** A parsed Trello board awaiting confirmation (built from the trello-import engine). */
type TrelloDraft = {
  json: string;
  boardName: string;
  meta: TrelloImportMeta;
  properties: { id: string; name: string; type: string }[];
  rows: { id: string; title: string }[];
};

export function ImportSection({
  workspace,
  addPage,
  locale,
  startTransition,
  onOpenNotion,
}: ImportSectionProps) {
  const router = useRouter();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      startTransition(async () => {
        const outcome = await safeAction(() =>
          importMarkdownAction({
            workspaceId: workspace.id,
            filename: file.name,
            markdown: String(reader.result ?? ""),
          }),
        );
        if (!outcome.ok) {
          toast.error(outcome.error);
          return;
        }
        const result = outcome.value;
        if ("ok" in result) {
          toast.success(`Imported ${file.name}`);
          router.push(`/w/${workspace.slug}/${result.id}`);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    };
    reader.readAsText(file);
  };

  const trelloInputRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  // --- Trello preview -------------------------------------------------------
  // The import itself still sends the raw JSON (the server re-parses it), but
  // the confirmation payload is built from `parseTrelloBoard`'s `properties` /
  // `rows` / `meta` so the user sees exactly what will be created.
  const [trelloDraft, setTrelloDraft] = useState<TrelloDraft | null>(null);
  const [trelloPending, startTrelloTransition] = useTransition();

  const onImportTrello = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        toast.error("That file is not valid JSON.");
        return;
      }
      const board = parseTrelloBoard(raw);
      setTrelloDraft({
        json: text,
        boardName: board.meta.boardName || "Trello board",
        meta: board.meta,
        properties: board.properties.map((property) => ({
          id: property.id,
          name: property.name,
          type: property.type,
        })),
        rows: board.rows.map((row) => ({ id: row.id, title: row.title })),
      });
    };
    reader.readAsText(file);
  };

  const confirmTrello = () => {
    const draft = trelloDraft;
    if (!draft) return;
    startTrelloTransition(async () => {
      const outcome = await safeAction(() =>
        importTrelloAction({ workspaceId: workspace.id, json: draft.json }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success(`Imported Trello board “${draft.boardName}”`);
        setTrelloDraft(null);
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const onImportZip = (file: File) =>
    startTransition(async () => {
      const form = new FormData();
      form.append("workspaceId", workspace.id);
      form.append("file", file);
      const outcome = await safeAction(() => importZipAction(form));
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success("Imported archive");
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const docxInputRef = useRef<HTMLInputElement | null>(null);

  const onImportDocx = (file: File) =>
    startTransition(async () => {
      const form = new FormData();
      form.append("workspaceId", workspace.id);
      form.append("file", file);
      const outcome = await safeAction(() => importDocxAction(form));
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success("Imported Word document");
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const transcribeInputRef = useRef<HTMLInputElement | null>(null);

  const onTranscribe = (file: File) =>
    startTransition(async () => {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/ai/transcribe", { method: "POST", body: form });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(data?.error ?? `Transcription failed (${response.status})`);
        return;
      }
      const data = (await response.json()) as { text?: string };
      const outcome = await safeAction(() =>
        importMarkdownAction({
          workspaceId: workspace.id,
          filename: `${file.name.replace(/\.[^.]+$/, "")} (transcript)`,
          markdown: data.text ?? "",
        }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success("Transcript added");
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  // --- CSV import (create database) -----------------------------------------
  // Reuses the existing parser (`csvToMatrix`) and the pure mapping core
  // (`suggestPropertyMapping` / `detectDuplicateHeaders` / `placeholderFor` /
  // `buildCreatePlan`). The reviewed plan becomes the create-database payload.
  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const [csvDraft, setCsvDraft] = useState<CsvDraft | null>(null);
  const [csvPending, startCsvTransition] = useTransition();

  const openCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const matrix = csvToMatrix(String(reader.result ?? ""));
      if (matrix.length < 2) {
        toast.error("CSV needs a header row and at least one data row.");
        return;
      }
      const headers = matrix[0];
      const sampleRows = matrix.slice(1, SAMPLE_ROWS + 1);
      const mapping = suggestPropertyMapping(headers, sampleRows, []);
      setCsvDraft({
        fileName: file.name,
        title: file.name.replace(/\.[^.]+$/, "").trim() || "Imported CSV",
        headers,
        rows: matrix.slice(1),
        mapping,
        include: mapping.map(() => true),
        types: mapping.map((entry) => entry.suggestedType),
      });
    };
    reader.readAsText(file);
  };

  /** Columns the user kept (and can be created) → property descriptors + CSV. */
  const buildCsvPayload = (draft: CsvDraft) => {
    const selected = draft.mapping
      .map((entry, index) => ({ entry, index }))
      .filter(({ index }) => draft.include[index]);
    const creatable = selected.filter(({ entry }) => !entry.matchesExistingId);
    const properties = buildCreatePlan(
      creatable.map(({ entry, index }) => ({
        ...entry,
        suggestedType: draft.types[index],
      })),
    );
    // Normalise the header row to the created property names so the append core
    // (`importCsvAction`) matches every column by name.
    const rows = draft.rows.map((row) => creatable.map(({ index }) => row[index] ?? ""));
    const csv = matrixToCsv(
      properties.map((property) => property.name),
      rows,
    );
    return { properties, csv };
  };

  const runCsvImport = (draft: CsvDraft) => {
    startCsvTransition(async () => {
      const { properties, csv } = buildCsvPayload(draft);
      if (properties.length === 0) {
        toast.error("Choose at least one column to import.");
        return;
      }
      const outcome = await safeAction(() =>
        importCsvDatabaseAction({
          workspaceId: workspace.id,
          parentId: null,
          title: draft.title,
          properties,
          csv,
        }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success(`Imported ${result.counts.imported} rows`);
        setCsvDraft(null);
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  /** Direct import path: keep every column at its inferred type, no review. */
  const skipCsvMapping = () => {
    if (!csvDraft) return;
    runCsvImport({
      ...csvDraft,
      include: csvDraft.mapping.map(() => true),
      types: csvDraft.mapping.map((entry) => entry.suggestedType),
    });
  };

  const setCsvChoice = (index: number, value: string) => {
    setCsvDraft((prev) => {
      if (!prev) return prev;
      const include = [...prev.include];
      const types = [...prev.types];
      if (value === "skip") {
        include[index] = false;
      } else if (value.startsWith("map:")) {
        include[index] = true;
      } else {
        include[index] = true;
        types[index] = value as InferredColumnType;
      }
      return { ...prev, include, types };
    });
  };

  const csvDuplicates = csvDraft ? detectDuplicateHeaders(csvDraft.headers) : [];

  return (
    <div className="mt-3 space-y-px border-t border-border pt-3">
      <button
        type="button"
        onClick={() => addPage(null, "DATABASE")}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <DatabaseIcon className="h-4 w-4" />
        {t(locale, "newDatabase")}
      </button>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        {t(locale, "importMarkdown")}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onImportFile(file);
        }}
      />
      <button
        type="button"
        onClick={() => csvInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        {t(locale, "importCsv")} (create database)
      </button>
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) openCsv(file);
        }}
      />
      <button
        type="button"
        onClick={() => trelloInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import Trello (JSON)
      </button>
      <input
        ref={trelloInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onImportTrello(file);
        }}
      />
      <button
        type="button"
        onClick={() => zipInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import export (.zip)
      </button>
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onImportZip(file);
        }}
      />
      <button
        type="button"
        onClick={() => docxInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import Word (.docx)
      </button>
      <input
        ref={docxInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onImportDocx(file);
        }}
      />
      <button
        type="button"
        onClick={onOpenNotion}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import from Notion (API)
      </button>
      <button
        type="button"
        onClick={() => transcribeInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Transcribe audio
      </button>
      <input
        ref={transcribeInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onTranscribe(file);
        }}
      />

      {/* R23.2 — CSV → mapping step → create database. */}
      <Dialog open={csvDraft !== null} onOpenChange={(next) => !next && setCsvDraft(null)}>
        <DialogContent className="max-w-2xl p-6" aria-describedby={undefined}>
          {csvDraft && (
            <div data-testid="csv-mapping-dialog">
              <h2 className="text-lg font-semibold">{t(locale, "importCsv")}</h2>
              <p className="mt-1 text-sm text-muted">
                {csvDraft.fileName} · {csvDraft.rows.length} rows · {csvDraft.headers.length} columns
              </p>

              {csvDuplicates.length > 0 && (
                <p role="alert" className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-500">
                  Duplicate column names: {csvDuplicates.join(", ")}. Rename the header row before importing.
                </p>
              )}

              <div className="mt-4 max-h-80 overflow-auto rounded border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-2 py-1.5">Column</th>
                      <th className="px-2 py-1.5">Destination</th>
                      <th className="px-2 py-1.5">Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvDraft.mapping.map((entry, index) => {
                      const label = entry.header.trim() || placeholderFor(index);
                      const value = !csvDraft.include[index]
                        ? "skip"
                        : entry.matchesExistingId
                          ? `map:${entry.matchesExistingId}`
                          : csvDraft.types[index];
                      return (
                        <tr key={index} className="border-t border-border">
                          <td className="px-2 py-1.5">{label}</td>
                          <td className="px-2 py-1.5">
                            <select
                              aria-label={`Mapping for ${label}`}
                              value={value}
                              onChange={(event) => setCsvChoice(index, event.target.value)}
                              className="h-8 rounded border border-border bg-bg px-1 text-sm outline-none focus:border-accent"
                            >
                              <option value="skip">Skip</option>
                              {entry.matchesExistingId && (
                                <option value={`map:${entry.matchesExistingId}`}>Map to existing</option>
                              )}
                              {COLUMN_TYPES.map((type) => (
                                <option key={type} value={type}>
                                  Create as {capitalize(type)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1.5 text-muted">
                            {Math.round(entry.confidence * 100)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCsvDraft(null)}
                  className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
                >
                  {t(locale, "cancel")}
                </button>
                <button
                  type="button"
                  disabled={csvPending || csvDuplicates.length > 0}
                  onClick={skipCsvMapping}
                  className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2 disabled:opacity-50"
                >
                  Skip mapping
                </button>
                <button
                  type="button"
                  disabled={csvPending || csvDuplicates.length > 0}
                  onClick={() => runCsvImport(csvDraft)}
                  className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
                >
                  {csvPending ? t(locale, "importing") : "Create database"}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Trello preview — board name + `meta` counts + derived properties/rows. */}
      <Dialog open={trelloDraft !== null} onOpenChange={(next) => !next && setTrelloDraft(null)}>
        <DialogContent className="max-w-2xl p-6" aria-describedby={undefined}>
          {trelloDraft && (
            <div data-testid="trello-import-preview">
              <h2 className="text-lg font-semibold">{trelloDraft.boardName}</h2>
              <p className="mt-1 text-sm text-muted">
                {trelloDraft.meta.lists} lists · {trelloDraft.meta.cards} cards ·{" "}
                {trelloDraft.meta.labels} labels
              </p>
              {(trelloDraft.meta.skippedClosedLists > 0 ||
                trelloDraft.meta.skippedClosedCards > 0 ||
                trelloDraft.meta.skippedOrphanCards > 0 ||
                trelloDraft.meta.skippedMalformedCards > 0) && (
                <p className="mt-2 text-sm text-muted">
                  Skipped: {trelloDraft.meta.skippedClosedLists} closed lists ·{" "}
                  {trelloDraft.meta.skippedClosedCards} closed cards ·{" "}
                  {trelloDraft.meta.skippedOrphanCards} orphan cards ·{" "}
                  {trelloDraft.meta.skippedMalformedCards} malformed
                </p>
              )}
              {trelloDraft.properties.length === 0 ? (
                <p role="alert" className="mt-4 text-sm text-red-500">
                  No lists found — is this a Trello board export?
                </p>
              ) : (
                <>
                  <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">
                    Properties
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {trelloDraft.properties.map((property) => (
                      <span
                        key={property.id}
                        className="rounded border border-border px-2 py-0.5 text-xs text-muted"
                      >
                        {property.name} · {property.type}
                      </span>
                    ))}
                  </div>
                  <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">
                    First rows
                  </p>
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {trelloDraft.rows.slice(0, 5).map((row) => (
                      <li key={row.id} className="truncate text-muted">
                        {row.title}
                      </li>
                    ))}
                    {trelloDraft.rows.length > 5 && (
                      <li className="text-muted">…and {trelloDraft.rows.length - 5} more</li>
                    )}
                  </ul>
                </>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setTrelloDraft(null)}
                  className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
                >
                  {t(locale, "cancel")}
                </button>
                <button
                  type="button"
                  disabled={trelloPending || trelloDraft.properties.length === 0}
                  onClick={confirmTrello}
                  className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
                >
                  {trelloPending ? t(locale, "importing") : t(locale, "importAction")}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
import { importHtmlAction } from "@/server/actions/import-formats";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { csvToMatrix, matrixToCsv } from "@/lib/serialize";
import {
  buildCreatePlan,
  detectDuplicateHeaders,
  placeholderFor,
  suggestPropertyMapping,
  type ColumnMapping,
  type CreatePropertyDescriptor,
  type CsvCreatePropertyType,
  type InferredColumnType,
} from "@/lib/csv-mapping";
import { parseTrelloBoard, type TrelloImportMeta } from "@/lib/trello-import";
import { parseAsanaExport, type AsanaImportResult } from "@/lib/import-asana";
import { parseEnex, type EnexNote } from "@/lib/import-enex";
import { parseGoogleDoc, type GoogleDocImport } from "@/lib/import-gdocs";
import {
  parseConfluenceExport,
  type ConfluenceImportResult,
  type ConfluencePage,
} from "@/lib/import-confluence";
import type { DBProperty } from "@/components/database/database-types";
import { fileCategory, iconForFile, isAllowedType, mimeForExt } from "@/lib/file-type";
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
 * Accepted file types per import entry, mirroring each `<input accept>`.
 * Validation runs through `file-type` (extension → MIME alongside the shared
 * allow-list matcher) rather than trusting `File.type`, which browsers leave
 * blank on many systems.
 */
const IMPORT_ALLOW: Record<string, readonly string[]> = {
  markdown: [".md", ".markdown", ".txt"],
  csv: [".csv"],
  trello: [".json"],
  asana: [".json"],
  // `.enex` has no MIME in the shared table, so `mimeForExt` resolves it to the
  // `application/octet-stream` fallback whose category is `"other"`.
  enex: ["other"],
  html: [".html", ".htm"],
  zip: [".zip"],
  docx: [".docx"],
  audio: ["audio/*"],
};

/** Lower-cased extension of a file name, or "" when it has none. */
function fileExt(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** MIME the app infers for a picked file from its extension (never `File.type`). */
function importMime(file: File): string {
  return mimeForExt(fileExt(file.name));
}

/**
 * Reject a picked file whose type is outside `allow` with a message naming the
 * file, its detected category and the expected rules. Returns `true` when the
 * caller may proceed with the import.
 */
function acceptImportFile(file: File, allow: readonly string[]): boolean {
  if (isAllowedType(importMime(file), { allow })) return true;
  const category = capitalize(fileCategory(file.name));
  toast.error(`Unsupported file type: ${file.name} (${category}). Expected ${allow.join(", ")}.`);
  return false;
}

/** Inline annotation for a picked file: its glyph and detected category. */
function FileTypeBadge({ name }: { name: string }) {
  return (
    <span
      data-testid="import-file-type"
      className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-muted"
    >
      <span aria-hidden>{iconForFile(name)}</span>
      {capitalize(fileCategory(name))}
    </span>
  );
}

/* ------------------------------------------------ Asana → database payload */

/** Narrow an unknown value to a plain record, or `null`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string field of a stored property value (e.g. `{ text }`), or `null`. */
function stringField(value: unknown, key: string): string | null {
  const field = asRecord(value)?.[key];
  return typeof field === "string" ? field : null;
}

/** A finite-number field of a stored property value (e.g. `{ number }`). */
function numberField(value: unknown, key: string): number | null {
  const field = asRecord(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

/** A boolean field of a stored property value (e.g. `{ checked }`). */
function booleanField(value: unknown, key: string): boolean | null {
  const field = asRecord(value)?.[key];
  return typeof field === "boolean" ? field : null;
}

/** A string-array field of a stored property value (e.g. `{ names }`). */
function stringListField(value: unknown, key: string): string[] {
  const field = asRecord(value)?.[key];
  return Array.isArray(field)
    ? field.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Fold an Asana property type onto a type the CSV create path can persist
 * (`CsvCreatePropertyType`). Asana's richer columns — STATUS, SELECT,
 * MULTI_SELECT and PEOPLE — have no option config on that path, so they are
 * carried as TEXT, keeping every option/name value instead of dropping it.
 */
function asanaCsvType(type: string): CsvCreatePropertyType {
  switch (type) {
    case "NUMBER":
      return "NUMBER";
    case "DATE":
      return "DATE";
    case "CHECKBOX":
      return "CHECKBOX";
    case "URL":
      return "URL";
    case "EMAIL":
      return "EMAIL";
    default:
      return "TEXT";
  }
}

/** Display name of a select/multi-select option id, falling back to the id. */
function asanaOptionName(property: DBProperty, optionId: string): string {
  const options = property.config?.options ?? [];
  return options.find((option) => option.id === optionId)?.name ?? optionId;
}

/** Flatten one Asana property value into a CSV cell (never throws). */
function asanaCellText(property: DBProperty, value: unknown): string {
  switch (property.type) {
    case "NUMBER": {
      const number = numberField(value, "number");
      return number === null ? "" : String(number);
    }
    case "CHECKBOX": {
      const checked = booleanField(value, "checked");
      return checked === null ? "" : checked ? "true" : "false";
    }
    case "DATE":
      return stringField(value, "start") ?? "";
    case "SELECT":
    case "STATUS": {
      const optionId = stringField(value, "optionId");
      return optionId ? asanaOptionName(property, optionId) : "";
    }
    case "MULTI_SELECT":
      return stringListField(value, "optionIds")
        .map((optionId) => asanaOptionName(property, optionId))
        .join(", ");
    case "PEOPLE":
      return stringListField(value, "names").join(", ");
    default:
      return stringField(value, "text") ?? "";
  }
}

/**
 * The `importCsvDatabaseAction` payload for a parsed Asana project: one column
 * per property (first = primary Name) and one CSV row per task.
 */
function buildAsanaPayload(parsed: AsanaImportResult): {
  title: string;
  properties: CreatePropertyDescriptor[];
  csv: string;
} {
  const properties: CreatePropertyDescriptor[] = parsed.properties.map((property) => ({
    id: property.id,
    name: property.name,
    type: asanaCsvType(property.type),
  }));
  const header = parsed.properties.map((property) => property.name);
  const rows = parsed.rows.map((row) =>
    parsed.properties.map((property) => {
      const entry = row.propertyValues.find((value) => value.propertyId === property.id);
      return entry ? asanaCellText(property, entry.value) : "";
    }),
  );
  return {
    title: parsed.meta.projectName || "Asana project",
    properties,
    csv: matrixToCsv(header, rows),
  };
}

/* ------------------------------------------ Format import preview (shared) */

/** A parsed Asana / Evernote / Google Docs / Confluence file awaiting confirm. */
type FormatDraft =
  | { kind: "asana"; fileName: string; parsed: AsanaImportResult }
  | { kind: "enex"; fileName: string; notes: EnexNote[] }
  | { kind: "gdocs"; fileName: string; html: string; parsed: GoogleDocImport }
  | { kind: "confluence"; fileName: string; html: string; parsed: ConfluenceImportResult };

/** Bounds the preview lists so a large export renders a short summary. */
const PREVIEW_ITEMS = 5;

type FormatPreview = {
  title: string;
  fileName: string;
  counts: string;
  note: string;
  warnings: string[];
  chipsHeading: string;
  chips: { id: string; label: string }[];
  itemsHeading: string;
  items: { id: string; label: string }[];
  itemCount: number;
};

/** Depth-first page titles for the Confluence preview. */
function confluenceTitles(pages: readonly ConfluencePage[]): string[] {
  const titles: string[] = [];
  for (const page of pages) {
    titles.push(page.props.title);
    titles.push(...confluenceTitles(page.children));
  }
  return titles;
}

/** Honest, human-readable preview of what a format draft will create. */
function formatPreview(draft: FormatDraft): FormatPreview {
  switch (draft.kind) {
    case "asana": {
      const { meta, properties, rows } = draft.parsed;
      const warnings: string[] = [];
      const skipped = meta.skippedMalformedTasks + meta.skippedCustomFieldValues;
      if (skipped > 0) warnings.push(`${skipped} Asana task values were skipped.`);
      if (meta.unmappedCustomFieldTypes.length > 0) {
        warnings.push(`Unmapped custom-field types: ${meta.unmappedCustomFieldTypes.join(", ")}.`);
      }
      return {
        title: meta.projectName,
        fileName: draft.fileName,
        counts: `${meta.tasks} tasks · ${meta.sections} sections · ${meta.customFields} custom fields`,
        note: "Status, select, tag and people columns import as text. Each task becomes a row.",
        warnings,
        chipsHeading: "Columns",
        chips: properties.map((property) => ({
          id: property.id,
          label: `${property.name} · ${property.type}`,
        })),
        itemsHeading: "First rows",
        items: rows.slice(0, PREVIEW_ITEMS).map((row) => ({ id: row.id, label: row.title })),
        itemCount: rows.length,
      };
    }
    case "enex": {
      const attachments = draft.notes.reduce((total, note) => total + note.resources.length, 0);
      return {
        title: "Evernote notes",
        fileName: draft.fileName,
        counts: `${draft.notes.length} notes · ${attachments} attachments`,
        note: "Each note imports as its own page.",
        warnings: [],
        chipsHeading: "",
        chips: [],
        itemsHeading: "Notes",
        items: draft.notes
          .slice(0, PREVIEW_ITEMS)
          .map((note, index) => ({ id: `note-${index}`, label: note.title })),
        itemCount: draft.notes.length,
      };
    }
    case "gdocs": {
      const { meta, blocks } = draft.parsed;
      return {
        title: meta.title ?? "Google Docs document",
        fileName: draft.fileName,
        counts: `${meta.headings} headings · ${meta.paragraphs} paragraphs · ${meta.lists} lists · ${meta.tables} tables`,
        note: `${meta.images} images become links · ${meta.links} links kept.`,
        warnings: meta.dropped.map((tag) => `Unsupported element <${tag}> will be dropped.`),
        chipsHeading: "",
        chips: [],
        itemsHeading: "Blocks",
        items: blocks
          .slice(0, PREVIEW_ITEMS)
          .map((block, index) => ({ id: `block-${index}`, label: block.type ?? "block" })),
        itemCount: blocks.length,
      };
    }
    case "confluence": {
      const { meta, pages } = draft.parsed;
      const titles = confluenceTitles(pages);
      return {
        title: meta.spaceKey ? `Confluence space ${meta.spaceKey}` : "Confluence export",
        fileName: draft.fileName,
        counts: `${meta.pages} pages · ${meta.blocks} blocks`,
        note: `${meta.images} images · ${meta.links} links · ${meta.pageRefs} page references.`,
        warnings: meta.warnings,
        chipsHeading: "",
        chips: [],
        itemsHeading: "Pages",
        items: titles
          .slice(0, PREVIEW_ITEMS)
          .map((title, index) => ({ id: `page-${index}`, label: title })),
        itemCount: titles.length,
      };
    }
  }
}

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
  fileName: string;
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

  /**
   * File name currently being submitted by a sidebar picker, or null when
   * idle. Drives the `import-progress` status region for the whole upload
   * (the actions expose no byte-level progress, so this stays indeterminate).
   */
  const [activeImport, setActiveImport] = useState<string | null>(null);

  /**
   * Run a file-submit import inside the sidebar's existing `startTransition`
   * while surfacing `label` in the progress region for the duration of `task`.
   * Callers have already run `acceptImportFile`, so validation is unchanged.
   */
  const runImport = (label: string, task: () => Promise<void>) => {
    setActiveImport(label);
    startTransition(async () => {
      try {
        await task();
      } finally {
        setActiveImport(null);
      }
    });
  };

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () =>
      runImport(file.name, async () => {
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
          toast.success(`${iconForFile(file.name)} Imported ${file.name}`);
          router.push(`/w/${workspace.slug}/${result.id}`);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
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
        fileName: file.name,
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
        toast.success(`${iconForFile(draft.fileName)} Imported Trello board “${draft.boardName}”`);
        setTrelloDraft(null);
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const onImportZip = (file: File) =>
    runImport(file.name, async () => {
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
        toast.success(`${iconForFile(file.name)} Imported archive`);
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  const docxInputRef = useRef<HTMLInputElement | null>(null);

  const onImportDocx = (file: File) =>
    runImport(file.name, async () => {
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
        toast.success(`${iconForFile(file.name)} Imported Word document`);
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  // --- Asana / Evernote / Google Docs / Confluence preview ------------------
  // Each of these parses the picked file with the pure parser the library ships
  // (`import-asana` / `import-enex` / `import-gdocs` / `import-confluence`),
  // shows a preview dialog, then submits on confirm. Google Docs and Confluence
  // reuse `importHtmlAction` (it detects a Confluence export server-side);
  // Asana folds onto the CSV create-database path and Evernote creates one page
  // per note via `importMarkdownAction`.
  const asanaInputRef = useRef<HTMLInputElement | null>(null);
  const enexInputRef = useRef<HTMLInputElement | null>(null);
  const gdocsInputRef = useRef<HTMLInputElement | null>(null);
  const confluenceInputRef = useRef<HTMLInputElement | null>(null);
  const [formatDraft, setFormatDraft] = useState<FormatDraft | null>(null);
  const [formatPending, startFormatTransition] = useTransition();

  const onImportAsana = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(reader.result ?? ""));
      } catch {
        toast.error("That file is not valid JSON.");
        return;
      }
      const parsed = parseAsanaExport(raw);
      if (parsed.rows.length === 0) {
        toast.error("No tasks found — is this an Asana export?");
        return;
      }
      setFormatDraft({ kind: "asana", fileName: file.name, parsed });
    };
    reader.readAsText(file);
  };

  const onImportEnex = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const notes = parseEnex(String(reader.result ?? ""));
      if (notes.length === 0) {
        toast.error("No notes found — is this an Evernote .enex export?");
        return;
      }
      setFormatDraft({ kind: "enex", fileName: file.name, notes });
    };
    reader.readAsText(file);
  };

  const onImportHtml = (file: File, kind: "gdocs" | "confluence") => {
    const reader = new FileReader();
    reader.onload = () => {
      const html = String(reader.result ?? "");
      if (kind === "confluence") {
        const parsed = parseConfluenceExport({ html });
        if (parsed.pages.length === 0) {
          toast.error("That HTML export contained no pages.");
          return;
        }
        setFormatDraft({ kind: "confluence", fileName: file.name, html, parsed });
        return;
      }
      const parsed = parseGoogleDoc({ html });
      if (parsed.blocks.length === 0) {
        toast.error("That HTML document contained no importable content.");
        return;
      }
      setFormatDraft({ kind: "gdocs", fileName: file.name, html, parsed });
    };
    reader.readAsText(file);
  };

  const confirmFormat = () => {
    const draft = formatDraft;
    if (!draft) return;
    startFormatTransition(async () => {
      if (draft.kind === "asana") {
        const payload = buildAsanaPayload(draft.parsed);
        const outcome = await safeAction(() =>
          importCsvDatabaseAction({
            workspaceId: workspace.id,
            parentId: null,
            title: payload.title,
            properties: payload.properties,
            csv: payload.csv,
          }),
        );
        if (!outcome.ok) {
          toast.error(outcome.error);
          return;
        }
        const result = outcome.value;
        if ("ok" in result) {
          toast.success(
            `${iconForFile(draft.fileName)} Imported ${result.counts.imported} Asana tasks`,
          );
          setFormatDraft(null);
          router.push(`/w/${workspace.slug}/${result.id}`);
          router.refresh();
        } else {
          toast.error(result.error);
        }
        return;
      }

      if (draft.kind === "enex") {
        setActiveImport(draft.fileName);
        try {
          let lastId = "";
          let imported = 0;
          for (const note of draft.notes) {
            const outcome = await safeAction(() =>
              importMarkdownAction({
                workspaceId: workspace.id,
                filename: `${note.title}.md`,
                markdown: note.content,
              }),
            );
            if (!outcome.ok) {
              toast.error(outcome.error);
              return;
            }
            const result = outcome.value;
            if ("ok" in result) {
              lastId = result.id;
              imported += 1;
            }
          }
          if (imported === 0) {
            toast.error("No Evernote notes were imported.");
            return;
          }
          toast.success(
            `${iconForFile(draft.fileName)} Imported ${imported} Evernote note${imported === 1 ? "" : "s"}`,
          );
          setFormatDraft(null);
          if (lastId) router.push(`/w/${workspace.slug}/${lastId}`);
          router.refresh();
        } finally {
          setActiveImport(null);
        }
        return;
      }

      const outcome = await safeAction(() =>
        importHtmlAction({
          workspaceId: workspace.id,
          parentId: null,
          html: draft.html,
          filename: draft.fileName,
          spaceKey: draft.kind === "confluence" ? draft.parsed.meta.spaceKey : null,
        }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const result = outcome.value;
      if ("ok" in result) {
        toast.success(
          `${iconForFile(draft.fileName)} Imported ${result.pages} page${result.pages === 1 ? "" : "s"}`,
        );
        setFormatDraft(null);
        router.push(`/w/${workspace.slug}/${result.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const formatPreviewData = formatDraft ? formatPreview(formatDraft) : null;

  const transcribeInputRef = useRef<HTMLInputElement | null>(null);

  const onTranscribe = (file: File) =>
    runImport(file.name, async () => {
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
        toast.success(`${iconForFile(file.name)} Transcript added`);
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
      {activeImport !== null && (
        <div
          data-testid="import-progress"
          aria-live="polite"
          className="mb-1 flex items-center gap-2 rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-muted"
        >
          <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
          <span role="status" className="truncate">
            {t(locale, "importing")} {activeImport}
          </span>
        </div>
      )}
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
          if (file && acceptImportFile(file, IMPORT_ALLOW.markdown)) onImportFile(file);
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
          if (file && acceptImportFile(file, IMPORT_ALLOW.csv)) openCsv(file);
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
          if (file && acceptImportFile(file, IMPORT_ALLOW.trello)) onImportTrello(file);
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
          if (file && acceptImportFile(file, IMPORT_ALLOW.zip)) onImportZip(file);
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
          if (file && acceptImportFile(file, IMPORT_ALLOW.docx)) onImportDocx(file);
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
        onClick={() => asanaInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import Asana (JSON)
      </button>
      <input
        ref={asanaInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && acceptImportFile(file, IMPORT_ALLOW.asana)) onImportAsana(file);
        }}
      />
      <button
        type="button"
        onClick={() => enexInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import Evernote (.enex)
      </button>
      <input
        ref={enexInputRef}
        type="file"
        accept=".enex"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && acceptImportFile(file, IMPORT_ALLOW.enex)) onImportEnex(file);
        }}
      />
      <button
        type="button"
        onClick={() => gdocsInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import Google Docs (.html)
      </button>
      <input
        ref={gdocsInputRef}
        type="file"
        accept=".html,.htm,text/html"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && acceptImportFile(file, IMPORT_ALLOW.html)) onImportHtml(file, "gdocs");
        }}
      />
      <button
        type="button"
        onClick={() => confluenceInputRef.current?.click()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        Import Confluence (.html)
      </button>
      <input
        ref={confluenceInputRef}
        type="file"
        accept=".html,.htm,text/html"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && acceptImportFile(file, IMPORT_ALLOW.html)) onImportHtml(file, "confluence");
        }}
      />
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
          if (file && acceptImportFile(file, IMPORT_ALLOW.audio)) onTranscribe(file);
        }}
      />

      {/* R23.2 — CSV → mapping step → create database. */}
      <Dialog open={csvDraft !== null} onOpenChange={(next) => !next && setCsvDraft(null)}>
        <DialogContent className="max-w-2xl p-6" aria-describedby={undefined}>
          {csvDraft && (
            <div data-testid="csv-mapping-dialog">
              <h2 className="text-lg font-semibold">{t(locale, "importCsv")}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                <span className="truncate">{csvDraft.fileName}</span>
                <FileTypeBadge name={csvDraft.fileName} />
                <span>
                  {csvDraft.rows.length} rows · {csvDraft.headers.length} columns
                </span>
              </div>

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
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{trelloDraft.boardName}</h2>
                <FileTypeBadge name={trelloDraft.fileName} />
              </div>
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

      {/* Asana / Evernote / Google Docs / Confluence — parse preview → submit. */}
      <Dialog open={formatDraft !== null} onOpenChange={(next) => !next && setFormatDraft(null)}>
        <DialogContent className="max-w-2xl p-6" aria-describedby={undefined}>
          {formatPreviewData && (
            <div data-testid="format-import-preview">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{formatPreviewData.title}</h2>
                <FileTypeBadge name={formatPreviewData.fileName} />
              </div>
              <p className="mt-1 text-sm text-muted">{formatPreviewData.counts}</p>
              <p className="mt-1 text-sm text-muted">{formatPreviewData.note}</p>

              {formatPreviewData.warnings.length > 0 && (
                <ul
                  role="alert"
                  className="mt-3 space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-600"
                >
                  {formatPreviewData.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}

              {formatPreviewData.chips.length > 0 && (
                <>
                  <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">
                    {formatPreviewData.chipsHeading}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {formatPreviewData.chips.map((chip) => (
                      <span
                        key={chip.id}
                        className="rounded border border-border px-2 py-0.5 text-xs text-muted"
                      >
                        {chip.label}
                      </span>
                    ))}
                  </div>
                </>
              )}

              {formatPreviewData.items.length > 0 && (
                <>
                  <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">
                    {formatPreviewData.itemsHeading}
                  </p>
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {formatPreviewData.items.map((item) => (
                      <li key={item.id} className="truncate text-muted">
                        {item.label}
                      </li>
                    ))}
                    {formatPreviewData.itemCount > formatPreviewData.items.length && (
                      <li className="text-muted">
                        …and {formatPreviewData.itemCount - formatPreviewData.items.length} more
                      </li>
                    )}
                  </ul>
                </>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setFormatDraft(null)}
                  className="h-9 rounded border border-border px-3 text-sm text-muted hover:bg-surface-2"
                >
                  {t(locale, "cancel")}
                </button>
                <button
                  type="button"
                  disabled={formatPending}
                  onClick={confirmFormat}
                  className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
                >
                  {formatPending ? t(locale, "importing") : t(locale, "importAction")}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

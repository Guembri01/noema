"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  BookMarked,
  BookOpen,
  Database as DatabaseIcon,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType,
  Globe,
  KanbanSquare,
  ListChecks,
  Music,
  StickyNote,
  Upload,
  type LucideIcon,
} from "lucide-react";

import { Sheet } from "@/components/ui/sheet";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Select, type SelectOption } from "@/components/ui/select";
import { Field, Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  importCsvDatabaseAction,
  importDocxAction,
  importMarkdownAction,
  importTrelloAction,
  importZipAction,
} from "@/server/actions/import";
import { importHtmlAction } from "@/server/actions/import-formats";
import { importPdfTextAction } from "@/server/actions/import-pdf";
import { csvToMatrix, matrixToCsv } from "@/lib/serialize";
import {
  buildCreatePlan,
  detectDuplicateHeaders,
  placeholderFor,
  suggestPropertyMapping,
  type CreatePropertyDescriptor,
  type InferredColumnType,
} from "@/lib/csv-mapping";
import { parseTrelloBoard } from "@/lib/trello-import";
import { parseAsanaExport } from "@/lib/import-asana";
import { parseEnex } from "@/lib/import-enex";
import { parseGoogleDoc } from "@/lib/import-gdocs";
import { parseConfluenceExport, type ConfluencePage } from "@/lib/import-confluence";
import { assembleDoc, describeImport, type PdfBlock } from "@/lib/pdf-import";
import { extractedTextToPages } from "@/lib/pdf-import-blocks";
import type { DBProperty } from "@/components/database/database-types";
import { fileCategory, iconForFile, isAllowedType, mimeForExt } from "@/lib/file-type";
import { t } from "@/lib/i18n";
import type { ImportCounts } from "@/lib/importers";
import { safeAction } from "@/lib/actions-client";

type StartTransition = (callback: () => void) => void;

type ImportSectionProps = {
  workspace: { id: string; slug: string };
  addPage: (parentId: string | null, type: "PAGE" | "DATABASE") => void;
  locale: string;
  startTransition: StartTransition;
  onOpenNotion: () => void;
};

/* ==========================================================================
 * Source catalogue (pure)
 *
 * The grid of import sources is data, not JSX: every card carries its icon,
 * a one-line description and the allow-list the file picker validates against.
 * Keeping it here means the picker, the tests and the panel all read the same
 * list — there is no second copy to drift.
 * ========================================================================== */

export type ImportSourceId =
  | "notion"
  | "trello"
  | "csv"
  | "markdown"
  | "html"
  | "asana"
  | "enex"
  | "gdocs"
  | "confluence"
  | "pdf"
  | "docx"
  | "zip"
  | "audio";

/** How the source is imported: through an API, a column mapping, or as-is. */
export type ImportSourceKind = "api" | "tabular" | "document";

export type ImportSourceDef = {
  id: ImportSourceId;
  label: string;
  /** One-line description shown under the title. */
  description: string;
  kind: ImportSourceKind;
  icon: LucideIcon;
  /** `accept` attribute for the hidden `<input type="file">`. */
  accept: string;
  /** Short hint under the drop-zone title. */
  acceptHint: string;
  /** Allow-list passed to `acceptImportFile` / `isAllowedType`. */
  allow: readonly string[];
};

/** Sources the picker must always offer, in order (spec wave 2, §1). */
export const REQUIRED_SOURCE_IDS: readonly ImportSourceId[] = [
  "notion",
  "trello",
  "csv",
  "markdown",
  "html",
  "asana",
  "enex",
  "gdocs",
  "confluence",
  "pdf",
];

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
  // The PDF importer runs the text-layer engine on extracted text (the
  // dependency set has no PDF parser), so it accepts a plain-text payload.
  pdfText: [".txt"],
};

/** Every importable source, in picker order. The required ten come first. */
export const IMPORT_SOURCES: readonly ImportSourceDef[] = [
  {
    id: "notion",
    label: "Notion",
    description: "Import pages straight from a Notion workspace via API token.",
    kind: "api",
    icon: BookOpen,
    accept: "",
    acceptHint: "No file — connect with an integration token",
    allow: [],
  },
  {
    id: "trello",
    label: "Trello",
    description: "Bring a Trello board JSON export in as a database.",
    kind: "document",
    icon: KanbanSquare,
    accept: ".json,application/json",
    acceptHint: ".json · board export",
    allow: IMPORT_ALLOW.trello,
  },
  {
    id: "csv",
    label: "CSV",
    description: "Turn a spreadsheet into a database with mapped fields.",
    kind: "tabular",
    icon: FileSpreadsheet,
    accept: ".csv,text/csv",
    acceptHint: ".csv · header row + data",
    allow: IMPORT_ALLOW.csv,
  },
  {
    id: "markdown",
    label: "Markdown",
    description: "Import .md / .markdown files as pages.",
    kind: "document",
    icon: FileType,
    accept: ".md,.markdown,.txt",
    acceptHint: ".md · .markdown · .txt",
    allow: IMPORT_ALLOW.markdown,
  },
  {
    id: "html",
    label: "HTML",
    description: "Import an HTML document, Google Docs export or Confluence page.",
    kind: "document",
    icon: FileCode,
    accept: ".html,.htm,text/html",
    acceptHint: ".html · .htm",
    allow: IMPORT_ALLOW.html,
  },
  {
    id: "asana",
    label: "Asana",
    description: "Turn an Asana JSON export into a task database.",
    kind: "tabular",
    icon: ListChecks,
    accept: ".json,application/json",
    acceptHint: ".json · project export",
    allow: IMPORT_ALLOW.asana,
  },
  {
    id: "enex",
    label: "Evernote",
    description: "Import Evernote notes from an .enex export.",
    kind: "document",
    icon: StickyNote,
    accept: ".enex",
    acceptHint: ".enex · Evernote export",
    allow: IMPORT_ALLOW.enex,
  },
  {
    id: "gdocs",
    label: "Google Docs",
    description: "Import a Google Docs “Download → Web page” file.",
    kind: "document",
    icon: BookMarked,
    accept: ".html,.htm,text/html",
    acceptHint: ".html · downloaded web page",
    allow: IMPORT_ALLOW.html,
  },
  {
    id: "confluence",
    label: "Confluence",
    description: "Import a Confluence space export as nested pages.",
    kind: "document",
    icon: Globe,
    accept: ".html,.htm,text/html",
    acceptHint: ".html · space export",
    allow: IMPORT_ALLOW.html,
  },
  {
    id: "pdf",
    label: "PDF",
    description: "Import a PDF's extracted text layer as a page.",
    kind: "document",
    icon: FileIcon,
    accept: ".txt,text/plain",
    acceptHint: ".txt · a PDF's text layer",
    allow: IMPORT_ALLOW.pdfText,
  },
  // Retained so no existing entry point is lost in the redesign.
  {
    id: "docx",
    label: "Word",
    description: "Import a Word .docx document as a page.",
    kind: "document",
    icon: FileText,
    accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    acceptHint: ".docx · Word document",
    allow: IMPORT_ALLOW.docx,
  },
  {
    id: "zip",
    label: "Archive",
    description: "Import a Markdown archive (.zip) as a page tree.",
    kind: "document",
    icon: FileArchive,
    accept: ".zip,application/zip",
    acceptHint: ".zip · Markdown archive",
    allow: IMPORT_ALLOW.zip,
  },
  {
    id: "audio",
    label: "Audio",
    description: "Transcribe an audio file into a page.",
    kind: "document",
    icon: Music,
    accept: "audio/*",
    acceptHint: "audio/* · transcribed",
    allow: IMPORT_ALLOW.audio,
  },
];

/** Look up a source by id (total: unknown ids resolve to `null`). */
export function importSourceById(id: string | null | undefined): ImportSourceDef | null {
  if (!id) return null;
  return IMPORT_SOURCES.find((source) => source.id === id) ?? null;
}

/* ==========================================================================
 * Steps (pure)
 * ========================================================================== */

export type ImportStepId = "choose" | "map" | "preview" | "import";

/** The canonical step order shown in the panel header. */
export const IMPORT_STEPS: readonly ImportStepId[] = ["choose", "map", "preview", "import"];

/** Human label for a step (kept as data so the tests can pin it). */
export function importStepLabel(step: ImportStepId): string {
  switch (step) {
    case "choose":
      return "Choose file";
    case "map":
      return "Map fields";
    case "preview":
      return "Preview";
    case "import":
      return "Import";
  }
}

/** 0-based index of a step in {@link IMPORT_STEPS}. */
export function stepIndex(step: ImportStepId): number {
  return IMPORT_STEPS.indexOf(step);
}

/** The next step, or `import` at the end (total). */
export function nextImportStep(step: ImportStepId): ImportStepId {
  return IMPORT_STEPS[Math.min(IMPORT_STEPS.length - 1, stepIndex(step) + 1)];
}

/** The previous step, or `choose` at the start (total). */
export function prevImportStep(step: ImportStepId): ImportStepId {
  return IMPORT_STEPS[Math.max(0, stepIndex(step) - 1)];
}

export type StepGateContext = {
  hasDraft: boolean;
  kind: ImportSourceKind;
  includedColumns: number;
};

/**
 * Whether the panel may advance past `step`. `choose` needs a parsed draft;
 * `map` additionally needs at least one column for a tabular source; the
 * terminal `import` step never advances (it holds the result).
 */
export function canAdvanceStep(step: ImportStepId, ctx: StepGateContext): boolean {
  if (step === "import") return false;
  if (!ctx.hasDraft) return false;
  if (step === "map" && ctx.kind === "tabular" && ctx.includedColumns === 0) return false;
  return true;
}

/* ==========================================================================
 * Detected columns → property suggestions (pure)
 * ========================================================================== */

/** One source column offered in the mapping table. */
export type ImportColumnSuggestion = {
  /** Original header text (may be empty for an unnamed column). */
  header: string;
  suggestedType: InferredColumnType;
  /** Set when the header matched an existing property by name. */
  matchesExistingId?: string;
  /** 0..1 — 1 for a name match, otherwise the type heuristic's confidence. */
  confidence: number;
  /** Up to three sample cells, for the mapping table's secondary line. */
  sample: string[];
};

/** How many rows the type heuristic samples (bounded for large files). */
const SAMPLE_ROWS = 50;
/** How many sample cells the mapping table shows per column. */
const SAMPLE_CELLS = 3;

/**
 * Suggest a destination for every detected column, reusing the pure CSV
 * mapping core (`suggestPropertyMapping`) so the wizard and the create payload
 * can never disagree. Adds a short sample of the column's values for the UI.
 */
export function suggestImportColumns(
  headers: readonly string[],
  sampleRows: readonly string[][],
  existing: readonly { id: string; name: string; type: string }[] = [],
): ImportColumnSuggestion[] {
  const mapping = suggestPropertyMapping([...headers], sampleRows.map((row) => [...row]), [
    ...existing,
  ]);
  return mapping.map((entry, index) => ({
    header: entry.header,
    suggestedType: entry.suggestedType,
    ...(entry.matchesExistingId ? { matchesExistingId: entry.matchesExistingId } : {}),
    confidence: entry.confidence,
    sample: sampleRows
      .slice(0, SAMPLE_CELLS)
      .map((row) => row[index] ?? "")
      .filter((value) => value !== ""),
  }));
}

/** Types the map step can choose, in display order. */
export const MAPPING_TYPES: readonly InferredColumnType[] = [
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "url",
  "email",
];

/** The `Select` value representing one column's current destination. */
export function mappingChoiceValue(
  column: ImportColumnSuggestion,
  include: boolean,
  type: InferredColumnType,
): string {
  if (!include) return "skip";
  if (column.matchesExistingId) return `map:${column.matchesExistingId}`;
  return type;
}

/**
 * Apply a mapping `Select` choice to a draft's index-aligned `include` / `types`
 * arrays. Accepts `"skip"`, `"map:<id>"` or a column type. Returns a new draft.
 */
export function applyMappingChoice(
  draft: ImportDraft,
  index: number,
  choice: string,
): ImportDraft {
  const include = [...draft.include];
  const types = [...draft.types];
  if (choice === "skip") {
    include[index] = false;
  } else if (choice.startsWith("map:")) {
    include[index] = true;
  } else {
    include[index] = true;
    types[index] = choice as InferredColumnType;
  }
  return { ...draft, include, types };
}

/** Options for one column's destination `Select`. */
export function destinationOptions(column: ImportColumnSuggestion): SelectOption[] {
  const options: SelectOption[] = [{ value: "skip", label: "Skip" }];
  if (column.matchesExistingId) {
    options.push({ value: `map:${column.matchesExistingId}`, label: "Map to existing" });
  }
  for (const type of MAPPING_TYPES) {
    options.push({ value: type, label: `Create as ${capitalize(type)}` });
  }
  return options;
}

/* ==========================================================================
 * Preview + duplicates (pure)
 * ========================================================================== */

/** How many data rows the preview table shows. */
export const PREVIEW_ROW_LIMIT = 8;
/** How many items a document preview lists. */
export const PREVIEW_ITEM_LIMIT = 8;

export type MatrixPreview = {
  rows: string[][];
  total: number;
  shown: number;
  truncated: boolean;
};

/** Truncate a row matrix to the first `limit` rows, reporting what was hidden. */
export function previewMatrix(rows: readonly string[][], limit = PREVIEW_ROW_LIMIT): MatrixPreview {
  const shown = Math.max(0, Math.floor(limit));
  const head = rows.slice(0, shown);
  return { rows: head, total: rows.length, shown: head.length, truncated: rows.length > head.length };
}

export type ItemPreview<T> = {
  items: T[];
  total: number;
  truncated: boolean;
};

/** Truncate an item list to the first `limit` entries. */
export function previewItems<T>(items: readonly T[], limit = PREVIEW_ITEM_LIMIT): ItemPreview<T> {
  const shown = Math.max(0, Math.floor(limit));
  const head = items.slice(0, shown);
  return { items: head, total: items.length, truncated: items.length > head.length };
}

/**
 * Count candidate duplicate rows: records whose trimmed cells all match an
 * earlier record. All-empty rows are ignored. This is the "candidate duplicates"
 * warning the import map step surfaces before the destructive write.
 */
export function detectCandidateDuplicates(rows: readonly (readonly string[])[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const cells = row.map((cell) => (cell ?? "").trim());
    if (cells.every((cell) => cell === "")) continue;
    const key = cells.join("\u0001");
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

/* ==========================================================================
 * Validation (pure)
 * ========================================================================== */

export type ImportIssue = {
  field: string;
  message: string;
  severity: "error" | "warning";
};

/**
 * Per-field validation for a parsed draft. Errors block the import (no title,
 * nothing mapped on a tabular source); warnings flag data loss the user should
 * acknowledge (candidate duplicates, dropped elements, duplicate headers).
 */
export function validateImportDraft(draft: ImportDraft, duplicateRows = 0): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (draft.title.trim() === "") {
    issues.push({
      field: "title",
      message: "Give the import a title.",
      severity: "error",
    });
  }
  if (draft.kind === "tabular" && draft.include.filter(Boolean).length === 0) {
    issues.push({
      field: "mapping",
      message: "Map at least one field or the import will create no columns.",
      severity: "error",
    });
  }
  if (duplicateRows > 0) {
    issues.push({
      field: "rows",
      message: `${duplicateRows} candidate duplicate ${duplicateRows === 1 ? "row" : "rows"} detected. Review before importing.`,
      severity: "warning",
    });
  }
  draft.warnings.forEach((warning, index) => {
    issues.push({ field: `warning-${index}`, message: warning, severity: "warning" });
  });
  return issues;
}

/* ==========================================================================
 * Summary (pure)
 * ========================================================================== */

export type ImportBadge = { label: string; tone: BadgeTone; count: number };

export type ImportSummary = {
  id: string;
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  badges: ImportBadge[];
};

/**
 * Normalise an importer's `ImportCounts` into the summary the result step shows
 * as `Badge` counts. `skipped` folds skipped columns and skipped cells together.
 */
export function summarizeImport(counts: ImportCounts, id: string): ImportSummary {
  const imported = Math.max(0, counts.imported);
  const skipped = Math.max(0, counts.skippedColumns + counts.skippedCells);
  const failed = Math.max(0, counts.failed);
  const badges: ImportBadge[] = [
    { label: "Imported", tone: "success", count: imported },
  ];
  if (skipped > 0) badges.push({ label: "Skipped", tone: "warning", count: skipped });
  if (failed > 0) badges.push({ label: "Failed", tone: "danger", count: failed });
  return { id, imported, skipped, failed, total: imported + skipped + failed, badges };
}

/* ==========================================================================
 * Draft model
 * ========================================================================== */

export type ImportPayload = {
  text?: string;
  html?: string;
  json?: string;
  markdown?: string;
  notes?: { title: string; content: string }[];
  file?: File;
};

export type ImportDraft = {
  sourceId: ImportSourceId;
  kind: ImportSourceKind;
  fileName: string;
  title: string;
  /** Detected columns (tabular sources; empty for documents). */
  columns: ImportColumnSuggestion[];
  /** Raw data rows, index-aligned with `columns`. */
  rows: string[][];
  /** Index-aligned with `columns`: whether a column is imported. */
  include: boolean[];
  /** Index-aligned with `columns`: the chosen create type. */
  types: InferredColumnType[];
  /** Preview items for document sources. */
  items: { id: string; label: string }[];
  /** Total item count for document sources (may exceed `items.length`). */
  itemCount: number;
  /** One-line "what this file contains" note. */
  note: string;
  /** Pre-import loss warnings (dropped elements, duplicate headers). */
  warnings: string[];
  /** Raw payload the confirm step hands to the matching server action. */
  payload: ImportPayload;
};

/* ==========================================================================
 * Small pure helpers
 * ========================================================================== */

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

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
  if (allow.length === 0) return true;
  if (isAllowedType(importMime(file), { allow })) return true;
  const category = capitalize(fileCategory(file.name));
  toast.error(`Unsupported file type: ${file.name} (${category}). Expected ${allow.join(", ")}.`);
  return false;
}

/** Page/database title from a file name (extension stripped, bounded). */
function titleFromName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  return stem.slice(0, 200) || "Imported";
}

/** Read a picked text file without trusting its MIME. */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsText(file);
  });
}

/** Inline annotation for a picked file: its glyph and detected category. */
function FileTypeBadge({ name }: { name: string }) {
  return (
    <span
      data-testid="import-file-type"
      className="inline-flex items-center gap-1 rounded-xs border border-border px-1.5 py-0.5 text-xs text-muted"
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

/* ------------------------------------------ document preview helpers (pure) */

/** Depth-first page titles for the Confluence preview. */
function confluenceTitles(pages: readonly ConfluencePage[]): string[] {
  const titles: string[] = [];
  for (const page of pages) {
    titles.push(page.props.title);
    titles.push(...confluenceTitles(page.children));
  }
  return titles;
}

/** One-line label for a recovered PDF block in the preview list. */
function pdfBlockLabel(block: PdfBlock): string {
  switch (block.type) {
    case "heading":
      return `H${block.level} · ${block.text}`;
    case "paragraph":
      return block.text;
    case "listItem":
      return `${block.ordered ? "1." : "•"} ${block.text}`;
    case "code":
      return `code · ${block.text.split("\n")[0] ?? ""}`;
    case "table": {
      const columns = block.rows[0]?.length ?? 0;
      return `table · ${block.rows.length}×${columns}`;
    }
  }
}

/** Trim + bound a preview label. */
function shortLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/* ==========================================================================
 * Parsing a picked file into a draft
 * ========================================================================== */

function documentDraft(
  source: ImportSourceDef,
  file: File,
  fields: Partial<Pick<ImportDraft, "title" | "items" | "itemCount" | "note" | "warnings" | "payload">>,
): ImportDraft {
  return {
    sourceId: source.id,
    kind: source.kind,
    fileName: file.name,
    title: fields.title ?? titleFromName(file.name),
    columns: [],
    rows: [],
    include: [],
    types: [],
    items: fields.items ?? [],
    itemCount: fields.itemCount ?? fields.items?.length ?? 0,
    note: fields.note ?? "",
    warnings: fields.warnings ?? [],
    payload: fields.payload ?? {},
  };
}

function tabularDraft(
  source: ImportSourceDef,
  file: File,
  title: string,
  headers: string[],
  rows: string[][],
): ImportDraft {
  const columns = suggestImportColumns(headers, rows.slice(0, SAMPLE_ROWS), []);
  const duplicates = detectDuplicateHeaders(headers);
  return {
    sourceId: source.id,
    kind: "tabular",
    fileName: file.name,
    title,
    columns,
    rows,
    include: columns.map(() => true),
    types: columns.map((column) => column.suggestedType),
    items: [],
    itemCount: rows.length,
    note: `${rows.length} ${rows.length === 1 ? "row" : "rows"} · ${headers.length} ${headers.length === 1 ? "column" : "columns"}`,
    warnings:
      duplicates.length > 0
        ? [`Duplicate column names: ${duplicates.join(", ")}. Rename the header row before importing.`]
        : [],
    payload: {},
  };
}

/**
 * Turn a picked file into a draft, reusing the same pure parsers the importers
 * already ship. Throws a message the caller surfaces when the file is not valid
 * for this source.
 */
async function buildDraft(source: ImportSourceDef, file: File): Promise<ImportDraft> {
  switch (source.id) {
    case "csv": {
      const text = await readFileText(file);
      const matrix = csvToMatrix(text);
      if (matrix.length < 2) throw new Error("CSV needs a header row and at least one data row.");
      return tabularDraft(source, file, titleFromName(file.name), matrix[0], matrix.slice(1));
    }
    case "asana": {
      const text = await readFileText(file);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      const parsed = parseAsanaExport(raw);
      if (parsed.rows.length === 0) throw new Error("No tasks found — is this an Asana export?");
      const headers = parsed.properties.map((property) => property.name);
      const rows = parsed.rows.map((row) =>
        parsed.properties.map((property) => {
          const entry = row.propertyValues.find((value) => value.propertyId === property.id);
          return entry ? asanaCellText(property, entry.value) : "";
        }),
      );
      return tabularDraft(
        source,
        file,
        parsed.meta.projectName || "Asana project",
        headers,
        rows,
      );
    }
    case "trello": {
      const text = await readFileText(file);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      const board = parseTrelloBoard(raw);
      if (board.properties.length === 0) {
        throw new Error("No lists found — is this a Trello board export?");
      }
      return documentDraft(source, file, {
        title: board.meta.boardName || "Trello board",
        items: board.rows
          .slice(0, PREVIEW_ITEM_LIMIT)
          .map((row) => ({ id: row.id, label: row.title })),
        itemCount: board.rows.length,
        note: `${board.meta.lists} lists · ${board.meta.cards} cards · ${board.meta.labels} labels`,
        payload: { json: text },
      });
    }
    case "markdown": {
      const text = await readFileText(file);
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (lines.length === 0) throw new Error("That file is empty.");
      return documentDraft(source, file, {
        items: lines
          .slice(0, PREVIEW_ITEM_LIMIT)
          .map((line, index) => ({ id: `md-${index}`, label: shortLabel(line) })),
        itemCount: lines.length,
        note: `${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
        payload: { markdown: text },
      });
    }
    case "html":
    case "gdocs": {
      const text = await readFileText(file);
      if (!text.trim()) throw new Error("That file is empty.");
      const parsed = parseGoogleDoc({ html: text });
      if (parsed.blocks.length === 0) {
        throw new Error("That HTML document contained no importable content.");
      }
      return documentDraft(source, file, {
        title: parsed.meta.title ?? titleFromName(file.name),
        items: parsed.blocks
          .slice(0, PREVIEW_ITEM_LIMIT)
          .map((block, index) => ({ id: `block-${index}`, label: block.type ?? "block" })),
        itemCount: parsed.blocks.length,
        note: `${parsed.meta.headings} headings · ${parsed.meta.paragraphs} paragraphs · ${parsed.meta.tables} tables`,
        warnings: parsed.meta.dropped.map((tag) => `Unsupported element <${tag}> will be dropped.`),
        payload: { html: text },
      });
    }
    case "confluence": {
      const text = await readFileText(file);
      if (!text.trim()) throw new Error("That file is empty.");
      const parsed = parseConfluenceExport({ html: text });
      if (parsed.pages.length === 0) throw new Error("That HTML export contained no pages.");
      const titles = confluenceTitles(parsed.pages);
      return documentDraft(source, file, {
        title: parsed.meta.spaceKey ? `Confluence space ${parsed.meta.spaceKey}` : "Confluence export",
        items: titles
          .slice(0, PREVIEW_ITEM_LIMIT)
          .map((title, index) => ({ id: `page-${index}`, label: shortLabel(title) })),
        itemCount: titles.length,
        note: `${parsed.meta.pages} pages · ${parsed.meta.blocks} blocks`,
        warnings: parsed.meta.warnings,
        payload: { html: text },
      });
    }
    case "enex": {
      const text = await readFileText(file);
      const notes = parseEnex(text);
      if (notes.length === 0) throw new Error("No notes found — is this an Evernote .enex export?");
      return documentDraft(source, file, {
        title: "Evernote notes",
        items: notes
          .slice(0, PREVIEW_ITEM_LIMIT)
          .map((note, index) => ({ id: `note-${index}`, label: shortLabel(note.title) })),
        itemCount: notes.length,
        note: `${notes.length} ${notes.length === 1 ? "note" : "notes"}`,
        payload: { notes: notes.map((note) => ({ title: note.title, content: note.content })) },
      });
    }
    case "pdf": {
      const text = await readFileText(file);
      if (!text.trim()) throw new Error("That file is empty — expected a PDF's extracted text.");
      const parsed = assembleDoc(extractedTextToPages(text));
      if (parsed.blocks.length === 0) {
        throw new Error("No text-layer content found — expected a PDF's extracted text.");
      }
      const summary = describeImport(parsed);
      return documentDraft(source, file, {
        title: parsed.title,
        items: parsed.blocks
          .slice(0, PREVIEW_ITEM_LIMIT)
          .map((block, index) => ({ id: `pdf-${index}`, label: shortLabel(pdfBlockLabel(block)) })),
        itemCount: parsed.blocks.length,
        note: `${summary.headings} headings · ${summary.paragraphs} paragraphs · ${summary.tables} tables`,
        warnings: parsed.warnings.map((warning) => warning.message),
        payload: { text },
      });
    }
    case "docx":
      return documentDraft(source, file, {
        note: "Word document — converted to structured content on import.",
        payload: { file },
      });
    case "zip":
      return documentDraft(source, file, {
        note: "Markdown archive — each entry becomes a page.",
        payload: { file },
      });
    case "audio":
      return documentDraft(source, file, {
        note: "Audio file — transcribed, then saved as a page.",
        payload: { file },
      });
    case "notion":
      throw new Error("Notion import uses the Notion dialog.");
  }
}

/* ==========================================================================
 * Presentation — picker grid
 * ========================================================================== */

/** Card classes for one source tile. Pure so the tokens are pinned by tests. */
export function sourceCardClass(): string {
  return cn(
    "focus-ring u-interactive u-surface group flex h-full flex-col items-start gap-1 rounded-lg",
    "border border-border bg-bg p-3 text-start",
    "hover:border-border-strong hover:bg-surface hover:shadow-2 hover:-translate-y-0.5",
    "motion-reduce:hover:translate-y-0",
    "disabled:cursor-not-allowed disabled:opacity-50",
  );
}

export function ImportSourceCard({
  source,
  onSelect,
}: {
  source: ImportSourceDef;
  onSelect: (id: ImportSourceId) => void;
}) {
  const Icon = source.icon;
  return (
    <button
      type="button"
      data-testid={`import-source-${source.id}`}
      onClick={() => onSelect(source.id)}
      className={sourceCardClass()}
    >
      <span
        aria-hidden
        className="grid size-8 place-items-center rounded-md bg-surface-2 text-accent u-colors group-hover:bg-accent-soft"
      >
        <Icon className="size-4" />
      </span>
      <span className="mt-1 w-full truncate text-sm font-medium text-fg">{source.label}</span>
      <span className="text-xs text-muted">{source.description}</span>
    </button>
  );
}

/** The grid of import sources. */
export function ImportSourceGrid({
  onSelect,
  sources = IMPORT_SOURCES,
  className,
}: {
  onSelect: (id: ImportSourceId) => void;
  sources?: readonly ImportSourceDef[];
  className?: string;
}) {
  return (
    <div
      data-testid="import-source-grid"
      role="group"
      aria-label="Import sources"
      className={cn("grid grid-cols-2 gap-2", className)}
    >
      {sources.map((source) => (
        <ImportSourceCard key={source.id} source={source} onSelect={onSelect} />
      ))}
    </div>
  );
}

/* ==========================================================================
 * Presentation — step header
 * ========================================================================== */

export function importStepState(
  step: ImportStepId,
  current: ImportStepId,
): "done" | "current" | "upcoming" {
  if (stepIndex(step) < stepIndex(current)) return "done";
  if (step === current) return "current";
  return "upcoming";
}

/** The progress-stepper header: numbered markers, connectors, `aria-current`. */
export function ImportSteps({
  step,
  steps = IMPORT_STEPS,
  className,
}: {
  step: ImportStepId;
  steps?: readonly ImportStepId[];
  className?: string;
}) {
  return (
    <ol data-testid="import-steps" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs", className)}>
      {steps.map((id, index) => {
        const state = importStepState(id, step);
        return (
          <li
            key={id}
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
              {importStepLabel(id)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ==========================================================================
 * Presentation — panel pieces
 * ========================================================================== */

/** Dashed drop zone with a drag-over state and a keyboard-reachable browse. */
export function ImportDropZone({
  source,
  onPickFile,
  disabled = false,
}: {
  source: ImportSourceDef;
  onPickFile: (file: File) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      data-testid="import-dropzone"
      data-over={over ? "true" : undefined}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onPickFile(file);
      }}
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center u-colors",
        over ? "border-accent bg-accent-soft" : "border-border-strong bg-surface",
        disabled && "opacity-50",
      )}
    >
      <Upload aria-hidden className="size-6 text-muted" />
      <p className="text-sm font-medium text-fg">Drop a file here</p>
      <p className="text-xs text-muted">{source.acceptHint}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        Browse files
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={source.accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onPickFile(file);
        }}
      />
    </div>
  );
}

function ImportFileCard({ draft, onRemove }: { draft: ImportDraft; onRemove: () => void }) {
  return (
    <div
      data-testid="import-file-card"
      className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-2 p-3"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-fg" title={draft.fileName}>
            {draft.fileName}
          </span>
          <FileTypeBadge name={draft.fileName} />
        </div>
        {draft.note ? <p className="mt-1 text-xs text-muted">{draft.note}</p> : null}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
        Replace
      </Button>
    </div>
  );
}

/** The mapping table: one row per detected column → destination `Select`. */
export function ImportMappingTable({
  draft,
  onMappingChange,
}: {
  draft: ImportDraft;
  onMappingChange: (index: number, choice: string) => void;
}) {
  return (
    <div data-testid="import-mapping" className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-2 py-1.5 font-medium">Source column</th>
            <th className="px-2 py-1.5 font-medium">Destination</th>
            <th className="px-2 py-1.5 font-medium">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {draft.columns.map((column, index) => {
            const label = column.header.trim() || placeholderFor(index);
            const value = mappingChoiceValue(column, draft.include[index], draft.types[index]);
            return (
              <tr key={`column-${index}`} className="border-t border-border align-top">
                <td className="px-2 py-1.5">
                  <span className="block truncate text-fg" title={label}>
                    {label}
                  </span>
                  {column.sample.length > 0 ? (
                    <span className="block truncate text-xs text-muted" title={column.sample.join(" · ")}>
                      {column.sample.join(" · ")}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-1.5">
                  <Select
                    size="sm"
                    searchable={false}
                    options={destinationOptions(column)}
                    value={value}
                    onChange={(next) => onMappingChange(index, next)}
                    aria-label={`Mapping for ${label}`}
                  />
                </td>
                <td className="px-2 py-1.5 tabular-nums text-muted">
                  {Math.round(column.confidence * 100)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The preview table: the first `PREVIEW_ROW_LIMIT` rows of included columns. */
export function ImportPreviewTable({
  draft,
  limit = PREVIEW_ROW_LIMIT,
}: {
  draft: ImportDraft;
  limit?: number;
}) {
  const included = draft.columns
    .map((column, index) => ({ column, index }))
    .filter(({ index }) => draft.include[index]);
  const preview = previewMatrix(draft.rows, limit);

  return (
    <div data-testid="import-preview">
      <div className="scrollbar-thin overflow-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {included.map(({ column, index }) => (
                <th key={`head-${index}`} className="whitespace-nowrap px-2 py-1.5 font-medium">
                  <span className="block max-w-40 truncate" title={column.header.trim() || placeholderFor(index)}>
                    {column.header.trim() || placeholderFor(index)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`} className="border-t border-border">
                {included.map(({ index }) => (
                  <td key={`cell-${rowIndex}-${index}`} className="px-2 py-1.5">
                    <span className="block max-w-40 truncate text-muted" title={row[index] ?? ""}>
                      {row[index] ?? ""}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-muted">
        {preview.truncated
          ? `Showing the first ${preview.shown} of ${preview.total} rows.`
          : `${preview.total} ${preview.total === 1 ? "row" : "rows"}.`}
      </p>
    </div>
  );
}

/** A simple list preview for document sources (notes, pages, blocks, files). */
export function ImportItemList({ draft }: { draft: ImportDraft }) {
  const preview = previewItems(draft.items);
  return (
    <div data-testid="import-preview">
      <ul className="space-y-0.5 rounded-md border border-border p-3 text-sm">
        {preview.items.map((item) => (
          <li key={item.id} className="truncate text-muted" title={item.label}>
            {item.label}
          </li>
        ))}
        {preview.truncated ? (
          <li className="text-muted">…and {preview.total - preview.items.length} more</li>
        ) : null}
      </ul>
    </div>
  );
}

/** The issues list: errors block, warnings flag data loss. */
export function ImportIssues({ issues }: { issues: readonly ImportIssue[] }) {
  if (issues.length === 0) return null;
  const errors = issues.filter((issue) => issue.severity === "error");
  return (
    <ul data-testid="import-issues" className="space-y-1">
      {issues.map((issue) => (
        <li
          key={issue.field}
          role={issue.severity === "error" ? "alert" : undefined}
          className={cn(
            "rounded-md border p-2 text-xs",
            issue.severity === "error"
              ? "border-danger bg-danger-soft text-danger"
              : "border-warning bg-warning-soft text-warning",
          )}
        >
          {issue.message}
        </li>
      ))}
      {errors.length > 0 ? <li className="sr-only">Fix the errors above to continue.</li> : null}
    </ul>
  );
}

/** The result summary: `Badge` counts plus the link to the imported content. */
export function ImportSummaryView({
  summary,
  onGoToPage,
}: {
  summary: ImportSummary;
  onGoToPage: () => void;
}) {
  return (
    <div data-testid="import-summary" className="flex flex-col gap-3" role="status">
      <div className="flex flex-wrap items-center gap-2">
        {summary.badges.map((badge) => (
          <Badge key={badge.label} tone={badge.tone} count={badge.count}>
            {badge.label}
          </Badge>
        ))}
      </div>
      {summary.id ? (
        <Button type="button" variant="primary" size="sm" onClick={onGoToPage} className="self-start">
          Go to imported page
        </Button>
      ) : null}
    </div>
  );
}

/* ==========================================================================
 * The import panel (Sheet)
 * ========================================================================== */

export type ImportPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ImportSourceDef | null;
  step: ImportStepId;
  draft: ImportDraft | null;
  locale: string;
  pending?: boolean;
  blocked?: boolean;
  error?: string;
  summary?: ImportSummary | null;
  issues?: readonly ImportIssue[];
  onPickFile: (file: File) => void;
  onRemoveFile: () => void;
  onTitleChange: (title: string) => void;
  onBack: () => void;
  onPrimary: () => void;
  onMappingChange: (index: number, choice: string) => void;
  onGoToPage: () => void;
};

function ImportStepHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{children}</h3>
  );
}

function ImportStepBody(props: ImportPanelProps) {
  const {
    source,
    step,
    draft,
    pending = false,
    error = "",
    summary = null,
    issues = [],
    onPickFile,
    onRemoveFile,
    onTitleChange,
    onMappingChange,
    onGoToPage,
    locale,
  } = props;
  if (!source) return null;

  if (step === "choose") {
    return (
      <div className="flex flex-col gap-4" data-testid="import-step-choose">
        <ImportDropZone source={source} onPickFile={onPickFile} disabled={pending} />
        {draft ? <ImportFileCard draft={draft} onRemove={onRemoveFile} /> : null}
        {error ? (
          <p role="alert" className="rounded-md border border-danger bg-danger-soft p-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (step === "map") {
    if (!draft) return null;
    if (draft.kind !== "tabular") {
      return (
        <div className="flex flex-col gap-4" data-testid="import-step-map">
          <EmptyState
            variant="compact"
            icon={<ListChecks className="size-4" />}
            title="No fields to map"
            description={`${source.label} imports as-is — the structure is detected automatically.`}
          />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4" data-testid="import-step-map">
        <Field id="import-title" label="Title">
          <Input
            id="import-title"
            value={draft.title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Imported database"
          />
        </Field>
        <ImportIssues issues={issues} />
        <div className="flex flex-col gap-2">
          <ImportStepHeading>Fields</ImportStepHeading>
          <ImportMappingTable draft={draft} onMappingChange={onMappingChange} />
        </div>
      </div>
    );
  }

  if (step === "preview") {
    if (!draft) return null;
    const tabular = draft.kind === "tabular";
    return (
      <div className="flex flex-col gap-4" data-testid="import-step-preview">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-fg" title={draft.title}>
            {draft.title}
          </span>
          <FileTypeBadge name={draft.fileName} />
        </div>
        {draft.note ? <p className="text-sm text-muted">{draft.note}</p> : null}
        <ImportIssues issues={issues} />
        <div className="flex flex-col gap-2">
          <ImportStepHeading>{tabular ? "First rows" : "Contents"}</ImportStepHeading>
          {tabular ? <ImportPreviewTable draft={draft} /> : <ImportItemList draft={draft} />}
        </div>
      </div>
    );
  }

  // step === "import"
  return (
    <div className="flex flex-col gap-4" data-testid="import-step-import" aria-live="polite">
      <ImportStepHeading>{pending ? t(locale, "importing") : "Result"}</ImportStepHeading>
      {pending ? (
        <>
          <Progress label={t(locale, "importing")} />
          <Skeleton variant="text" lines={2} />
        </>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-danger bg-danger-soft p-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {summary ? <ImportSummaryView summary={summary} onGoToPage={onGoToPage} /> : null}
    </div>
  );
}

/** The right-hand Sheet with the four-step import flow. */
export function ImportPanel(props: ImportPanelProps) {
  const { open, onOpenChange, source, step, draft, pending = false, blocked = false, summary = null } = props;
  if (!source) return null;

  const ctx: StepGateContext = {
    hasDraft: draft !== null,
    kind: source.kind,
    includedColumns: draft ? draft.include.filter(Boolean).length : 0,
  };
  const canPrimary =
    step === "import"
      ? !pending && summary !== null
      : !pending && !(step === "preview" && blocked) && canAdvanceStep(step, ctx);
  const primaryLabel =
    step === "choose" || step === "map"
      ? "Continue"
      : step === "preview"
        ? "Import"
        : "Go to page";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      size="lg"
      title={`Import from ${source.label}`}
      description={source.description}
      data-testid="import-panel"
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onBack}
            disabled={step === "choose" || pending}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            loading={pending && step === "import"}
            disabled={!canPrimary}
            onClick={props.onPrimary}
          >
            {primaryLabel}
          </Button>
        </div>
      }
    >
      <ImportSteps step={step} />
      <div className="mt-5">
        <ImportStepBody {...props} />
      </div>
    </Sheet>
  );
}

/* ==========================================================================
 * The orchestrating section
 * ========================================================================== */

export function ImportSection({
  workspace,
  addPage,
  locale,
  startTransition,
  onOpenNotion,
}: ImportSectionProps) {
  const router = useRouter();

  const [sourceId, setSourceId] = useState<ImportSourceId | null>(null);
  const [step, setStep] = useState<ImportStepId>("choose");
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const source = sourceId ? importSourceById(sourceId) : null;
  const duplicateRows = draft ? detectCandidateDuplicates(draft.rows) : 0;
  const issues = useMemo(
    () => (draft ? validateImportDraft(draft, duplicateRows) : []),
    [draft, duplicateRows],
  );
  const blocked = issues.some((issue) => issue.severity === "error");
  const skippedByUser = draft ? draft.include.filter((value) => !value).length : 0;
  const destructive = duplicateRows > 0 || (draft?.warnings.length ?? 0) > 0 || skippedByUser > 0;

  const openSource = (id: ImportSourceId) => {
    if (id === "notion") {
      onOpenNotion();
      return;
    }
    setSourceId(id);
    setStep("choose");
    setDraft(null);
    setError("");
    setSummary(null);
    setConfirmOpen(false);
  };

  const closePanel = (open: boolean) => {
    if (open) return;
    setSourceId(null);
    setStep("choose");
    setDraft(null);
    setError("");
    setSummary(null);
    setConfirmOpen(false);
  };

  const handleFile = (file: File) => {
    if (!source) return;
    if (!acceptImportFile(file, source.allow)) return;
    setError("");
    setSummary(null);
    void buildDraft(source, file)
      .then((next) => {
        setDraft(next);
        setStep("choose");
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : "Could not read that file.";
        setError(message);
        toast.error(message);
      });
  };

  const goToPage = () => {
    const id = summary?.id;
    closePanel(false);
    if (id) {
      router.push(`/w/${workspace.slug}/${id}`);
      router.refresh();
    }
  };

  const runImport = () => {
    const current = source;
    const active = draft;
    if (!current || !active) return;
    setPending(true);
    setError("");
    startTransition(() => {
      void executeImport(current, active, workspace.id)
        .then((outcome) => {
          if (outcome.error) {
            setError(outcome.error);
            toast.error(outcome.error);
            return;
          }
          if (outcome.summary) {
            setSummary(outcome.summary);
            toast.success("Import complete");
          }
        })
        .finally(() => setPending(false));
    });
  };

  const startImport = () => {
    setStep("import");
    runImport();
  };

  const onPrimary = () => {
    if (!source || !draft) return;
    if (step === "choose") {
      setStep("map");
      return;
    }
    if (step === "map") {
      setStep("preview");
      return;
    }
    if (step === "preview") {
      if (blocked || pending) return;
      if (destructive) {
        setConfirmOpen(true);
        return;
      }
      startImport();
      return;
    }
    if (step === "import" && summary) {
      goToPage();
    }
  };

  const onBack = () => {
    if (step === "import") return;
    setStep((current) => prevImportStep(current));
  };

  const onMappingChange = (index: number, choice: string) => {
    setDraft((current) => (current ? applyMappingChoice(current, index, choice) : current));
  };

  const open = sourceId !== null && sourceId !== "notion";

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <button
        type="button"
        onClick={() => addPage(null, "DATABASE")}
        className="focus-ring u-colors flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-2"
      >
        <DatabaseIcon className="h-4 w-4" aria-hidden />
        {t(locale, "newDatabase")}
      </button>
      <p className="px-2 text-xs font-medium uppercase tracking-wide text-muted">
        Import
      </p>
      <ImportSourceGrid onSelect={openSource} />

      <ImportPanel
        open={open}
        onOpenChange={closePanel}
        source={source}
        step={step}
        draft={draft}
        locale={locale}
        pending={pending}
        blocked={blocked}
        error={error}
        summary={summary}
        issues={issues}
        onPickFile={handleFile}
        onRemoveFile={() => setDraft(null)}
        onTitleChange={(title) =>
          setDraft((current) => (current ? { ...current, title } : current))
        }
        onBack={onBack}
        onPrimary={onPrimary}
        onMappingChange={onMappingChange}
        onGoToPage={goToPage}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="danger"
        title="Import anyway?"
        description="Some content will be skipped or could duplicate what is already there."
        confirmLabel="Import anyway"
        cancelLabel="Review"
        onConfirm={() => {
          setConfirmOpen(false);
          startImport();
        }}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {duplicateRows > 0 ? (
            <li>{duplicateRows} candidate duplicate {duplicateRows === 1 ? "row" : "rows"}.</li>
          ) : null}
          {skippedByUser > 0 ? (
            <li>{skippedByUser} {skippedByUser === 1 ? "column" : "columns"} will be skipped.</li>
          ) : null}
          {draft?.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

/* ==========================================================================
 * Confirm step — the only place that touches the server actions
 * ========================================================================== */

type ImportOutcome = { summary?: ImportSummary; error?: string };

/** Map a reviewed tabular draft onto the create-database payload. */
function buildDatabasePayload(draft: ImportDraft): {
  properties: CreatePropertyDescriptor[];
  csv: string;
} {
  const selected = draft.columns
    .map((column, index) => ({ column, index }))
    .filter(({ index }) => draft.include[index]);
  const creatable = selected.filter(({ column }) => !column.matchesExistingId);
  const properties = buildCreatePlan(
    creatable.map(({ column, index }) => ({
      header: column.header,
      suggestedType: draft.types[index],
      ...(column.matchesExistingId ? { matchesExistingId: column.matchesExistingId } : {}),
      confidence: column.confidence,
    })),
  );
  const rows = draft.rows.map((row) => creatable.map(({ index }) => row[index] ?? ""));
  const csv = matrixToCsv(
    properties.map((property) => property.name),
    rows,
  );
  return { properties, csv };
}

const ZERO_COUNTS: ImportCounts = { imported: 0, skippedColumns: 0, skippedCells: 0, failed: 0 };

/** Run the import for a source, normalising every action's result. */
async function executeImport(
  source: ImportSourceDef,
  draft: ImportDraft,
  workspaceId: string,
): Promise<ImportOutcome> {
  switch (source.id) {
    case "csv":
    case "asana": {
      const { properties, csv } = buildDatabasePayload(draft);
      if (properties.length === 0) return { error: "Choose at least one column to import." };
      const outcome = await safeAction(() =>
        importCsvDatabaseAction({ workspaceId, parentId: null, title: draft.title, properties, csv }),
      );
      if (!outcome.ok) return { error: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { error: result.error };
      return { summary: summarizeImport(result.counts, result.id) };
    }
    case "trello": {
      const json = draft.payload.json ?? "";
      const outcome = await safeAction(() => importTrelloAction({ workspaceId, json }));
      if (!outcome.ok) return { error: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { error: result.error };
      return { summary: summarizeImport(result.counts, result.id) };
    }
    case "markdown": {
      const outcome = await safeAction(() =>
        importMarkdownAction({
          workspaceId,
          filename: draft.fileName,
          markdown: draft.payload.markdown ?? "",
        }),
      );
      if (!outcome.ok) return { error: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { error: result.error };
      return { summary: summarizeImport({ ...ZERO_COUNTS, imported: 1 }, result.id) };
    }
    case "enex": {
      const notes = draft.payload.notes ?? [];
      let lastId = "";
      let imported = 0;
      for (const note of notes) {
        const outcome = await safeAction(() =>
          importMarkdownAction({
            workspaceId,
            filename: `${note.title}.md`,
            markdown: note.content,
          }),
        );
        if (!outcome.ok) return { error: outcome.error };
        const result = outcome.value;
        if ("error" in result) return { error: result.error };
        lastId = result.id;
        imported += 1;
      }
      if (imported === 0) return { error: "No Evernote notes were imported." };
      return { summary: summarizeImport({ ...ZERO_COUNTS, imported }, lastId) };
    }
    case "html":
    case "gdocs":
    case "confluence": {
      const outcome = await safeAction(() =>
        importHtmlAction({ workspaceId, parentId: null, html: draft.payload.html ?? "", filename: draft.fileName }),
      );
      if (!outcome.ok) return { error: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { error: result.error };
      return { summary: summarizeImport(result.counts, result.id) };
    }
    case "pdf": {
      const outcome = await safeAction(() =>
        importPdfTextAction({
          workspaceId,
          parentId: null,
          filename: draft.fileName,
          text: draft.payload.text ?? "",
        }),
      );
      if (!outcome.ok) return { error: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { error: result.error };
      return { summary: summarizeImport(result.counts, result.id) };
    }
    case "docx": {
      const form = new FormData();
      form.append("workspaceId", workspaceId);
      if (draft.payload.file) form.append("file", draft.payload.file);
      const outcome = await safeAction(() => importDocxAction(form));
      if (!outcome.ok) return { error: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { error: result.error };
      return { summary: summarizeImport(result.counts, result.id) };
    }
    case "zip": {
      const form = new FormData();
      form.append("workspaceId", workspaceId);
      if (draft.payload.file) form.append("file", draft.payload.file);
      const outcome = await safeAction(() => importZipAction(form));
      if (!outcome.ok) return { error: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { error: result.error };
      return { summary: summarizeImport(result.counts, result.id) };
    }
    case "audio": {
      const file = draft.payload.file;
      if (!file) return { error: "Pick an audio file first." };
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/ai/transcribe", { method: "POST", body: form });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        return { error: data?.error ?? `Transcription failed (${response.status})` };
      }
      const data = (await response.json()) as { text?: string };
      const outcome = await safeAction(() =>
        importMarkdownAction({
          workspaceId,
          filename: `${file.name.replace(/\.[^.]+$/, "")} (transcript)`,
          markdown: data.text ?? "",
        }),
      );
      if (!outcome.ok) return { error: outcome.error };
      const result = outcome.value;
      if ("error" in result) return { error: result.error };
      return { summary: summarizeImport({ ...ZERO_COUNTS, imported: 1 }, result.id) };
    }
    case "notion":
      return { error: "Notion import uses the Notion dialog." };
  }
}

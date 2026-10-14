import { slugify } from "@/lib/slug";

/**
 * Pure CSV header-mapping core for database import
 * (docs/MISSING_FEATURES.md §12 "CSV import"; docs/specs/import-export.md
 * R23.1 mapping step / R23.2 create-database type inference).
 *
 * Input is the matrix already produced by `csvToMatrix`
 * (`src/lib/serialize.ts`) — this module never parses CSV text itself and
 * performs no I/O, no DB access and no React. Given headers, a sample of data
 * rows and the target database's existing properties it:
 *
 *   1. infers a column type from the sampled cells (`inferColumnType`),
 *   2. pre-matches headers to existing properties case-insensitively and
 *      reports a confidence per column (`suggestPropertyMapping`),
 *   3. turns the unmatched columns into a plan of new property descriptors
 *      (`buildCreatePlan`),
 *   4. flags duplicate header names (`detectDuplicateHeaders`) and names
 *      unnamed columns (`placeholderFor`).
 */

/** Column types this slice can infer. Deliberately a small subset of the
 *  Prisma `PropertyType` enum (see `prisma/schema.prisma`): statuses and
 *  multi-selects are only reachable through existing properties. */
export type InferredColumnType =
  | "text"
  | "number"
  | "date"
  | "checkbox"
  | "select"
  | "url"
  | "email";

/** Prisma `PropertyType` names produced by `buildCreatePlan` (read-only mirror
 *  of the enum in `prisma/schema.prisma`). */
export type CsvCreatePropertyType =
  | "TEXT"
  | "NUMBER"
  | "DATE"
  | "CHECKBOX"
  | "SELECT"
  | "URL"
  | "EMAIL";

/** A property that already exists in the target database. */
export type ExistingProperty = {
  id: string;
  name: string;
  /** Prisma `PropertyType` name (e.g. "TEXT", "NUMBER"); compared loosely. */
  type: string;
};

/** One CSV column's suggested destination. */
export type ColumnMapping = {
  /** The original header text (may be empty for an unnamed column). */
  header: string;
  /** Inferred — or, when matched, the existing property's — column type. */
  suggestedType: InferredColumnType;
  /** Set when the header matched an existing property by name. */
  matchesExistingId?: string;
  /** 0..1 — 1 for a name match, otherwise how confident the type heuristic is. */
  confidence: number;
};

/** Descriptor for a property the import should create. */
export type CreatePropertyDescriptor = {
  /** URL-safe id derived from `slugify(name)`. */
  id: string;
  /** Display name (header text, or "Column N" for an unnamed header). */
  name: string;
  /** Prisma `PropertyType` name to persist. */
  type: CsvCreatePropertyType;
};

const BOOLEAN_VALUES = new Set(["true", "false", "yes", "no"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const ISO_DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
const SLASH_DATE_RE = /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/;

const EXISTING_TYPE_ALIASES: Record<string, InferredColumnType> = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  CHECKBOX: "checkbox",
  SELECT: "select",
  STATUS: "select",
  MULTI_SELECT: "select",
  URL: "url",
  EMAIL: "email",
};

const PRISMA_TYPE: Record<InferredColumnType, CsvCreatePropertyType> = {
  text: "TEXT",
  number: "NUMBER",
  date: "DATE",
  checkbox: "CHECKBOX",
  select: "SELECT",
  url: "URL",
  email: "EMAIL",
};

/** Parse a cell the way the CSV importer coerces numbers: strip display
 *  formatting (currency, thousands separators, percent, spaces) first. */
function asNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[%,$\s\u20AC\u00A3\u00A5]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Whether a cell looks like a date. Only unambiguous shapes count, so a
 *  plain integer is never mistaken for a date. */
function isDateValue(raw: string): boolean {
  const text = raw.trim();
  if (text === "") return false;
  if (ISO_DATE_RE.test(text) || SLASH_DATE_RE.test(text)) {
    return Number.isFinite(Date.parse(text));
  }
  return false;
}

/** Classify a column's non-empty samples and score the confidence. The order
 *  is most-specific first: an all-email column is never reported as text, and
 *  a numeric column never falls through to select. */
function classify(samples: string[]): { type: InferredColumnType; confidence: number } {
  const nonEmpty = samples.map((sample) => (sample ?? "").trim()).filter((sample) => sample !== "");
  const total = nonEmpty.length;
  if (total === 0) return { type: "text", confidence: 0 };

  const ratio = (count: number) => count / total;

  const emails = nonEmpty.filter((value) => EMAIL_RE.test(value)).length;
  if (emails === total) return { type: "email", confidence: 0.9 };

  const urls = nonEmpty.filter((value) => URL_RE.test(value)).length;
  if (urls === total) return { type: "url", confidence: 0.9 };

  const booleans = nonEmpty.filter((value) => BOOLEAN_VALUES.has(value.toLowerCase())).length;
  if (booleans === total) return { type: "checkbox", confidence: 0.9 };

  // R23.2: ≥90% of non-empty values coerce like a number → NUMBER.
  const numbers = nonEmpty.filter((value) => asNumber(value) !== null).length;
  if (ratio(numbers) >= 0.9) return { type: "number", confidence: 0.6 + 0.3 * ratio(numbers) };

  const dates = nonEmpty.filter((value) => isDateValue(value)).length;
  if (ratio(dates) >= 0.9) return { type: "date", confidence: 0.55 + 0.3 * ratio(dates) };

  // R23.2: distinct values ≤ 25 that repeat fit a status/option shape.
  const distinct = new Set(nonEmpty.map((value) => value.toLowerCase())).size;
  if (distinct <= 25 && distinct < total) {
    return { type: "select", confidence: 0.5 + 0.3 * (1 - distinct / total) };
  }

  return { type: "text", confidence: 0.3 };
}

/** Heuristic column-type inference over sampled cells. Empty or ambiguous
 *  columns fall back to `"text"`. */
export function inferColumnType(samples: string[]): InferredColumnType {
  return classify(samples).type;
}

/** Map a stored Prisma property type name onto an inferable column type. */
function normalizeExistingType(type: string): InferredColumnType | null {
  return EXISTING_TYPE_ALIASES[type.trim().toUpperCase()] ?? null;
}

/**
 * Suggest a destination for every CSV column.
 *
 * Each header is matched case-insensitively (after trimming) against
 * `existingProps` by name. A match pins the column to that property
 * (`matchesExistingId`, confidence 1, and the existing property's type);
 * unmatched columns keep the inferred type and its heuristic confidence.
 */
export function suggestPropertyMapping(
  headers: string[],
  sampleRows: string[][],
  existingProps: ExistingProperty[],
): ColumnMapping[] {
  const byName = new Map<string, ExistingProperty>();
  for (const property of existingProps) {
    const key = property.name.trim().toLowerCase();
    if (key !== "") byName.set(key, property);
  }

  return headers.map((header, index) => {
    const samples = sampleRows.map((row) => row[index] ?? "");
    const inferred = classify(samples);
    const existing = byName.get(header.trim().toLowerCase());
    if (existing) {
      return {
        header,
        suggestedType: normalizeExistingType(existing.type) ?? inferred.type,
        matchesExistingId: existing.id,
        confidence: 1,
      };
    }
    return { header, suggestedType: inferred.type, confidence: inferred.confidence };
  });
}

/**
 * Build the property descriptors a create-from-CSV import should persist: one
 * per mapping entry that was *not* matched to an existing property. Unnamed
 * headers become "Column N" (1-based position in the source matrix).
 */
export function buildCreatePlan(mapping: ColumnMapping[]): CreatePropertyDescriptor[] {
  return mapping
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry.matchesExistingId)
    .map(({ entry, index }) => {
      const name = entry.header.trim() || placeholderFor(index);
      return { id: slugify(name), name, type: PRISMA_TYPE[entry.suggestedType] };
    });
}

/**
 * Header names that appear more than once, compared case-insensitively after
 * trimming. Returns the first spelling seen for each duplicate, in first-seen
 * order. Blank headers are ignored (they are placeholders, not real names).
 */
export function detectDuplicateHeaders(headers: string[]): string[] {
  const firstSeen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const header of headers) {
    const label = header.trim();
    const key = label.toLowerCase();
    if (key === "") continue;
    const seen = firstSeen.get(key);
    if (seen === undefined) {
      firstSeen.set(key, label);
    } else if (!duplicates.includes(seen)) {
      duplicates.push(seen);
    }
  }
  return duplicates;
}

/** Display name for an unnamed header at a 0-based column index. */
export function placeholderFor(index: number): string {
  return `Column ${index + 1}`;
}

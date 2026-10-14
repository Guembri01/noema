/**
 * B91 follow-up — Database JSON export.
 *
 * `DATABASE_EXPORT_FORMATS` (export-format.ts) already accepts `json`, but the
 * database export route only ever emitted CSV. This is the pure, framework-free
 * half of closing that gap: a builder that serialises a database snapshot
 * `{ name, properties, rows, views }` to a deterministic JSON document, and its
 * validating mirror image so a bad import fails closed instead of half-loading.
 *
 * Determinism is the point, not an afterthought:
 *
 * - the top-level keys are always emitted in one fixed order
 *   (`schemaVersion`, `name`, `exportedAt?`, `properties`, `rows`, `views`);
 * - every nested object's keys are sorted alphabetically;
 * - rows are ordered by `position` (stable for ties and for rows without a
 *   position, so a snapshot without positions keeps its input order);
 * - secret-shaped fields (`token`, `password`, `apiKey`, …) and internal
 *   fields (`_foo`, `__typename`) are replaced with `REDACTED` at every depth,
 *   so an export never leaks provider keys or editor bookkeeping;
 * - `exportedAt` is injected by the caller (no hidden clock), so the same input
 *   byte-for-byte produces the same document.
 *
 * `parseDatabaseJson` validates shape and schema version and returns a typed
 * `{ ok, value | error }`; `isSupportedSchemaVersion` is the one predicate the
 * version check is built on. Round-trip is pinned in json-export.test.ts.
 *
 * Wiring `?format=json` in `src/app/api/export/database/[pageId]/route.ts` so
 * the CSV default stays untouched is a follow-up — this module is pure.
 */

/** Schema version written by default and understood by `parseDatabaseJson`. */
export const DATABASE_JSON_SCHEMA_VERSION = 1;

/** Every schema version `parseDatabaseJson` accepts. */
export const SUPPORTED_DATABASE_JSON_VERSIONS: readonly number[] = [
  DATABASE_JSON_SCHEMA_VERSION,
];

/** What a redacted value becomes — a stable, greppable marker. */
export const REDACTED = "[redacted]";

/** A row/record in the exported document (kept deliberately open). */
export type JsonRecord = Record<string, unknown>;

/** The snapshot a database export is built from. */
export type DatabaseJsonInput = {
  name: string;
  properties: readonly JsonRecord[];
  rows: readonly JsonRecord[];
  views: readonly JsonRecord[];
};

/** The shape of an exported document once parsed back. */
export type DatabaseJsonValue = {
  schemaVersion: number;
  name: string;
  exportedAt?: string;
  properties: JsonRecord[];
  rows: JsonRecord[];
  views: JsonRecord[];
};

export type DatabaseJsonExportOptions = {
  /** Schema version to stamp; defaults to `DATABASE_JSON_SCHEMA_VERSION`. */
  version?: number;
  /** Indent with two spaces instead of compact output. */
  pretty?: boolean;
  /** Export timestamp; omit for a clock-free, byte-stable document. */
  exportedAt?: string | Date;
};

export type DatabaseJsonParseResult =
  | { ok: true; value: DatabaseJsonValue }
  | { ok: false; error: string };

/**
 * Keys whose value is never exported. Intentionally broad and matched by
 * substring: over-redacting a field named `tokenCount` is preferable to leaking
 * a real `token`, and the rule is trivial to reason about.
 */
const SECRET_KEY_PATTERN =
  /(password|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential)/i;

/** Internal bookkeeping (editor/driver fields) that does not belong in an export. */
const INTERNAL_KEY_PATTERN = /^_/;

function isRedactedKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || INTERNAL_KEY_PATTERN.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deep-copy `value` into a canonical JSON tree: object keys sorted
 * alphabetically, redacted keys replaced wholesale, `undefined`/functions/
 * symbols dropped, non-finite numbers normalised to `null`. The input is never
 * mutated.
 */
function canonicalize(value: unknown): Json {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (isPlainObject(value)) {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort(compareKeys)) {
      if (isRedactedKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      const entry = value[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  return value as Json;
}

function positionOf(row: unknown): number | null {
  if (!isPlainObject(row)) return null;
  const position = row.position;
  return typeof position === "number" && Number.isFinite(position) ? position : null;
}

/**
 * Order rows deterministically: rows with a `position` come first in ascending
 * order (input order breaks ties), then rows without one keep their input
 * order. A snapshot that carries no positions is therefore left untouched.
 */
function stableRowOrder(rows: readonly JsonRecord[]): JsonRecord[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const pa = positionOf(a.row);
      const pb = positionOf(b.row);
      if (pa !== null && pb !== null) return pa - pb || a.index - b.index;
      if (pa !== null) return -1;
      if (pb !== null) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function asRecords(value: Json): JsonRecord[] {
  return Array.isArray(value) ? (value as JsonRecord[]) : [];
}

/**
 * Build the JSON document for a database snapshot. Returns JSON text so the
 * route can hand it straight to a response body; `pretty` controls the
 * indentation. Pure and clock-free unless `options.exportedAt` is supplied.
 */
export function exportDatabaseJson(
  input: DatabaseJsonInput,
  options: DatabaseJsonExportOptions = {},
): string {
  const name = typeof input?.name === "string" ? input.name : "";
  const properties = input?.properties ?? [];
  const rows = input?.rows ?? [];
  const views = input?.views ?? [];

  const value: DatabaseJsonValue = {
    schemaVersion: options.version ?? DATABASE_JSON_SCHEMA_VERSION,
    name,
    ...(options.exportedAt !== undefined
      ? { exportedAt: toIsoString(options.exportedAt) }
      : {}),
    properties: asRecords(canonicalize(properties)),
    rows: asRecords(canonicalize(stableRowOrder(rows))),
    views: asRecords(canonicalize(views)),
  };

  return JSON.stringify(value, null, options.pretty ? 2 : undefined);
}

/** True when `version` is a schema version this build understands. */
export function isSupportedSchemaVersion(version: unknown): boolean {
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    SUPPORTED_DATABASE_JSON_VERSIONS.includes(version)
  );
}

/**
 * Parse and validate an exported JSON document. Fails closed with a
 * human-readable `error` on malformed JSON, a non-object root, an unsupported
 * schema version, or a missing/mis-typed field.
 */
export function parseDatabaseJson(text: string): DatabaseJsonParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON: could not parse the export." };
  }

  if (!isPlainObject(data)) {
    return { ok: false, error: "Invalid database export: expected a JSON object." };
  }

  if (!isSupportedSchemaVersion(data.schemaVersion)) {
    return {
      ok: false,
      error: `Unsupported schemaVersion ${JSON.stringify(data.schemaVersion)}; supported: ${SUPPORTED_DATABASE_JSON_VERSIONS.join(", ")}.`,
    };
  }
  if (typeof data.name !== "string") {
    return { ok: false, error: "Invalid database export: `name` must be a string." };
  }
  if (!Array.isArray(data.properties)) {
    return { ok: false, error: "Invalid database export: `properties` must be an array." };
  }
  if (!Array.isArray(data.rows)) {
    return { ok: false, error: "Invalid database export: `rows` must be an array." };
  }
  if (!Array.isArray(data.views)) {
    return { ok: false, error: "Invalid database export: `views` must be an array." };
  }
  if (data.exportedAt !== undefined && typeof data.exportedAt !== "string") {
    return { ok: false, error: "Invalid database export: `exportedAt` must be a string." };
  }

  return { ok: true, value: data as unknown as DatabaseJsonValue };
}

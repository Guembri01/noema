/**
 * B55 — pure `?format=` contract for the export routes (spec R23.16).
 *
 * An unknown format must be a 400, never a silent fallback: the page export
 * used to fall through to Markdown for anything it did not recognise.
 * Framework-free on purpose so it is unit-testable in the lib sandbox.
 */

/** Formats the page export accepts (default: `md`). */
export const PAGE_EXPORT_FORMATS = ["md", "json", "html", "pdf"] as const;

/** Formats the database export accepts (default: `csv`). */
export const DATABASE_EXPORT_FORMATS = ["csv"] as const;

/** Formats the workspace export accepts (default: `zip`). */
export const WORKSPACE_EXPORT_FORMATS = ["zip"] as const;

export type ExportFormatResult =
  | { ok: true; format: string }
  | { ok: false; error: string; valid: readonly string[] };

/**
 * Validate a raw `?format=` value against a route's allowlist.
 *
 * - absent (`null`) or empty (`""`) → the route's default `fallback`
 * - a value in `allowed` → `{ ok: true, format }`
 * - anything else → `{ ok: false, error, valid }` (route answers 400 with
 *   `{ error, valid }` so the caller sees the valid formats)
 *
 * Matching is exact: `MD` is not `md` (documented in export-format.test.ts).
 */
export function parseExportFormat(
  raw: string | null,
  allowed: readonly string[],
  fallback: string,
): ExportFormatResult {
  if (raw === null || raw === "") return { ok: true, format: fallback };
  if (allowed.includes(raw)) return { ok: true, format: raw };
  return {
    ok: false,
    error: `Unknown export format "${raw}". Valid formats: ${allowed.join(", ")}.`,
    valid: allowed,
  };
}

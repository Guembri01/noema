/**
 * Pure CSV value coercion — the client-side twin of `coerceCsvValue` in
 * `src/server/actions/database.ts` (docs/specs/import-export.md §4 R23.2 type
 * inference, R23.5 round-trip). Given a raw CSV cell and a target property it
 * produces the JSON shape the app stores on `PropertyValue.value`:
 *
 *   TEXT | URL | EMAIL | PHONE   -> { text: string }
 *   NUMBER                       -> { number: number }
 *   CHECKBOX                     -> { checked: boolean }
 *   DATE                         -> { start: string }
 *   SELECT | STATUS              -> { optionId: string }   (needs an option map)
 *   MULTI_SELECT                 -> { optionIds: string[] } (needs an option map)
 *   PEOPLE                       -> { names: string[] }
 *
 * No I/O, no DB, no React. Blank cells return `null` (and `coerceRow` omits
 * them) and nothing here throws — malformed input is treated as an empty cell.
 */

/** An option of a SELECT/STATUS/MULTI_SELECT property (`config.options`). */
export type CsvOption = { id: string; name: string };

/** The slice of `PropertyConfig` this module reads. */
export type CsvPropertyConfig = {
  options?: CsvOption[];
  /** NUMBER display format; `"percent"` makes a plain cell a fraction. */
  format?: string;
};

/** A property a CSV column can be coerced into. */
export type CsvProperty = {
  id: string;
  name: string;
  /** Prisma `PropertyType` name (e.g. "NUMBER"); compared case-insensitively. */
  type: string;
  config?: CsvPropertyConfig | null;
};

/** A coerced cell in one of the stored value shapes. */
export type CsvValue =
  | { text: string }
  | { number: number }
  | { checked: boolean }
  | { start: string }
  | { optionId: string }
  | { optionIds: string[] }
  | { names: string[] };

/** A non-empty cell bound to the property it belongs to. */
export type CsvRowValue = { propertyId: string; value: CsvValue };

/** Property types a CSV cell can populate. FILES/RELATION need uploads or page
 *  ids, so `isCoercible` reports them as unsupported. */
const COERCIBLE_TYPES = new Set([
  "TEXT",
  "NUMBER",
  "CHECKBOX",
  "DATE",
  "SELECT",
  "STATUS",
  "MULTI_SELECT",
  "URL",
  "EMAIL",
  "PHONE",
  "PEOPLE",
]);

/** Truthy checkbox tokens; anything else (after trim/lowercase) is unchecked. */
const CHECKBOX_TOKENS = new Set(["true", "yes", "1", "x", "✓"]);

/** Strip display formatting (currency, thousands separators, percent, spaces)
 *  exactly like the importer's number path. */
function asNumber(text: string): number | null {
  const cleaned = text.replace(/[%,$\s\u20AC\u00A3\u00A5]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function normalizeType(propertyType: unknown): string {
  return typeof propertyType === "string" ? propertyType.trim().toUpperCase() : "";
}

/** Find a configured option by display name, case-insensitively after trim. */
function findOption(name: string, options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const key = name.trim().toLowerCase();
  for (const option of options as CsvOption[]) {
    if (option && typeof option.name === "string" && option.name.trim().toLowerCase() === key) {
      return option.id;
    }
  }
  return undefined;
}

/** Split a comma-separated cell into trimmed, non-empty parts. */
function splitList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Whether a property type can be populated from a CSV cell. */
export function isCoercible(propertyType: string): boolean {
  return COERCIBLE_TYPES.has(normalizeType(propertyType));
}

/**
 * Coerce one CSV cell into the stored value shape for `propertyType`. Returns
 * `null` when the cell is empty or cannot be coerced (unknown option, not a
 * number) — callers skip those cells. Unknown/unsupported types fall back to
 * `{ text }`, matching the server action's `default:` branch.
 */
export function coerceCsvValue(
  raw: string,
  propertyType: string,
  config?: CsvPropertyConfig | null,
): CsvValue | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return null;

  switch (normalizeType(propertyType)) {
    case "NUMBER": {
      const numeric = asNumber(text);
      if (numeric === null) return null;
      // A trailing "%" (or a percent-formatted column) stores the fraction,
      // so "7.5%" -> 0.075, mirroring a value typed into the cell.
      const asFraction = text.endsWith("%") || config?.format === "percent";
      return { number: asFraction ? numeric / 100 : numeric };
    }
    case "CHECKBOX":
      return { checked: CHECKBOX_TOKENS.has(text.toLowerCase()) };
    case "DATE":
      return { start: text };
    case "SELECT":
    case "STATUS": {
      const id = findOption(text, config?.options);
      return id === undefined ? null : { optionId: id };
    }
    case "MULTI_SELECT": {
      const options = config?.options;
      const ids = splitList(text)
        .map((part) => findOption(part, options))
        .filter((id): id is string => id !== undefined);
      return ids.length > 0 ? { optionIds: ids } : null;
    }
    case "PEOPLE": {
      const names = splitList(text);
      return names.length > 0 ? { names } : null;
    }
    default:
      return { text };
  }
}

/**
 * Coerce a whole CSV row against database properties. Columns are matched to
 * properties by header name (case-insensitively, after trim) unless an explicit
 * `mapping` is given, where `mapping[columnIndex]` is a property id (or null to
 * skip). Empty and uncoercible cells are omitted; a ragged row is fine.
 */
export function coerceRow(
  headers: readonly string[],
  row: readonly string[],
  props: readonly CsvProperty[],
  mapping?: readonly (string | null | undefined)[],
): CsvRowValue[] {
  const headerList = Array.isArray(headers) ? headers : [];
  const rowList = Array.isArray(row) ? row : [];
  const propertyList = Array.isArray(props) ? props : [];

  const byId = new Map<string, CsvProperty>();
  const byName = new Map<string, CsvProperty>();
  for (const property of propertyList) {
    if (!property || typeof property.id !== "string") continue;
    byId.set(property.id, property);
    if (typeof property.name === "string") {
      const key = property.name.trim().toLowerCase();
      if (key !== "" && !byName.has(key)) byName.set(key, property);
    }
  }

  const width = Math.max(headerList.length, mapping?.length ?? 0);
  const out: CsvRowValue[] = [];
  for (let index = 0; index < width; index += 1) {
    const property = mapping
      ? mapping[index]
        ? byId.get(mapping[index] as string)
        : undefined
      : byName.get((headerList[index] ?? "").trim().toLowerCase());
    if (!property) continue;
    const raw = typeof rowList[index] === "string" ? rowList[index] : "";
    const value = coerceCsvValue(raw, property.type, property.config);
    if (value === null) continue;
    out.push({ propertyId: property.id, value });
  }
  return out;
}

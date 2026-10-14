/**
 * Multi-key table sorting (F5) — a pure comparison core for database table
 * views.
 *
 * A saved view hands the table an ordered list of `SortSpec`s (the columns the
 * user clicked, in priority order). This module turns that list into a single
 * comparator over rows: typed comparisons per column, an explicit
 * empty-cell policy, and a deterministic `id` tiebreak. Keeping it pure means
 * the ordering can be unit-tested without a database, a route or React — the
 * same split `src/lib/database-query.ts` uses for filters/grouping.
 *
 * The value extraction mirrors the rest of the codebase: cells are objects
 * (`{ text }`, `{ number }`, `{ start }`, `{ checked }`, `{ optionId }`) or
 * primitives, and both shapes are accepted so a caller can sort raw fixtures.
 */

/** Which direction a key sorts in. */
export type SortDir = "asc" | "desc";

/** How a column's cells are compared. */
export type SortType = "text" | "number" | "date" | "checkbox" | "select";

/** Where cells with no value land, regardless of direction. */
export type NullsPolicy = "first" | "last";

/** One sort key: which column, which way, and how to read its cells. */
export type SortSpec = {
  propertyId: string;
  dir: SortDir;
  type: SortType;
  /**
   * SELECT columns: option ids in their display order. A value is ranked by
   * its index here; an id that is not listed (a stale option) counts as empty.
   * When omitted, select cells fall back to plain text order.
   */
  optionOrder?: string[];
  /**
   * Where empty cells go. `"last"` (the default) keeps them at the end in both
   * ascending and descending order — the product's convention — and `"first"`
   * is the deliberate opposite.
   */
  nulls?: NullsPolicy;
};

/** The minimum shape `buildComparator`/`applySort` need from a row. */
export type SortRow = {
  id: string;
  propertyValues?: Array<{ propertyId: string; value: unknown }>;
};

/** A normalised, comparable key. `null` means "no value" (an empty cell). */
type SortKey = string | number | boolean | null;

/** Raw value of one property on a row (`undefined` when absent). */
export function valueFor(row: SortRow, propertyId: string): unknown {
  return row.propertyValues?.find((candidate) => candidate.propertyId === propertyId)?.value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Text cells: a primitive string or `{ text }`; blank text is "no value". */
function textKey(value: unknown): string | null {
  const raw = typeof value === "string" ? value : asRecord(value)?.text;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw;
}

/** Number cells: a finite number, a numeric string, or `{ number }`. */
function numberKey(value: unknown): number | null {
  const raw = typeof value === "object" && value !== null
    ? asRecord(value)?.number
    : value;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Date cells: an ISO string or `{ start }`, parsed to epoch milliseconds. */
function dateKey(value: unknown): number | null {
  const raw = asRecord(value)?.start ?? value;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Checkbox cells: a boolean or `{ checked }`. `false` is a real value, not an
 * empty cell — only a missing/`null` checked flag is "no value".
 */
function checkboxKey(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const checked = asRecord(value)?.checked;
  return typeof checked === "boolean" ? checked : null;
}

/** Select cells: ranked by `optionOrder` index, else by raw option id text. */
function selectKey(value: unknown, optionOrder?: string[]): string | number | null {
  const id = asRecord(value)?.optionId ?? value;
  if (typeof id !== "string" || id === "") return null;
  if (!optionOrder) return id;
  const index = optionOrder.indexOf(id);
  return index === -1 ? null : index;
}

function keyFor(value: unknown, spec: SortSpec): SortKey {
  switch (spec.type) {
    case "number":
      return numberKey(value);
    case "date":
      return dateKey(value);
    case "checkbox":
      return checkboxKey(value);
    case "select":
      return selectKey(value, spec.optionOrder);
    case "text":
    default:
      return textKey(value);
  }
}

/** Compare two non-null keys of the same type, ascending. */
function compareKeys(a: string | number | boolean, b: string | number | boolean): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Compare two raw cell values under one `SortSpec`.
 *
 * - Empty values sort per `spec.nulls` (`"last"` by default) **independently of
 *   `spec.dir`**: a null is always at the chosen end, never flipped by the sort
 *   direction.
 * - Two empty values are equal, so a lower-priority key (or the `id` tiebreak)
 *   can still decide.
 * - Otherwise the typed keys are compared ascending and the result negated for
 *   `"desc"`.
 */
export function compareValues(a: unknown, b: unknown, spec: SortSpec): number {
  const ka = keyFor(a, spec);
  const kb = keyFor(b, spec);
  const aEmpty = ka === null;
  const bEmpty = kb === null;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty || bEmpty) {
    const nullsFirst = (spec.nulls ?? "last") === "first";
    // `a` empty → negative means "a first"; flip when nulls belong last.
    return (aEmpty ? -1 : 1) * (nullsFirst ? 1 : -1);
  }
  const cmp = compareKeys(ka, kb);
  if (cmp === 0) return 0;
  return spec.dir === "desc" ? -cmp : cmp;
}

/** Deterministic `id` tiebreak so equal rows have one canonical order. */
function compareIds(a: SortRow, b: SortRow): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Turn an ordered list of specs into one comparator over rows.
 *
 * Keys are evaluated in priority order: the first that differs decides, and a
 * complete tie falls through to an ascending `id` comparison. With no specs the
 * comparator still orders by `id`.
 */
export function buildComparator(specs: SortSpec[]): (a: SortRow, b: SortRow) => number {
  return (a, b) => {
    for (const spec of specs) {
      const cmp = compareValues(valueFor(a, spec.propertyId), valueFor(b, spec.propertyId), spec);
      if (cmp !== 0) return cmp;
    }
    return compareIds(a, b);
  };
}

/**
 * A sorted copy of `rows` under `specs`. No specs returns an equal copy in the
 * input order; the input array is never mutated.
 */
export function applySort<T extends SortRow>(rows: readonly T[], specs: SortSpec[] | undefined): T[] {
  if (!specs || specs.length === 0) return [...rows];
  return [...rows].sort(buildComparator(specs));
}

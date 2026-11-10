/**
 * Database calculations footer + group aggregation. Pure logic — no DB, no UI.
 *
 * Vocabulary aligns with the rollup aggregator (`src/lib/rollup.ts`): the
 * shared ids (sum, min, max, median, range, …) mean the same thing, the
 * crosswalk `AGGREGATION_TO_ROLLUP` maps the rest, and inputs are normalized
 * from the property-value JSON shapes documented in
 * `src/server/actions/database.ts` (`{ number }`, `{ text }`, `{ optionId }`,
 * `{ checked }`, …) so a column of `row.propertyValues` can be passed straight
 * in.
 */

import type { RollupFunction, RollupValue } from "@/lib/rollup";

/** Footer calculation ids. Rollup ids are accepted via `AGGREGATION_TO_ROLLUP`. */
export type AggregationFn =
  /** Every cell, empty included (footer "Count all"). */
  | "count"
  /** Non-empty cells — this is rollup's "count" semantics. */
  | "countValues"
  | "countEmpty"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "median"
  /** Raw value is max−min; the display shows "min–max". */
  | "range"
  /** Raw value is a fraction 0..1 (like stored percent cells). */
  | "percentEmpty"
  /** Fraction of boolean cells that are checked, 0..1. */
  | "percentChecked";

export const AGGREGATION_FUNCTIONS: { id: AggregationFn; label: string }[] = [
  { id: "count", label: "Count all" },
  { id: "countValues", label: "Count values" },
  { id: "countEmpty", label: "Count empty" },
  { id: "sum", label: "Sum" },
  { id: "average", label: "Average" },
  { id: "min", label: "Min" },
  { id: "max", label: "Max" },
  { id: "median", label: "Median" },
  { id: "range", label: "Range" },
  { id: "percentEmpty", label: "Percent empty" },
  { id: "percentChecked", label: "Percent checked" },
];

/**
 * Crosswalk to the rollup vocabulary so a footer can reuse a rollup config.
 * Ambiguous ids are intentionally unmapped: rollup's "count" counts non-empty
 * values (our `countValues`, not `count`), and rollup has no "percent empty".
 */
export const AGGREGATION_TO_ROLLUP: Partial<Record<AggregationFn, RollupFunction>> = {
  countValues: "count",
  countEmpty: "count_empty",
  sum: "sum",
  average: "avg",
  min: "min",
  max: "max",
  median: "median",
  range: "range",
  percentChecked: "percent_checked",
};

export type AggregateOptions = {
  /** Matches the NUMBER property formats: number (default) | percent | currency. */
  showAs?: "number" | "percent" | "currency";
  /** ISO 4217 code (e.g. "EUR", like `PropertyConfig.currency`) or a literal symbol (e.g. "¥"). Defaults to USD. */
  currency?: string;
};

export type AggregateResult = {
  /** Numeric result in natural units (percents as fractions); null when there is nothing to aggregate. */
  value: number | null;
  /** Formatted per `showAs`; "—" when value is null; "min–max" for range. */
  display: string;
};

/** Unwrap a property-value JSON cell (or primitive) into a scalar. */
export function toAggregationValue(value: unknown): RollupValue {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === "number") return Number.isFinite(value as number) ? (value as number) : null;
  if (kind === "boolean" || kind === "string") return value as RollupValue;
  if (kind !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.number === "number") return Number.isFinite(v.number) ? v.number : null;
  if (typeof v.checked === "boolean") return v.checked;
  if (typeof v.text === "string") return v.text;
  if (typeof v.optionId === "string") return v.optionId;
  if (typeof v.start === "string") return v.start;
  const list = [v.optionIds, v.names, v.pageIds].find((candidate) => Array.isArray(candidate));
  if (list) {
    const names = list.filter((entry): entry is string => typeof entry === "string");
    return names.length > 0 ? names.join(", ") : null;
  }
  return null;
}

const isEmptyValue = (value: RollupValue): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "");

/** Coerce a scalar to a finite number; non-numeric strings are excluded ("abc" never becomes 0). Shared with rollup. */
export function toNumber(value: RollupValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string" || value.trim() === "") return null;
  const stripped = value.trim().replace(/[^0-9.eE+-]/g, "");
  if (stripped === "" || stripped === "-" || stripped === "+" || stripped === ".") return null;
  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Aligned with rollup's numeric display: integers bare, otherwise two decimals. */
function formatPlain(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Fixed locale (like formatCell): server and client render byte-identically. */
const LOCALE = "en-US";

function formatCurrency(n: number, currency: string): string {
  if (/^[A-Za-z]{3}$/.test(currency)) {
    try {
      return n.toLocaleString(LOCALE, { style: "currency", currency: currency.toUpperCase() });
    } catch {
      // Unknown ISO code — fall through and treat it as a literal symbol.
    }
  }
  return `${currency}${n.toLocaleString(LOCALE, { maximumFractionDigits: 2 })}`;
}

function formatByShowAs(n: number, showAs: NonNullable<AggregateOptions["showAs"]>, currency: string): string {
  if (showAs === "percent") {
    // Stored percent cells are fractions (0.075 → 7.5%); maximumFractionDigits kills float noise.
    return `${(n * 100).toLocaleString(LOCALE, { maximumFractionDigits: 2 })}%`;
  }
  if (showAs === "currency") return formatCurrency(n, currency);
  return formatPlain(n);
}

/**
 * Footer aggregation over one column of values (raw property values or
 * primitives). Fail-safe: unknown shapes are treated as empty, unknown
 * functions return `{ value: null, display: "—" }`, nothing throws.
 */
export function aggregate(
  values: readonly unknown[],
  fn: AggregationFn,
  opts: AggregateOptions = {},
): AggregateResult {
  const normalized = values.map(toAggregationValue);
  const present = normalized.filter((value) => !isEmptyValue(value));
  const numbers = normalized.map(toNumber).filter((value): value is number => value !== null);
  const showAs: NonNullable<AggregateOptions["showAs"]> =
    opts.showAs ?? (fn === "percentEmpty" || fn === "percentChecked" ? "percent" : "number");
  const currency = opts.currency ?? "USD";
  const make = (value: number | null, display?: string): AggregateResult => ({
    value,
    display: display ?? (value === null ? "—" : formatByShowAs(value, showAs, currency)),
  });
  const sumOf = (list: number[]) => list.reduce((total, value) => total + value, 0);

  switch (fn) {
    case "count":
      return make(values.length);
    case "countValues":
      return make(present.length);
    case "countEmpty":
      return make(values.length - present.length);
    case "percentEmpty":
      return make(values.length === 0 ? 0 : (values.length - present.length) / values.length);
    case "percentChecked": {
      const booleans = normalized.filter((value) => typeof value === "boolean");
      if (booleans.length === 0) return make(0);
      return make(booleans.filter((value) => value === true).length / booleans.length);
    }
    case "sum":
      return numbers.length === 0 ? make(null) : make(sumOf(numbers));
    case "average":
      return numbers.length === 0 ? make(null) : make(sumOf(numbers) / numbers.length);
    case "min":
    case "max":
      return numbers.length === 0
        ? make(null)
        : make(fn === "min" ? Math.min(...numbers) : Math.max(...numbers));
    case "median": {
      if (numbers.length === 0) return make(null);
      const sorted = [...numbers].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return make(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    }
    case "range": {
      if (numbers.length === 0) return make(null);
      const min = Math.min(...numbers);
      const max = Math.max(...numbers);
      return make(max - min, `${formatPlain(min)}–${formatPlain(max)}`);
    }
    default:
      // Unknown id at runtime (untyped callers): fail safe, never throw.
      return make(null);
  }
}

export type GroupedRows<TRow> = {
  /** Normalized bucket key ("" for missing values). */
  key: string;
  /** Display label; `EMPTY_GROUP_LABEL` for the missing-value bucket. */
  label: string;
  rows: TRow[];
};

export const EMPTY_GROUP_LABEL = "Empty";

function groupKeyOf(value: unknown): string {
  const normalized = toAggregationValue(value);
  return isEmptyValue(normalized) ? "" : String(normalized);
}

/**
 * Bucket rows by a group-by fn (raw property value or any key) in
 * first-appearance order; missing values collect into one labelled empty
 * group. Never throws on mixed or unknown value shapes.
 */
export function groupRows<TRow>(
  rows: readonly TRow[],
  groupByFn: (row: TRow) => unknown,
): GroupedRows<TRow>[] {
  const groups: GroupedRows<TRow>[] = [];
  const byKey = new Map<string, GroupedRows<TRow>>();
  for (const row of rows) {
    const key = groupKeyOf(groupByFn(row));
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: key === "" ? EMPTY_GROUP_LABEL : key, rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

/** Shape of `DBRow` (src/components/database/database-types.ts) used for property lookup. */
export type RowWithPropertyValues = {
  propertyValues: { propertyId: string; value: unknown }[];
};

/** Read a cell value out of a DBRow-shaped row; null when the row has no value for the property. */
export function propertyValueOf<TRow extends RowWithPropertyValues>(row: TRow, propertyId: string): unknown {
  return row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value ?? null;
}

export type GroupAggregationSpec<TRow> = {
  fn: AggregationFn;
  /** Cell-value extractor (e.g. `propertyValueOf(row, id)`). Omit to count rows (every row counts as `true`). */
  value?: (row: TRow) => unknown;
  options?: AggregateOptions;
};

export type AggregatedGroup<TRow> = GroupedRows<TRow> & {
  aggregates: Record<string, AggregateResult>;
};

/**
 * Apply a per-group aggregation spec (e.g. sum of estimates per status) to
 * already-grouped rows. Returns new group objects; rows/labels/order are
 * preserved and empty groups aggregate to safe sentinels.
 */
export function aggregateGroups<TRow>(
  groups: readonly GroupedRows<TRow>[],
  specs: Readonly<Record<string, GroupAggregationSpec<TRow>>>,
): AggregatedGroup<TRow>[] {
  return groups.map((group) => {
    const aggregates: Record<string, AggregateResult> = {};
    for (const [name, spec] of Object.entries(specs)) {
      const values = spec.value
        ? group.rows.map(spec.value)
        : group.rows.map(() => true);
      aggregates[name] = aggregate(values, spec.fn, spec.options);
    }
    return { ...group, aggregates };
  });
}

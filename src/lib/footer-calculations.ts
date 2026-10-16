/**
 * Table calculation footer model — §3 Calculations/footer, group aggregation
 * (R89.4). Pure logic: no DB, no UI.
 *
 * A {@link FooterSpec} is the persisted `ViewConfig.footer` shape
 * (`{ propertyId, fn }[]`). This module parses/validates that shape, computes
 * per-column results over a (already filtered) row set, computes the same
 * footers per group, and merges specs from several sources.
 *
 * The aggregation *semantics* and the number/percent/currency formatting are
 * owned by `aggregate()` in `@/lib/aggregations` — this module only routes a
 * property's format config into `aggregate()` so footer and group summary
 * values stay byte-identical with rollup/footer aggregation (R89.4 accept).
 */
import type { PropertyType } from "@prisma/client";
import {
  AGGREGATION_FUNCTIONS,
  aggregate,
  type AggregateOptions,
  type AggregationFn,
  type GroupedRows,
} from "@/lib/aggregations";

/** Persisted footer spec: one entry per calculated column. */
export type FooterSpec = { propertyId: string; fn: AggregationFn }[];

const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set(
  AGGREGATION_FUNCTIONS.map((entry) => entry.id),
);

function isKnownFunction(value: unknown): value is AggregationFn {
  return typeof value === "string" && KNOWN_FUNCTIONS.has(value);
}

/**
 * Parse the persisted `config.footer` JSON into a spec. Fail-safe and
 * lossy-by-design: non-arrays and malformed entries are dropped, duplicate
 * properties are deduped (later wins), and order is first-appearance.
 */
export function parseFooterSpec(raw: unknown): FooterSpec {
  if (!Array.isArray(raw)) return [];
  const byProperty = new Map<string, AggregationFn>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as { propertyId?: unknown; fn?: unknown };
    if (typeof candidate.propertyId !== "string" || candidate.propertyId === "") continue;
    if (!isKnownFunction(candidate.fn)) continue;
    byProperty.set(candidate.propertyId, candidate.fn);
  }
  return [...byProperty].map(([propertyId, fn]) => ({ propertyId, fn }));
}

/** Property shape needed for footer validity/format: the DBProperty subset. */
export type FooterPropertyConfig = { format?: string; currency?: string } | null;

export type FooterProperty = {
  id: string;
  type: PropertyType;
  name?: string;
  config?: FooterPropertyConfig;
};

/** Functions valid for *any* property: cell counts and the empty fraction. */
const COUNT_FUNCTIONS: AggregationFn[] = ["count", "countValues", "countEmpty", "percentEmpty"];
/** Functions that need numeric cells. */
const NUMERIC_FUNCTIONS: AggregationFn[] = ["sum", "average", "min", "max", "median", "range"];
/** Property types whose values aggregate numerically (rollup/formula may resolve to numbers). */
const NUMERIC_TYPES: readonly PropertyType[] = ["NUMBER", "ROLLUP", "FORMULA"];

/**
 * Functions the footer menu may offer for a property type (R89.4: non-numeric
 * columns are count/percent-empty only; `percentChecked` is checkbox-only).
 */
export function footerFunctionsForType(type: PropertyType): AggregationFn[] {
  if (type === "CHECKBOX") return [...COUNT_FUNCTIONS, "percentChecked"];
  if (NUMERIC_TYPES.includes(type)) return [...COUNT_FUNCTIONS, ...NUMERIC_FUNCTIONS];
  return [...COUNT_FUNCTIONS];
}

/** The default footer function the menu pre-selects for a property type. */
export function defaultFnForType(type: PropertyType): AggregationFn {
  if (type === "CHECKBOX") return "percentChecked";
  if (NUMERIC_TYPES.includes(type)) return "sum";
  return "count";
}

export type FooterSpecIssue = {
  propertyId: string;
  fn: AggregationFn;
  reason: "unknown-property" | "unsupported-function";
  /** Type of the resolved property; absent for an unknown property. */
  type?: PropertyType;
  message: string;
};

export type ValidateFooterOptions = { properties: readonly FooterProperty[] };

/**
 * Validate a spec against the database's properties. Returns every issue (an
 * empty array means the spec is usable); never throws.
 */
export function validateFooterSpec(
  spec: FooterSpec,
  options: ValidateFooterOptions,
): FooterSpecIssue[] {
  const byId = new Map(options.properties.map((property) => [property.id, property]));
  const issues: FooterSpecIssue[] = [];
  for (const { propertyId, fn } of spec) {
    const property = byId.get(propertyId);
    if (!property) {
      issues.push({
        propertyId,
        fn,
        reason: "unknown-property",
        message: `Unknown property "${propertyId}".`,
      });
      continue;
    }
    if (!footerFunctionsForType(property.type).includes(fn)) {
      issues.push({
        propertyId,
        fn,
        reason: "unsupported-function",
        type: property.type,
        message: `Function "${fn}" is not supported for ${property.type} properties.`,
      });
    }
  }
  return issues;
}

export type FooterColumnResult = {
  propertyId: string;
  fn: AggregationFn;
  /** Natural-unit value (percents as fractions); null when nothing to aggregate. */
  value: number | null;
  /** Formatted by the aggregations engine (number/percent/currency, "—", "min–max"). */
  display: string;
  /** True when there was nothing to aggregate (`value === null`). */
  empty: boolean;
};

export type ComputeFooterOptions<TRow> = {
  /** Cell extractor, e.g. `(row, id) => propertyValueOf(row, id)`. */
  valueFor: (row: TRow, propertyId: string) => unknown;
  properties?: readonly FooterProperty[];
};

/** Route a property's NUMBER format config into the aggregations engine. */
function aggregateOptionsFor(property: FooterProperty | undefined): AggregateOptions {
  const format = property?.config?.format;
  if (format === "percent") return { showAs: "percent" };
  if (format === "currency") {
    return { showAs: "currency", currency: property?.config?.currency ?? "USD" };
  }
  return {};
}

/**
 * Compute one footer result per spec entry over `rows`, reusing
 * `aggregate()` so footer/group/rollup outputs agree (R89.4). Columns with an
 * unknown property still aggregate, falling back to plain formatting.
 */
export function computeFooter<TRow>(
  spec: FooterSpec,
  rows: readonly TRow[],
  options: ComputeFooterOptions<TRow>,
): FooterColumnResult[] {
  const byId = new Map((options.properties ?? []).map((property) => [property.id, property]));
  return spec.map(({ propertyId, fn }) => {
    const values = rows.map((row) => options.valueFor(row, propertyId));
    const result = aggregate(values, fn, aggregateOptionsFor(byId.get(propertyId)));
    return {
      propertyId,
      fn,
      value: result.value,
      display: result.display,
      empty: result.value === null,
    };
  });
}

export type GroupFooter<TRow> = GroupedRows<TRow> & { footers: FooterColumnResult[] };

/**
 * Group aggregation (R89.4): attach the same spec's footers to every group,
 * computed over that group's rows. New objects; rows/labels/order preserved.
 */
export function forGroup<TRow>(
  groups: readonly GroupedRows<TRow>[],
  spec: FooterSpec,
  options: ComputeFooterOptions<TRow>,
): GroupFooter<TRow>[] {
  return groups.map((group) => ({ ...group, footers: computeFooter(spec, group.rows, options) }));
}

export type DescribeFooterOptions = {
  propertyName: (propertyId: string) => string;
  fnLabel: (fn: AggregationFn) => string;
};

/** Human-readable labels, e.g. `["Estimate: Sum"]`, for menus/tooltips. */
export function describeFooter(spec: FooterSpec, options: DescribeFooterOptions): string[] {
  return spec.map(({ propertyId, fn }) => `${options.propertyName(propertyId)}: ${options.fnLabel(fn)}`);
}

/**
 * Combine several specs (e.g. a view's own footer + inherited linked-view
 * overrides) into one. Later specs win for the same property; position is
 * first-appearance. Inputs are not mutated.
 */
export function mergeFooters(specs: readonly FooterSpec[]): FooterSpec {
  const byProperty = new Map<string, AggregationFn>();
  for (const spec of specs) {
    for (const { propertyId, fn } of spec) {
      byProperty.set(propertyId, fn);
    }
  }
  return [...byProperty].map(([propertyId, fn]) => ({ propertyId, fn }));
}

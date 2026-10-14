/**
 * Chart view series builders. Pure logic — no DB, no UI, no chart library.
 *
 * Turns database rows plus a chart config into ready-to-render series by
 * stacking on the aggregations lib (`src/lib/aggregations.ts`): `groupRows`
 * buckets rows by the group-by property, `aggregateGroups`/`aggregate` compute
 * the per-group value (and reuse their numeric-only filter for sum-like
 * functions), and `propertyValueOf` reads cells. Nothing here re-implements
 * aggregation math — a chart is just a grouping plus one aggregation rendered
 * as categories/slices.
 */

import {
  AGGREGATION_FUNCTIONS,
  aggregate,
  aggregateGroups,
  groupRows,
  propertyValueOf,
  type AggregationFn,
  type GroupAggregationSpec,
  type GroupedRows,
  type RowWithPropertyValues,
} from "@/lib/aggregations";

export type ChartType = "bar" | "line" | "pie" | "donut";

export type ChartConfig = {
  type: ChartType;
  /** Property to bucket rows by (select/multi-select/text/date…). Omit for a single aggregate over all rows. */
  groupByPropertyId?: string;
  /** Cell the aggregation reads (e.g. a NUMBER property for sums). Omit to aggregate row counts. */
  valuePropertyId?: string;
  /** Same vocabulary as the table footer (`AggregationFn`). */
  aggregateFn: AggregationFn;
  /** Include the "Empty" bucket of rows missing the group-by value. Defaults to true. */
  showEmpty?: boolean;
  /** Order categories/slices by aggregated value; ties keep first-appearance order, nulls stay last. */
  sortCategories?: "asc" | "desc";
  /** Keep the N largest slices by value and bucket the rest into `otherLabel` (recomputed from their rows). */
  limitSlices?: ChartLimitOptions;
};

export type ChartLimitOptions = {
  /** Number of top slices to keep. Values < 1 or non-finite disable limiting. */
  limit: number;
  /** Label of the bucketed remainder. Defaults to `OTHER_SLICE_LABEL`. */
  otherLabel?: string;
};

/** Minimal property shape for label/name lookup; a `DBProperty[]` is assignable. */
export type ChartProperty = {
  id: string;
  name: string;
  config?: { options?: { id: string; name: string }[] } | null;
};

export type ChartSeriesEntry = { name: string; values: (number | null)[] };
export type BarLineChartSeries = { categories: string[]; series: ChartSeriesEntry[] };
export type PieChartSeries = { slices: { label: string; value: number }[] };
export type ChartSeriesResult = BarLineChartSeries | PieChartSeries;

/** Category/slice label when the config has no group-by property. */
export const ALL_ROWS_LABEL = "All";
/** Default label of the bucketed remainder of `limitSlices`. */
export const OTHER_SLICE_LABEL = "Other";
/** Series name when a configured value property cannot be resolved in `props`. */
export const VALUE_FALLBACK_LABEL = "Value";

/** One bucket on its way to becoming a category (bar/line) or a slice (pie/donut). */
type ChartItem<TRow> = {
  key: string;
  label: string;
  rows: TRow[];
  value: number | null;
};

function seriesName(config: ChartConfig, props: readonly ChartProperty[]): string {
  if (config.valuePropertyId) {
    const property = props.find((entry) => entry.id === config.valuePropertyId);
    return property?.name ?? VALUE_FALLBACK_LABEL;
  }
  return AGGREGATION_FUNCTIONS.find((entry) => entry.id === config.aggregateFn)?.label ?? VALUE_FALLBACK_LABEL;
}

/** Prefer the option display name over the raw option id when the group-by property has matching options. */
function categoryLabel<TRow>(
  group: Pick<GroupedRows<TRow>, "key" | "label">,
  groupByProperty: ChartProperty | undefined,
): string {
  if (group.key === "") return group.label;
  const option = groupByProperty?.config?.options?.find((entry) => entry.id === group.key);
  return option ? option.name : group.label;
}

/** Stable value sort: nulls always last, ties keep first-appearance order (Array#sort is stable). */
function byValue<TRow>(items: readonly ChartItem<TRow>[], direction: "asc" | "desc"): ChartItem<TRow>[] {
  return [...items].sort((a, b) => {
    if (a.value === null && b.value === null) return 0;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return direction === "asc" ? a.value - b.value : b.value - a.value;
  });
}

/**
 * Keep the N largest items by value and bucket the rest into one "Other" item.
 * The remainder's value is recomputed by aggregating *its rows* (not the
 * dropped values), so averages/medians stay mathematically correct for any
 * `AggregationFn`. Invalid limits leave the items untouched.
 */
function withOtherBucket<TRow>(
  items: readonly ChartItem<TRow>[],
  opts: ChartLimitOptions,
  extractor: (row: TRow) => unknown,
  fn: AggregationFn,
): ChartItem<TRow>[] {
  const { limit, otherLabel = OTHER_SLICE_LABEL } = opts;
  if (!Number.isFinite(limit) || limit < 1 || items.length <= limit) return [...items];
  const ranked = byValue(items, "desc");
  const keptKeys = new Set(ranked.slice(0, limit).map((item) => item.key));
  const kept = items.filter((item) => keptKeys.has(item.key));
  const rest = items.filter((item) => !keptKeys.has(item.key));
  const restRows = rest.flatMap((item) => item.rows);
  return [
    ...kept,
    {
      key: OTHER_SLICE_LABEL,
      label: otherLabel,
      rows: restRows,
      value: aggregate(restRows.map(extractor), fn).value,
    },
  ];
}

/**
 * Build the ready-to-render series for a chart view.
 *
 * - bar/line → `{ categories, series }` (one series; `null` marks a group with
 *   no aggregatable value).
 * - pie/donut → `{ slices }` (groups without a numeric value are omitted).
 * - No group-by → a single category/slice over all rows.
 * - No rows → empty output, never a throw.
 */
export function buildChartSeries<TRow extends RowWithPropertyValues>(
  rows: readonly TRow[],
  config: ChartConfig & { type: "bar" | "line" },
  props: readonly ChartProperty[],
): BarLineChartSeries;
export function buildChartSeries<TRow extends RowWithPropertyValues>(
  rows: readonly TRow[],
  config: ChartConfig & { type: "pie" | "donut" },
  props: readonly ChartProperty[],
): PieChartSeries;
export function buildChartSeries<TRow extends RowWithPropertyValues>(
  rows: readonly TRow[],
  config: ChartConfig,
  props: readonly ChartProperty[],
): ChartSeriesResult;
export function buildChartSeries<TRow extends RowWithPropertyValues>(
  rows: readonly TRow[],
  config: ChartConfig,
  props: readonly ChartProperty[],
): ChartSeriesResult {
  const barLine = config.type === "bar" || config.type === "line";
  if (rows.length === 0) return barLine ? { categories: [], series: [] } : { slices: [] };

  const { valuePropertyId, groupByPropertyId } = config;
  const extractor = valuePropertyId
    ? (row: TRow) => propertyValueOf(row, valuePropertyId)
    : undefined;
  const groupByProperty = groupByPropertyId
    ? props.find((entry) => entry.id === groupByPropertyId)
    : undefined;

  const groups: GroupedRows<TRow>[] = groupByPropertyId
    ? groupRows(rows, (row) => propertyValueOf(row, groupByPropertyId))
    : [{ key: ALL_ROWS_LABEL, label: ALL_ROWS_LABEL, rows: [...rows] }];

  // Omitting the `value` extractor makes aggregateGroups count rows (same as the footer).
  const spec: GroupAggregationSpec<TRow> = extractor
    ? { fn: config.aggregateFn, value: extractor }
    : { fn: config.aggregateFn };
  const aggregated = aggregateGroups(groups, { value: spec });

  let items: ChartItem<TRow>[] = aggregated.map((group) => ({
    key: group.key,
    label: groupByPropertyId ? categoryLabel(group, groupByProperty) : group.label,
    rows: group.rows,
    value: group.aggregates.value.value,
  }));

  if (groupByPropertyId && config.showEmpty === false) {
    items = items.filter((item) => item.key !== "");
  }
  if (config.sortCategories) {
    items = byValue(items, config.sortCategories);
  }
  if (config.limitSlices) {
    items = withOtherBucket(items, config.limitSlices, extractor ?? (() => true), config.aggregateFn);
  }

  if (barLine) {
    return {
      categories: items.map((item) => item.label),
      series: [{ name: seriesName(config, props), values: items.map((item) => item.value) }],
    };
  }
  return {
    slices: items.flatMap((item) => (item.value === null ? [] : [{ label: item.label, value: item.value }])),
  };
}

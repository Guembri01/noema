/**
 * Rollup aggregation over related rows' property values. Pure and tested.
 */

export type RollupFunction =
  | "count"
  | "count_empty"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "median"
  | "range"
  | "earliest"
  | "latest"
  | "checked"
  | "percent_checked"
  | "percent_empty"
  | "unique"
  | "show_original";

export const ROLLUP_FUNCTIONS: { id: RollupFunction; label: string }[] = [
  { id: "count", label: "Count all" },
  { id: "count_empty", label: "Count empty" },
  { id: "sum", label: "Sum" },
  { id: "avg", label: "Average" },
  { id: "min", label: "Min" },
  { id: "max", label: "Max" },
  { id: "median", label: "Median" },
  { id: "range", label: "Range" },
  { id: "earliest", label: "Earliest date" },
  { id: "latest", label: "Latest date" },
  { id: "checked", label: "Checked" },
  { id: "percent_checked", label: "Percent checked" },
  { id: "percent_empty", label: "Percent empty" },
  { id: "unique", label: "Unique values" },
  { id: "show_original", label: "Show original" },
];

export type RollupValue = number | string | boolean | null | undefined;

const isEmpty = (value: RollupValue): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "");

const numbers = (values: RollupValue[]): number[] =>
  values
    .filter((value) => !isEmpty(value))
    .map((value) =>
      typeof value === "boolean" ? Number(value) : Number(String(value).replace(/[^0-9.eE+-]/g, "")),
    )
    .filter((value) => Number.isFinite(value));

function aggregateNumeric(values: RollupValue[], fn: RollupFunction): number | null {
  const nums = numbers(values);
  if (nums.length === 0) return null;
  switch (fn) {
    case "sum":
      return nums.reduce((total, value) => total + value, 0);
    case "avg":
      return nums.reduce((total, value) => total + value, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    case "median": {
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }
    case "range":
      return Math.max(...nums) - Math.min(...nums);
    default:
      return null;
  }
}

export function aggregate(
  values: RollupValue[],
  fn: RollupFunction,
  options: { separator?: string } = {},
): string {
  const present = values.filter((value) => !isEmpty(value));
  switch (fn) {
    case "count":
      return String(present.length);
    case "count_empty":
      return String(values.filter(isEmpty).length);
    case "checked":
      return String(values.filter((value) => value === true).length);
    case "percent_checked": {
      const total = values.filter((value) => typeof value === "boolean").length;
      if (total === 0) return "0%";
      const done = values.filter((value) => value === true).length;
      return `${Math.round((done / total) * 100)}%`;
    }
    case "percent_empty": {
      if (values.length === 0) return "—";
      const empty = values.filter(isEmpty).length;
      return `${Math.round((empty / values.length) * 100)}%`;
    }
    case "unique":
      return String(new Set(present.map((value) => String(value))).size);
    case "earliest":
    case "latest": {
      const times = present
        .map((value) => new Date(String(value)).getTime())
        .filter((time) => Number.isFinite(time));
      if (times.length === 0) return "—";
      const pick = fn === "earliest" ? Math.min(...times) : Math.max(...times);
      return new Date(pick).toISOString().slice(0, 10);
    }
    case "show_original":
      return present.map((value) => String(value)).join(options.separator ?? ", ") || "—";
    default: {
      const result = aggregateNumeric(present, fn);
      if (result === null) return "—";
      return Number.isInteger(result) ? String(result) : result.toFixed(2);
    }
  }
}

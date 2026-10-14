/**
 * Pure, testable query layer for database views.
 *
 * A view's saved `config` (filters, sorts, grouping, hidden properties) is
 * applied to rows entirely in memory. Keeping this logic pure means it can be
 * unit-tested without a database or a browser, and reused by the server later.
 */

import { formatGeo, parseGeo } from "@/lib/geo";

export type PropertyOption = {
  id: string;
  name: string;
  color: string;
  /** STATUS only: which bucket this option belongs to (board columns). */
  group?: string;
};

export type PropertyConfig = {
  primary?: boolean;
  options?: PropertyOption[];
  groupByPropertyId?: string | null;
  /** NUMBER: "number" | "percent" | "currency". DATE: "date" | "friendly". */
  format?: string;
  /** NUMBER + format "currency": ISO 4217 code (defaults to USD). */
  currency?: string;
} | null;

export type QueryProperty = {
  id: string;
  name: string;
  type: string;
  config: PropertyConfig;
};

export type QueryRow = {
  id: string;
  title: string;
  icon: string | null;
  propertyValues: { propertyId: string; value: unknown }[];
};

export type FilterOperator =
  | "is"
  | "is_not"
  | "contains"
  | "does_not_contain"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "before"
  | "after"
  | "checked"
  | "unchecked";

export type Filter = {
  propertyId: string;
  operator: FilterOperator;
  value?: string;
};

/** A filter tree node: a leaf filter, or an AND/OR group of nodes. */
export type FilterNode = Filter | { and: FilterNode[] } | { or: FilterNode[] };

/** Where a colour rule's tint lands: the whole row (default) or one cell. */
export type ColorRuleTarget = "row" | "cell";

export type ColorRule = {
  propertyId: string;
  operator: FilterOperator;
  value?: string;
  color: string;
  /**
   * `"row"` tints the whole row, `"cell"` tints only `propertyId`'s cell
   * (`cellColorFor`). Absent means `"row"`, so rules saved before this field
   * existed keep painting rows.
   */
  target?: ColorRuleTarget;
};

export type Sort = { propertyId: string; direction: "asc" | "desc" };

export type ViewConfig = {
  filters?: Filter[];
  filterMode?: "and" | "or";
  filterTree?: FilterNode[];
  sorts?: Sort[];
  groupByPropertyId?: string | null;
  visiblePropertyIds?: string[];
  freezeFirstColumn?: boolean;
  colorRules?: ColorRule[];
};

type OperatorSpec = { value: FilterOperator; label: string };

/** Text-shaped operators, shared by every non-checkbox property type. */
const TEXT_OPERATORS: OperatorSpec[] = [
  { value: "contains", label: "contains" },
  { value: "does_not_contain", label: "does not contain" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const COMPARISON_OPERATORS: OperatorSpec[] = [
  { value: "gt", label: "greater than" },
  { value: "gte", label: "greater than or equal" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "less than or equal" },
];

const DATE_OPERATORS: OperatorSpec[] = [
  { value: "before", label: "is before" },
  { value: "after", label: "is after" },
];

const CHECKBOX_OPERATORS: OperatorSpec[] = [
  { value: "checked", label: "is checked" },
  { value: "unchecked", label: "is unchecked" },
];

/**
 * PLACE cells have no scalar column to compare: `formatCell` renders them as
 * the label plus coordinates, so only that text is searchable. Distance/radius
 * filters are deliberately out of scope for this in-memory layer.
 */
const PLACE_OPERATORS: OperatorSpec[] = [
  { value: "contains", label: "contains" },
  { value: "does_not_contain", label: "does not contain" },
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

/** Every operator the app can evaluate, used to validate stored configs. */
export const FILTER_OPERATORS: readonly FilterOperator[] = [
  ...new Set<FilterOperator>([
    ...TEXT_OPERATORS,
    ...COMPARISON_OPERATORS,
    ...DATE_OPERATORS,
    ...CHECKBOX_OPERATORS,
  ].map((op) => op.value)),
];

export function isFilterOperator(value: unknown): value is FilterOperator {
  return (
    typeof value === "string" &&
    (FILTER_OPERATORS as readonly string[]).includes(value)
  );
}

/**
 * The operator catalogue offered for one property type (filter rows, colour
 * rules). Checkbox gets only the boolean set; dates get chronological
 * operators; numbers get the numeric comparison set.
 */
export function operatorsFor(type: string): OperatorSpec[] {
  if (type === "CHECKBOX") return [...CHECKBOX_OPERATORS];
  if (type === "NUMBER") return [...COMPARISON_OPERATORS, ...TEXT_OPERATORS];
  if (type === "DATE") return [...DATE_OPERATORS, ...COMPARISON_OPERATORS, ...TEXT_OPERATORS];
  if (type === "PLACE") return [...PLACE_OPERATORS];
  return [...TEXT_OPERATORS];
}

export function getValue(row: QueryRow, propertyId: string): unknown {
  return row.propertyValues.find((v) => v.propertyId === propertyId)?.value;
}

/**
 * Value for a property, with the primary-property fallback: the primary column
 * is backed by `row.title`, which is not stored as a property value.
 */
export function rowValue(row: QueryRow, property: QueryProperty): unknown {
  const direct = getValue(row, property.id);
  if (direct !== undefined && direct !== null) return direct;
  if (property.config?.primary) return { text: row.title };
  return direct;
}

/**
 * Normalise a stored MULTI_SELECT value: first-occurrence order, duplicates
 * and ids that no longer exists are dropped. Reads and writes both go through
 * this so a stored value can never render (or re-save) out of order or twice.
 */
export function normalizeOptionIds(
  raw: unknown,
  options: PropertyOption[] | undefined,
): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set((options ?? []).map((option) => option.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !known.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/* --- Status groups (To-do / In-progress / Done → board columns) ---------- */

export type StatusGroup = "todo" | "doing" | "done";

export const STATUS_GROUPS: readonly StatusGroup[] = ["todo", "doing", "done"] as const;

export const STATUS_GROUP_NAMES: Record<StatusGroup, string> = {
  todo: "To-do",
  doing: "In progress",
  done: "Done",
};

export const STATUS_GROUP_COLORS: Record<StatusGroup, string> = {
  todo: "gray",
  doing: "yellow",
  done: "green",
};

/** The bucket a status option belongs to (`null` when ungrouped). */
export function statusGroupOf(
  property: QueryProperty,
  optionId: string | undefined | null,
): StatusGroup | null {
  if (!optionId || property.type !== "STATUS") return null;
  const option = property.config?.options?.find((candidate) => candidate.id === optionId);
  const group = option?.group;
  return group === "todo" || group === "doing" || group === "done" ? group : null;
}

/** True when at least one status option declares a bucket (grouped board). */
export function hasStatusGroups(property: QueryProperty): boolean {
  return (
    property.type === "STATUS" &&
    (property.config?.options ?? []).some((option) =>
      STATUS_GROUPS.includes(option.group as StatusGroup),
    )
  );
}

/**
 * Board columns for a grouped STATUS property: the three buckets in product
 * order, then "No value". Rows whose option has no bucket (or no value at
 * all) fall to the trailing column, so nothing is ever silently dropped.
 */
export function statusGroupColumns(
  rows: QueryRow[],
  properties: QueryProperty[],
  groupByPropertyId: string,
  noValueName: string,
): RowGroup[] {
  const property = properties.find((candidate) => candidate.id === groupByPropertyId);
  const columns: RowGroup[] = STATUS_GROUPS.map((id) => ({
    id,
    name: STATUS_GROUP_NAMES[id],
    color: STATUS_GROUP_COLORS[id],
    rows: [],
  }));
  const noValue: RowGroup = { id: "__none", name: noValueName, color: "gray", rows: [] };
  if (!property) return [...columns, noValue];

  for (const row of rows) {
    const value = (rowValue(row, property) ?? {}) as { optionId?: string };
    const group = statusGroupOf(property, value.optionId) ?? "__none";
    const target =
      (group !== "__none" ? columns.find((column) => column.id === group) : null) ??
      noValue;
    target.rows.push(row);
  }

  return [...columns, noValue];
}

/** Stable display string for a cell value. */
export function formatCell(value: unknown, property: QueryProperty): string {
  const v = (value ?? {}) as Record<string, unknown>;
  const optionName = (id: unknown) =>
    property.config?.options?.find((o) => o.id === id)?.name ?? "";
  switch (property.type) {
    case "NUMBER": {
      if (v.number === undefined || v.number === null) return "";
      const format = property.config?.format;
      if (format === "percent" || format === "currency") {
        const n = Number(v.number);
        if (!Number.isFinite(n)) return "";
        if (format === "percent") {
          // Stored as a fraction (0.075 → 7.5%); maximumFractionDigits kills
          // the float noise (0.1 * 100 === 10.000000000000002).
          return `${(n * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
        }
        const currency = property.config?.currency === "EUR" ? "EUR" : "USD";
        // Fixed locale: server and client must render byte-identically.
        return n.toLocaleString("en-US", { style: "currency", currency });
      }
      return String(v.number);
    }
    case "SELECT":
    case "STATUS":
      return optionName(v.optionId);
    case "MULTI_SELECT":
      return normalizeOptionIds(v.optionIds, property.config?.options)
        .map(optionName)
        .filter(Boolean)
        .join(", ");
    case "DATE": {
      if (typeof v.start !== "string") return "";
      const day = v.start.slice(0, 10);
      if (property.config?.format === "friendly") {
        const parsed = Date.parse(`${day}T00:00:00.000Z`);
        if (!Number.isNaN(parsed)) {
          // Fixed locale + UTC: hydration-safe and stable across timezones.
          return new Intl.DateTimeFormat("en-GB", {
            dateStyle: "medium",
            timeZone: "UTC",
          }).format(parsed);
        }
      }
      return day;
    }
    case "CHECKBOX":
      return v.checked ? "Yes" : "No";
    case "PEOPLE":
      return ((v.names as string[]) ?? []).join(", ");
    case "FILES":
      return ((v.files as { name: string }[]) ?? []).map((f) => f.name).join(", ");
    case "PLACE": {
      // Same rendering the PLACE cell uses, so search/filter text matches what
      // the user sees: `label · "lat, lng"` (or just the coordinates).
      const parsed = parseGeo(value);
      if (!parsed.ok) return "";
      const coords = formatGeo(parsed.value);
      return parsed.value.label ? `${parsed.value.label} · ${coords}` : coords;
    }
    default:
      return typeof v.text === "string" ? v.text : "";
  }
}

/** Lower-cased, comparable text used by filters. */
export function searchText(value: unknown, property: QueryProperty): string {
  return formatCell(value, property).toLowerCase();
}

/**
 * Comparable scalar for ordering and comparison filters: numbers/dates compare
 * chronologically, everything else by lower-cased text. `null` means "no
 * comparable value" (an empty cell or an unparseable one).
 */
function comparable(value: unknown, property: QueryProperty): number | string | null {
  const v = (value ?? {}) as Record<string, unknown>;
  if (property.type === "NUMBER") {
    return typeof v.number === "number" && Number.isFinite(v.number) ? v.number : null;
  }
  if (property.type === "DATE") {
    const start = typeof v.start === "string" ? Date.parse(v.start) : NaN;
    return Number.isNaN(start) ? null : start;
  }
  if (property.type === "CHECKBOX") return v.checked ? 1 : 0;
  const text = searchText(value, property);
  return text === "" ? null : text;
}

/** Parse the filter's target value for this property type (`null` = invalid). */
function parseTarget(target: string, property: QueryProperty): number | string | null {
  if (property.type === "NUMBER") {
    const raw = target.trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (property.type === "DATE") {
    const parsed = Date.parse(target.trim());
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (property.type === "CHECKBOX") return null;
  return target.toLowerCase();
}

function compareScalars(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function sortKey(value: unknown, property: QueryProperty): number | string {
  const key = comparable(value, property);
  return key === null ? Number.NEGATIVE_INFINITY : key;
}

export function compareValues(
  a: unknown,
  b: unknown,
  property: QueryProperty,
): number {
  return compareScalars(sortKey(a, property), sortKey(b, property));
}

/**
 * Evaluate one of the ordered comparison operators. Both sides are parsed for
 * the property type, so `gt` on a date compares chronologically and an
 * unparseable target never matches.
 */
function matchesComparison(
  operator: FilterOperator,
  value: unknown,
  target: string,
  property: QueryProperty,
): boolean {
  const a = comparable(value, property);
  const b = parseTarget(target, property);
  if (a === null || b === null) return false;
  const cmp = compareScalars(a, b);
  switch (operator) {
    case "gt":
    case "after":
      return cmp > 0;
    case "gte":
      return cmp >= 0;
    case "lt":
    case "before":
      return cmp < 0;
    case "lte":
      return cmp <= 0;
    default:
      return false;
  }
}

function matches(row: QueryRow, filter: Filter, property: QueryProperty): boolean {
  const value = rowValue(row, property);
  const text = searchText(value, property);
  const target = (filter.value ?? "").toLowerCase();
  switch (filter.operator) {
    case "is":
      return text === target;
    case "is_not":
      return text !== target;
    case "contains":
      return text.includes(target);
    case "does_not_contain":
      return !text.includes(target);
    case "starts_with":
      return text.startsWith(target);
    case "ends_with":
      return text.endsWith(target);
    case "is_empty":
      return text.trim() === "";
    case "is_not_empty":
      return text.trim() !== "";
    case "checked":
      return Boolean((value as { checked?: boolean} | undefined)?.checked);
    case "unchecked":
      return !Boolean((value as { checked?: boolean } | undefined)?.checked);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "before":
    case "after":
      return matchesComparison(filter.operator, value, filter.value ?? "", property);
    default:
      // An operator we cannot evaluate must not silently show every row.
      return false;
  }
}

export function applyFilters(
  rows: QueryRow[],
  properties: QueryProperty[],
  filters: Filter[] | undefined,
  mode: "and" | "or" = "and",
): QueryRow[] {
  if (!filters || filters.length === 0) return rows;
  const byId = new Map(properties.map((p) => [p.id, p]));
  return rows.filter((row) => {
    const evaluator = (filter: Filter) => {
      const property = byId.get(filter.propertyId);
      if (!property) return true;
      return matches(row, filter, property);
    };
    return mode === "or" ? filters.some(evaluator) : filters.every(evaluator);
  });
}

/** Evaluate a nested AND/OR filter tree. */
export function applyFilterTree(
  rows: QueryRow[],
  properties: QueryProperty[],
  nodes: FilterNode[] | undefined,
  mode: "and" | "or" = "and",
): QueryRow[] {
  if (!nodes || nodes.length === 0) return rows;
  const byId = new Map(properties.map((p) => [p.id, p]));
  const evaluate = (row: QueryRow, node: FilterNode): boolean => {
    if ("and" in node) return node.and.every((child) => evaluate(row, child));
    if ("or" in node) return node.or.some((child) => evaluate(row, child));
    const property = byId.get(node.propertyId);
    if (!property) return true;
    return matches(row, node, property);
  };
  return rows.filter((row) =>
    mode === "or" ? nodes.some((node) => evaluate(row, node)) : nodes.every((node) => evaluate(row, node)),
  );
}

/** Resolve a row's conditional color from a set of rules (first match wins). */
export function rowColor(
  row: QueryRow,
  properties: QueryProperty[],
  rules: ColorRule[] | undefined,
): string | null {
  if (!rules || rules.length === 0) return null;
  const byId = new Map(properties.map((p) => [p.id, p]));
  for (const rule of rules) {
    // Cell rules paint one cell (`cellColorFor`), never the whole row.
    if (rule.target === "cell") continue;
    const property = byId.get(rule.propertyId);
    if (!property) continue;
    if (matches(row, rule, property)) return rule.color;
  }
  return null;
}

/**
 * Multi-key comparator. Sorts are evaluated in priority order; the first key
 * that decides wins, rows without a value are always pushed to the end (both
 * ascending and descending, like the product), and a complete tie falls
 * through to the next sort key.
 */
export function compareBySorts(
  a: QueryRow,
  b: QueryRow,
  properties: QueryProperty[],
  sorts: Sort[],
): number {
  const byId = new Map(properties.map((p) => [p.id, p]));
  for (const sort of sorts) {
    const property = byId.get(sort.propertyId);
    if (!property) continue;
    const ka = comparable(rowValue(a, property), property);
    const kb = comparable(rowValue(b, property), property);
    const aEmpty = ka === null;
    const bEmpty = kb === null;
    if (aEmpty || bEmpty) {
      if (aEmpty && bEmpty) continue;
      return aEmpty ? 1 : -1;
    }
    const cmp = compareScalars(ka, kb);
    if (cmp !== 0) return sort.direction === "desc" ? -cmp : cmp;
  }
  return 0;
}

export function applySorts(
  rows: QueryRow[],
  properties: QueryProperty[],
  sorts: Sort[] | undefined,
): QueryRow[] {
  if (!sorts || sorts.length === 0) return rows;
  return [...rows].sort((a, b) => compareBySorts(a, b, properties, sorts));
}

/** Append a sort unless that property is already a sort key (priority order). */
export function addSort(
  sorts: Sort[],
  propertyId: string,
  direction: Sort["direction"] = "asc",
): Sort[] {
  if (!propertyId || sorts.some((sort) => sort.propertyId === propertyId)) {
    return sorts;
  }
  return [...sorts, { propertyId, direction }];
}

export function removeSort(sorts: Sort[], propertyId: string): Sort[] {
  return sorts.filter((sort) => sort.propertyId !== propertyId);
}

/** Move a sort key to another priority slot (out-of-range moves are no-ops). */
export function moveSort(sorts: Sort[], from: number, to: number): Sort[] {
  if (from === to || from < 0 || to < 0 || from >= sorts.length || to >= sorts.length) {
    return sorts;
  }
  const next = [...sorts];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Append a filter unless the same property+operator row already exists. */
export function addFilter(filters: Filter[], filter: Filter): Filter[] {
  const exists = filters.some(
    (candidate) =>
      candidate.propertyId === filter.propertyId &&
      candidate.operator === filter.operator,
  );
  return exists ? filters : [...filters, filter];
}

export type RowGroup = {
  id: string;
  name: string;
  color: string;
  rows: QueryRow[];
};

const NO_VALUE = { id: "__none", name: "No value", color: "gray" };

export function groupRows(
  rows: QueryRow[],
  properties: QueryProperty[],
  groupByPropertyId: string | null | undefined,
): RowGroup[] | null {
  if (!groupByPropertyId) return null;
  const property = properties.find((p) => p.id === groupByPropertyId);
  if (!property) return null;
  const options = property.config?.options ?? [];
  const groups: RowGroup[] = options.map((o) => ({
    id: o.id,
    name: o.name,
    color: o.color,
    rows: [],
  }));
  const noValue: RowGroup = { ...NO_VALUE, rows: [] };

  for (const row of rows) {
    const value = (rowValue(row, property) ?? {}) as {
      optionId?: string;
      optionIds?: string[];
    };
    const ids =
      property.type === "MULTI_SELECT"
        ? value.optionIds ?? []
        : value.optionId
          ? [value.optionId]
          : [];
    if (ids.length === 0) {
      noValue.rows.push(row);
      continue;
    }
    for (const id of ids) {
      const group = groups.find((g) => g.id === id);
      if (group) group.rows.push(row);
    }
  }

  const result = groups.filter((g) => g.rows.length > 0);
  if (noValue.rows.length > 0) result.push(noValue);
  return result;
}

export function applyView(
  rows: QueryRow[],
  properties: QueryProperty[],
  config: ViewConfig,
): { rows: QueryRow[]; groups: RowGroup[] | null } {
  const filtered = config.filterTree
    ? applyFilterTree(rows, properties, config.filterTree, config.filterMode ?? "and")
    : applyFilters(rows, properties, config.filters, config.filterMode ?? "and");
  const sorted = applySorts(filtered, properties, config.sorts);
  const groups = groupRows(sorted, properties, config.groupByPropertyId);
  return { rows: sorted, groups };
}

/* ---------------------------------------------------------------------------
   Per-view configuration serialization
   A view's `config` column is untyped JSON: it is written by the browser and
   read back on every render, so it is normalised on write and parsed on read.
   Anything the app cannot evaluate (unknown operator, bogus direction, stray
   key from an older build) is dropped instead of silently changing results.
   --------------------------------------------------------------------------- */

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function normalizeFilter(input: unknown): Filter | null {
  const record = asRecord(input);
  if (!record) return null;
  if (typeof record.propertyId !== "string" || record.propertyId === "") return null;
  if (!isFilterOperator(record.operator)) return null;
  const filter: Filter = {
    propertyId: record.propertyId,
    operator: record.operator,
  };
  if (typeof record.value === "string") filter.value = record.value;
  return filter;
}

function normalizeFilterNode(input: unknown): FilterNode | null {
  const record = asRecord(input);
  if (!record) return null;
  if (Array.isArray(record.and)) {
    const children = record.and.map(normalizeFilterNode).filter((n): n is FilterNode => n !== null);
    return children.length > 0 ? { and: children } : null;
  }
  if (Array.isArray(record.or)) {
    const children = record.or.map(normalizeFilterNode).filter((n): n is FilterNode => n !== null);
    return children.length > 0 ? { or: children } : null;
  }
  return normalizeFilter(record);
}

function normalizeSort(input: unknown): Sort | null {
  const record = asRecord(input);
  if (!record) return null;
  if (typeof record.propertyId !== "string" || record.propertyId === "") return null;
  return {
    propertyId: record.propertyId,
    direction: record.direction === "desc" ? "desc" : "asc",
  };
}

function normalizeColorRule(input: unknown): ColorRule | null {
  const record = asRecord(input);
  if (!record) return null;
  if (typeof record.propertyId !== "string" || record.propertyId === "") return null;
  if (!isFilterOperator(record.operator)) return null;
  if (typeof record.color !== "string" || record.color === "") return null;
  const rule: ColorRule = {
    propertyId: record.propertyId,
    operator: record.operator,
    color: record.color,
  };
  if (typeof record.value === "string") rule.value = record.value;
  // Keep an explicit target; an absent/unknown one stays absent and reads as
  // "row" downstream, so old configs round-trip unchanged.
  if (record.target === "row" || record.target === "cell") {
    rule.target = record.target;
  }
  return rule;
}

function uniqueStrings(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const seen: string[] = [];
  for (const entry of input) {
    if (typeof entry === "string" && entry !== "" && !seen.includes(entry)) {
      seen.push(entry);
    }
  }
  return seen;
}

/** Strip a stored/patched view config down to the keys this build understands. */
export function normalizeViewConfig(input: unknown): ViewConfig {
  const record = asRecord(input);
  if (!record) return {};
  const out: ViewConfig = {};

  if (Array.isArray(record.filters)) {
    out.filters = record.filters
      .map(normalizeFilter)
      .filter((filter): filter is Filter => filter !== null);
  }
  if (Array.isArray(record.filterTree)) {
    const nodes = record.filterTree
      .map(normalizeFilterNode)
      .filter((node): node is FilterNode => node !== null);
    if (nodes.length > 0) out.filterTree = nodes;
  }
  if ("filterMode" in record) {
    out.filterMode = record.filterMode === "or" ? "or" : "and";
  }
  if (Array.isArray(record.sorts)) {
    const seen = new Set<string>();
    const sorts: Sort[] = [];
    for (const entry of record.sorts) {
      const sort = normalizeSort(entry);
      if (!sort || seen.has(sort.propertyId)) continue;
      seen.add(sort.propertyId);
      sorts.push(sort);
    }
    out.sorts = sorts;
  }
  if (typeof record.groupByPropertyId === "string" || record.groupByPropertyId === null) {
    out.groupByPropertyId = record.groupByPropertyId as string | null;
  }
  const visible = uniqueStrings(record.visiblePropertyIds);
  if (visible) out.visiblePropertyIds = visible;
  if (typeof record.freezeFirstColumn === "boolean") {
    out.freezeFirstColumn = record.freezeFirstColumn;
  }
  if (Array.isArray(record.colorRules)) {
    out.colorRules = record.colorRules
      .map(normalizeColorRule)
      .filter((rule): rule is ColorRule => rule !== null);
  }
  return out;
}

/**
 * Read a view config from storage. Accepts the JSON string Prisma hands back
 * as well as an already-parsed object; malformed input yields `{}`.
 */
export function parseViewConfig(input: unknown): ViewConfig {
  if (typeof input === "string") {
    try {
      return normalizeViewConfig(JSON.parse(input));
    } catch {
      return {};
    }
  }
  return normalizeViewConfig(input);
}

/**
 * The columns a view renders: primary property first, then the visible ones in
 * property order. A view with no visibility list shows everything, the primary
 * column can never be hidden, and an explicit (even empty) list is honoured —
 * so "hide every secondary column" is a real, persisted state.
 */
export function visibleColumns(
  properties: QueryProperty[],
  config: ViewConfig | null | undefined,
): QueryProperty[] {
  const primary = properties.find((p) => p.config?.primary) ?? properties[0] ?? null;
  const rest = properties.filter((p) => p.id !== primary?.id);
  const ids = config?.visiblePropertyIds;
  const visible = ids === undefined ? null : new Set(ids);
  const filtered = visible ? rest.filter((p) => visible.has(p.id)) : rest;
  return primary ? [primary, ...filtered] : filtered;
}

export type ChartDatum = { id: string; label: string; color: string; count: number };

/** Aggregate row counts by a select/status property (for Chart views). */
export function chartData(
  rows: QueryRow[],
  properties: QueryProperty[],
  propertyId: string | null | undefined,
): ChartDatum[] {
  if (!propertyId) return [];
  const property = properties.find((p) => p.id === propertyId);
  if (!property) return [];
  const options = property.config?.options ?? [];
  const buckets = new Map<string, ChartDatum>();
  for (const option of options) {
    buckets.set(option.id, {
      id: option.id,
      label: option.name,
      color: option.color,
      count: 0,
    });
  }
  const none: ChartDatum = { id: "__none", label: "No value", color: "gray", count: 0 };
  for (const row of rows) {
    const value = (rowValue(row, property) ?? {}) as { optionId?: string; optionIds?: string[] };
    const ids = property.type === "MULTI_SELECT" ? value.optionIds ?? [] : value.optionId ? [value.optionId] : [];
    if (ids.length === 0) {
      none.count += 1;
      continue;
    }
    for (const id of ids) {
      const bucket = buckets.get(id);
      if (bucket) bucket.count += 1;
    }
  }
  const result = [...buckets.values()].filter((bucket) => bucket.count > 0);
  if (none.count > 0) result.push(none);
  return result;
}

export type TimelineBar = {
  rowId: string;
  title: string;
  startISO: string;
  endISO: string;
  offsetPct: number;
  widthPct: number;
};

/**
 * Position rows on a timeline from a date property. Bars use `end` when present,
 * otherwise a single-day span. `offsetPct`/`widthPct` are relative to [from, to].
 */
export function timelineData(
  rows: QueryRow[],
  properties: QueryProperty[],
  datePropertyId: string | null | undefined,
  from: Date,
  to: Date,
): TimelineBar[] {
  if (!datePropertyId) return [];
  const property = properties.find((p) => p.id === datePropertyId);
  if (!property) return [];
  const span = Math.max(1, to.getTime() - from.getTime());
  const bars: TimelineBar[] = [];
  for (const row of rows) {
    const value = (rowValue(row, property) ?? {}) as { start?: string; end?: string };
    if (!value.start) continue;
    const start = new Date(value.start);
    const end = value.end ? new Date(value.end) : new Date(start.getTime() + 86_400_000);
    if (Number.isNaN(start.getTime())) continue;
    const offset = Math.max(0, start.getTime() - from.getTime());
    const width = Math.max(86_400_000, end.getTime() - start.getTime());
    bars.push({
      rowId: row.id,
      title: row.title || "Untitled",
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      offsetPct: Math.min(100, (offset / span) * 100),
      widthPct: Math.max(2, Math.min(100, (width / span) * 100)),
    });
  }
  return bars;
}

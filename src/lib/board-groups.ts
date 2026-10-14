/**
 * Board-view grouping — a pure kanban-column engine
 * (docs/MISSING_FEATURES.md §3 rows "Groups" and "Board grouping").
 *
 * `groupRowsByProperty` turns a flat, already-filtered/sorted row list into
 * the ordered columns a board renders: one bucket per declared option of a
 * select / multi-select / status property, in the property's declared option
 * order (optionally overridden per view via `optionOrder`), followed by an
 * "Empty" bucket. A multi-select row lands in **every** matching bucket; a
 * single-select/status row lands in its one bucket (or Empty when the value is
 * absent or references an option that no longer exists). Input order is
 * preserved inside every bucket, and no input is ever mutated.
 *
 * The remaining helpers operate on the produced groups: `visibleGroups` drops
 * hidden columns, `reorderGroups` reorders columns (immutably), and
 * `moveRowBetweenGroups` implements a drag-and-drop card move — relocating the
 * row, appending it to the target bucket, and rewriting its option value (or
 * clearing it for Empty).
 *
 * This is pure logic: no DB, no routes, no React. Rows/properties are generic
 * structural shapes matching `DBRow` / `DBProperty`, and the cell extractor is
 * reused from `@/lib/aggregations` so boards agree with the rest of the app.
 */

import { EMPTY_GROUP_LABEL, propertyValueOf } from "@/lib/aggregations";

/** Minimal row shape (matches `DBRow`): an id plus `propertyValues` cells. */
export type BoardRow = {
  id: string;
  propertyValues: { propertyId: string; value: unknown }[];
};

/** An option of a select / multi-select / status property (matches `PropertyOption`). */
export type BoardPropertyOption = {
  id: string;
  name: string;
  color?: string;
  /** STATUS only: the option's bucket (kept for consumers, unused here). */
  group?: string;
};

/** Minimal property descriptor (matches `DBProperty` / `QueryProperty`). */
export type BoardPropertyDescriptor = {
  id: string;
  name?: string;
  type?: string;
  config?: { options?: BoardPropertyOption[] } | null;
};

/** Key of the trailing "no value" column. */
export const EMPTY_GROUP_KEY = "__empty";

/** One rendered board column. */
export type BoardGroup<TRow extends BoardRow = BoardRow> = {
  /** Option id, or `EMPTY_GROUP_KEY` for the Empty column. */
  key: string;
  /** Display label — the option name, or `EMPTY_GROUP_LABEL`. */
  label: string;
  /** Option id this column represents; `null` for the Empty column. */
  optionId: string | null;
  /** Option colour, when the option declares one. */
  color?: string;
  /** Rows in this column, in input order. */
  rows: TRow[];
};

export type GroupRowsOptions = {
  /**
   * Include zero-row buckets and the trailing Empty bucket (default `true`).
   * Set `false` for Notion's "hide empty groups": buckets with no rows — and
   * the Empty bucket itself — are omitted entirely.
   */
  showEmpty?: boolean;
  /**
   * Per-view column order given as option ids (e.g. a saved status order).
   * Listed ids come first in the listed order; unlisted declared options keep
   * their declared order afterwards; unknown ids are ignored.
   */
  optionOrder?: readonly string[];
};

/**
 * Unwrap a cell into the option ids it references. Handles every stored shape
 * this app writes — `{ optionId }` (select/status), `{ optionIds: [...] }`
 * (multi-select) — plus raw `string` / `string[]` values. Unknown shapes and
 * empty strings read as "no value". Never throws.
 */
function optionIdsOf(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  }
  if (typeof value !== "object") return [];
  const cell = value as { optionId?: unknown; optionIds?: unknown };
  if (Array.isArray(cell.optionIds)) {
    return cell.optionIds.filter(
      (entry): entry is string => typeof entry === "string" && entry !== "",
    );
  }
  if (typeof cell.optionId === "string" && cell.optionId !== "") return [cell.optionId];
  return [];
}

/** Declared options in config order, de-duplicated by id, malformed entries skipped. */
function declaredOptions(property: BoardPropertyDescriptor | undefined): BoardPropertyOption[] {
  const raw = property?.config?.options;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const options: BoardPropertyOption[] = [];
  for (const option of raw) {
    if (!option || typeof option.id !== "string" || option.id === "" || seen.has(option.id)) {
      continue;
    }
    seen.add(option.id);
    options.push(option);
  }
  return options;
}

/** Reorder declared options by an optional id list; unlisted options keep their order. */
function orderOptions(
  options: BoardPropertyOption[],
  optionOrder: readonly string[] | undefined,
): BoardPropertyOption[] {
  if (!optionOrder || optionOrder.length === 0) return options;
  const rank = new Map<string, number>();
  for (const id of optionOrder) {
    if (!rank.has(id)) rank.set(id, rank.size);
  }
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const rankA = rank.get(a.option.id) ?? Number.POSITIVE_INFINITY;
      const rankB = rank.get(b.option.id) ?? Number.POSITIVE_INFINITY;
      return rankA === rankB ? a.index - b.index : rankA - rankB;
    })
    .map((entry) => entry.option);
}

/**
 * Bucket rows into ordered board columns for `groupPropertyId`.
 *
 * Output order: one group per declared option (in declared order, reordered by
 * `optionOrder`), then the Empty group when `showEmpty` is not `false`.
 * Multi-select rows appear in each matching option's bucket; rows whose value
 * matches no declared option fall into Empty. `showEmpty: false` drops every
 * zero-row bucket (including Empty). Input order is preserved within buckets
 * and the input array/rows are never mutated.
 */
export function groupRowsByProperty<TRow extends BoardRow>(
  rows: readonly TRow[],
  props: readonly BoardPropertyDescriptor[],
  groupPropertyId: string,
  options: GroupRowsOptions = {},
): BoardGroup<TRow>[] {
  const showEmpty = options.showEmpty !== false;
  const property = props.find((candidate) => candidate.id === groupPropertyId);
  const declared = orderOptions(declaredOptions(property), options.optionOrder);

  const buckets = new Map<string, BoardGroup<TRow>>();
  const optionGroups: BoardGroup<TRow>[] = declared.map((option) => {
    const group: BoardGroup<TRow> = {
      key: option.id,
      label: option.name,
      optionId: option.id,
      rows: [],
    };
    if (option.color !== undefined) group.color = option.color;
    buckets.set(option.id, group);
    return group;
  });
  const optionIds = new Set(declared.map((option) => option.id));

  const emptyGroup: BoardGroup<TRow> = {
    key: EMPTY_GROUP_KEY,
    label: EMPTY_GROUP_LABEL,
    optionId: null,
    rows: [],
  };

  for (const row of rows) {
    const matched = [
      ...new Set(optionIdsOf(propertyValueOf(row, groupPropertyId)).filter((id) => optionIds.has(id))),
    ];
    if (matched.length === 0) {
      emptyGroup.rows.push(row);
      continue;
    }
    for (const optionId of matched) {
      buckets.get(optionId)?.rows.push(row);
    }
  }

  const groups = showEmpty
    ? optionGroups
    : optionGroups.filter((group) => group.rows.length > 0);
  return showEmpty ? [...groups, emptyGroup] : groups;
}

/** Visibility map: a key mapped to `false` is hidden; missing keys stay visible. */
export type GroupVisibility = Readonly<Record<string, boolean>>;

/** Keep only the groups whose key is not explicitly hidden. Order is preserved. */
export function visibleGroups<TRow extends BoardRow>(
  groups: readonly BoardGroup<TRow>[],
  visibility: GroupVisibility = {},
): BoardGroup<TRow>[] {
  return groups.filter((group) => visibility[group.key] !== false);
}

/**
 * Move the `fromKey` column to sit immediately before the `toKey` column.
 *
 * Immutable: returns a new array — the input is untouched and the group objects
 * are shared. Unknown `fromKey` (or `fromKey === toKey`) returns a fresh copy;
 * an unknown `toKey` appends the moved column at the end instead of dropping it.
 */
export function reorderGroups<TRow extends BoardRow>(
  groups: readonly BoardGroup<TRow>[],
  fromKey: string,
  toKey: string,
): BoardGroup<TRow>[] {
  if (fromKey === toKey) return [...groups];
  const moved = groups.find((group) => group.key === fromKey);
  if (!moved) return [...groups];
  const rest = groups.filter((group) => group.key !== fromKey);
  const targetIndex = rest.findIndex((group) => group.key === toKey);
  if (targetIndex === -1) {
    rest.push(moved);
    return rest;
  }
  rest.splice(targetIndex, 0, moved);
  return rest;
}

/** Whether a cell stores a multi-select `optionIds` list. */
function isMultiShape(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { optionIds?: unknown }).optionIds)
  );
}

/**
 * Clone a row with its group value set to `optionId`, or cleared when
 * `optionId` is `null`. Writes `{ optionIds: [optionId] }` for multi-select
 * cells and `{ optionId }` for single-select/status cells; a `null` removes the
 * property entry so `propertyValueOf` reads it as empty.
 */
function withGroupValue<TRow extends BoardRow>(
  row: TRow,
  propertyId: string,
  optionId: string | null,
  multiSelect: boolean,
): TRow {
  if (optionId === null) {
    const propertyValues = row.propertyValues.filter((entry) => entry.propertyId !== propertyId);
    return { ...row, propertyValues };
  }
  const existing = row.propertyValues.find((entry) => entry.propertyId === propertyId);
  const multi = multiSelect || isMultiShape(existing?.value);
  const value = multi ? { optionIds: [optionId] } : { optionId };
  let found = false;
  const propertyValues = row.propertyValues.map((entry) => {
    if (entry.propertyId !== propertyId) return entry;
    found = true;
    return { ...entry, value };
  });
  if (!found) propertyValues.push({ propertyId, value });
  return { ...row, propertyValues };
}

/**
 * Drag-and-drop a card: find `rowId` (in any bucket), remove it from every
 * bucket, rewrite its value for `groupPropertyId` to the target option (or
 * clear it when the target is the Empty bucket / an option-less group), and
 * append it to the target bucket.
 *
 * Immutable: new group/row objects are produced; untouched groups are shared
 * and the input is never mutated. Unknown `rowId` or `targetKey` returns a
 * shallow copy of the input unchanged.
 */
export function moveRowBetweenGroups<TRow extends BoardRow>(
  groups: readonly BoardGroup<TRow>[],
  rowId: string,
  targetKey: string,
  groupPropertyId: string,
): BoardGroup<TRow>[] {
  const targetIndex = groups.findIndex((group) => group.key === targetKey);
  let row: TRow | undefined;
  for (const group of groups) {
    const found = group.rows.find((entry) => entry.id === rowId);
    if (found) {
      row = found;
      break;
    }
  }
  if (targetIndex === -1 || !row) return [...groups];

  // A multi-select board is one where any cell uses the optionIds shape.
  const multiSelect = groups.some((group) =>
    group.rows.some((entry) => isMultiShape(propertyValueOf(entry, groupPropertyId))),
  );
  const moved = withGroupValue(row, groupPropertyId, groups[targetIndex].optionId, multiSelect);

  return groups.map((group, index) => {
    const without = group.rows.filter((entry) => entry.id !== rowId);
    if (index === targetIndex) {
      without.push(moved);
    } else if (without.length === group.rows.length) {
      return group; // untouched — share the original object
    }
    return { ...group, rows: without };
  });
}

/** One bucket's size, for `groupStats`. */
export type BoardGroupCount = { key: string; label: string; count: number };

export type BoardGroupStats = {
  /** Number of columns. */
  groupCount: number;
  /**
   * Sum of bucket sizes. A multi-select row counted in several buckets counts
   * once per bucket, so this can exceed the row count.
   */
  totalRows: number;
  /** Columns with no rows. */
  emptyGroupCount: number;
  /** Largest bucket by size (first on ties); `null` only when there are no groups. */
  largest: BoardGroupCount | null;
  /** Per-column sizes, in group order. */
  counts: BoardGroupCount[];
};

/** Summarize bucket sizes for a board's column headers. Never mutates the groups. */
export function groupStats<TRow extends BoardRow>(
  groups: readonly BoardGroup<TRow>[],
): BoardGroupStats {
  const counts = groups.map((group) => ({
    key: group.key,
    label: group.label,
    count: group.rows.length,
  }));
  let totalRows = 0;
  let emptyGroupCount = 0;
  let largest: BoardGroupCount | null = null;
  for (const count of counts) {
    totalRows += count.count;
    if (count.count === 0) emptyGroupCount += 1;
    if (largest === null || count.count > largest.count) largest = count;
  }
  return { groupCount: groups.length, totalRows, emptyGroupCount, largest, counts };
}

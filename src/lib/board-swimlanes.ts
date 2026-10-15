/**
 * Board swimlanes — a pure "group by two properties" matrix engine
 * (docs/MISSING_FEATURES.md §3 row "Board grouping", docs/specs/database-deep.md
 * R89.3 / R89.7).
 *
 * A swimlane board slices the same already-filtered/sorted row list twice: once
 * into horizontal **lanes** (e.g. by Assignee) and once into vertical **columns**
 * (e.g. by Status). `buildSwimlanes` returns that lanes × columns matrix of
 * buckets, preserving input order inside every bucket and never mutating the
 * input. A row with no value for a grouping property lands in the trailing
 * Empty lane/column; a multi-select row lands in **every** matching lane and
 * column, so it can appear in several buckets (once per lane×column pair).
 *
 * Because only the two property ids are supplied — not property descriptors —
 * lanes and columns are ordered deterministically by first appearance in the
 * row list, with the Empty row/column always last (the same "No value bucket
 * last" rule the groups engine follows). Display labels therefore mirror the
 * keys; a caller with option metadata can map them to names.
 *
 * The remaining helpers roll the matrix up: `laneCounts` reports the distinct
 * row count per lane, `swimlaneSummary` reports the overall shape, and
 * `collapseLane` flattens one lane (de-duplicating rows that span columns) for
 * Notion's collapsed-lane rendering.
 *
 * This is pure logic: no DB, no routes, no React. Rows are the generic
 * structural shape from `@/lib/board-groups`, the cell extractor is
 * `propertyValueOf` (so swimlanes agree with the rest of the app), and the
 * input is never mutated.
 */

import { EMPTY_GROUP_LABEL, propertyValueOf } from "@/lib/aggregations";
import type { BoardRow } from "@/lib/board-groups";

/** Key of the trailing "no value" lane and column. */
export const SWIMLANE_EMPTY_KEY = "__empty";

/** One lane × column bucket. */
export type SwimlaneBucket<TRow extends BoardRow = BoardRow> = {
  /** Lane this bucket belongs to (`SWIMLANE_EMPTY_KEY` for the Empty lane). */
  laneKey: string;
  /** Column this bucket belongs to (`SWIMLANE_EMPTY_KEY` for the Empty column). */
  columnKey: string;
  /** Rows in this bucket, in input order. */
  rows: TRow[];
};

/** One horizontal lane: a key plus its buckets, aligned to `columnKeys`. */
export type SwimlaneLane<TRow extends BoardRow = BoardRow> = {
  /** Lane key, or `SWIMLANE_EMPTY_KEY`. */
  key: string;
  /** Display label — the key, or `EMPTY_GROUP_LABEL` for the Empty lane. */
  label: string;
  /** Buckets in column order; index `i` corresponds to `columnKeys[i]`. */
  buckets: SwimlaneBucket<TRow>[];
};

/** A complete lanes × columns matrix. */
export type SwimlaneMatrix<TRow extends BoardRow = BoardRow> = {
  /** Lane keys in render order (Empty last when present). */
  laneKeys: string[];
  /** Column keys in render order (Empty last when present). */
  columnKeys: string[];
  /** Lanes in `laneKeys` order, each with buckets aligned to `columnKeys`. */
  lanes: SwimlaneLane<TRow>[];
};

/** Key of one bucket in the internal map (lane and column keys can't contain NUL). */
function bucketId(laneKey: string, columnKey: string): string {
  return `${laneKey}\u0000${columnKey}`;
}

/** De-duplicate a string list, keeping first-appearance order. */
function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Unwrap a cell into the bucket keys it designates. Handles every stored shape
 * this app writes — select/status `{ optionId }`, multi-select `{ optionIds }`,
 * person/relation list shapes, `{ text }` / `{ number }` / `{ checked }` /
 * `{ start }` — plus raw `string` / `number` / `boolean` / array values.
 * Unknown shapes and empty strings read as "no value"; a list cell yields one
 * key per non-empty entry (duplicates removed). Never throws.
 */
function bucketKeysOf(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const kind = typeof value;
  if (kind === "string") return (value as string).trim() === "" ? [] : [value as string];
  if (kind === "number") return Number.isFinite(value as number) ? [String(value)] : [];
  if (kind === "boolean") return [String(value)];
  if (Array.isArray(value)) return unique(value.flatMap((entry) => bucketKeysOf(entry)));
  if (kind !== "object") return [];

  const cell = value as Record<string, unknown>;
  for (const listKey of ["optionIds", "names", "pageIds"] as const) {
    const list = cell[listKey];
    if (Array.isArray(list)) return unique(list.flatMap((entry) => bucketKeysOf(entry)));
  }
  if (typeof cell.optionId === "string" && cell.optionId !== "") return [cell.optionId];
  if (typeof cell.text === "string") return cell.text.trim() === "" ? [] : [cell.text];
  if (typeof cell.number === "number") return Number.isFinite(cell.number) ? [String(cell.number)] : [];
  if (typeof cell.checked === "boolean") return [String(cell.checked)];
  if (typeof cell.start === "string" && cell.start !== "") return [cell.start];
  return [];
}

/**
 * Bucket `rows` into a lanes × columns matrix for `lanePropertyId` and
 * `columnPropertyId`.
 *
 * Lanes and columns follow first-appearance order in `rows`, with the Empty
 * lane/column appended last whenever at least one row has no value for that
 * property. Every lane carries one bucket per column (aligned to `columnKeys`),
 * including zero-row buckets. Input order is preserved within buckets, rows are
 * shared (never copied or mutated), and a multi-select value places the row in
 * each matching lane × column pair.
 */
export function buildSwimlanes<TRow extends BoardRow>(
  rows: readonly TRow[],
  lanePropertyId: string,
  columnPropertyId: string,
): SwimlaneMatrix<TRow> {
  const laneOrder: string[] = [];
  const columnOrder: string[] = [];
  const laneSeen = new Set<string>();
  const columnSeen = new Set<string>();
  let hasEmptyLane = false;
  let hasEmptyColumn = false;

  const placements = rows.map((row) => {
    const laneKeys = bucketKeysOf(propertyValueOf(row, lanePropertyId));
    const columnKeys = bucketKeysOf(propertyValueOf(row, columnPropertyId));
    const laneTargets = laneKeys.length > 0 ? laneKeys : [SWIMLANE_EMPTY_KEY];
    const columnTargets = columnKeys.length > 0 ? columnKeys : [SWIMLANE_EMPTY_KEY];

    for (const key of laneTargets) {
      if (key === SWIMLANE_EMPTY_KEY) {
        hasEmptyLane = true;
      } else if (!laneSeen.has(key)) {
        laneSeen.add(key);
        laneOrder.push(key);
      }
    }
    for (const key of columnTargets) {
      if (key === SWIMLANE_EMPTY_KEY) {
        hasEmptyColumn = true;
      } else if (!columnSeen.has(key)) {
        columnSeen.add(key);
        columnOrder.push(key);
      }
    }
    return { row, laneTargets, columnTargets };
  });

  const laneKeys = hasEmptyLane ? [...laneOrder, SWIMLANE_EMPTY_KEY] : [...laneOrder];
  const columnKeys = hasEmptyColumn ? [...columnOrder, SWIMLANE_EMPTY_KEY] : [...columnOrder];

  const buckets = new Map<string, SwimlaneBucket<TRow>>();
  for (const laneKey of laneKeys) {
    for (const columnKey of columnKeys) {
      buckets.set(bucketId(laneKey, columnKey), { laneKey, columnKey, rows: [] });
    }
  }
  for (const placement of placements) {
    for (const laneKey of unique(placement.laneTargets)) {
      for (const columnKey of unique(placement.columnTargets)) {
        buckets.get(bucketId(laneKey, columnKey))?.rows.push(placement.row);
      }
    }
  }

  const lanes: SwimlaneLane<TRow>[] = laneKeys.map((laneKey) => {
    const lane: SwimlaneLane<TRow> = {
      key: laneKey,
      label: laneKey === SWIMLANE_EMPTY_KEY ? EMPTY_GROUP_LABEL : laneKey,
      buckets: [],
    };
    for (const columnKey of columnKeys) {
      const bucket = buckets.get(bucketId(laneKey, columnKey));
      if (bucket) lane.buckets.push(bucket);
    }
    return lane;
  });

  return { laneKeys, columnKeys, lanes };
}

/** One lane's size, for `laneCounts`. */
export type SwimlaneLaneCount = { key: string; label: string; count: number };

/**
 * Count the distinct rows in each lane, in lane order. A row spread across
 * several of a lane's columns (multi-select) still counts once, so this is the
 * "cards in this lane" figure rather than a sum of bucket sizes.
 */
export function laneCounts<TRow extends BoardRow>(
  matrix: SwimlaneMatrix<TRow>,
): SwimlaneLaneCount[] {
  return matrix.lanes.map((lane) => {
    const seen = new Set<string>();
    for (const bucket of lane.buckets) {
      for (const row of bucket.rows) seen.add(row.id);
    }
    return { key: lane.key, label: lane.label, count: seen.size };
  });
}

/** The fullest bucket in a matrix. */
export type SwimlaneLargestBucket = {
  laneKey: string;
  columnKey: string;
  count: number;
};

/** Roll-up counters for a swimlane board header. */
export type SwimlaneSummary = {
  /** Number of lanes. */
  laneCount: number;
  /** Number of columns. */
  columnCount: number;
  /** Total buckets (`laneCount * columnCount`). */
  bucketCount: number;
  /** Buckets holding at least one row. */
  filledBuckets: number;
  /** Buckets holding no rows. */
  emptyBuckets: number;
  /** Distinct rows placed anywhere in the matrix. */
  rowCount: number;
  /** Largest bucket by size (first on ties); `null` when there are no buckets. */
  largestBucket: SwimlaneLargestBucket | null;
};

/** Summarize a matrix's shape. Never mutates the matrix. */
export function swimlaneSummary<TRow extends BoardRow>(
  matrix: SwimlaneMatrix<TRow>,
): SwimlaneSummary {
  const rowIds = new Set<string>();
  let filledBuckets = 0;
  let emptyBuckets = 0;
  let largestBucket: SwimlaneLargestBucket | null = null;
  for (const lane of matrix.lanes) {
    for (const bucket of lane.buckets) {
      for (const row of bucket.rows) rowIds.add(row.id);
      if (bucket.rows.length === 0) {
        emptyBuckets += 1;
      } else {
        filledBuckets += 1;
        if (largestBucket === null || bucket.rows.length > largestBucket.count) {
          largestBucket = {
            laneKey: bucket.laneKey,
            columnKey: bucket.columnKey,
            count: bucket.rows.length,
          };
        }
      }
    }
  }
  return {
    laneCount: matrix.lanes.length,
    columnCount: matrix.columnKeys.length,
    bucketCount: matrix.lanes.length * matrix.columnKeys.length,
    filledBuckets,
    emptyBuckets,
    rowCount: rowIds.size,
    largestBucket,
  };
}

/**
 * Flatten one lane into a single row list for collapsed-lane rendering: its
 * buckets in column order, rows in input order, each row taken once (a
 * multi-select row spanning several columns is not repeated). Unknown `laneKey`
 * returns `[]`; the matrix is never mutated.
 */
export function collapseLane<TRow extends BoardRow>(
  matrix: SwimlaneMatrix<TRow>,
  laneKey: string,
): TRow[] {
  const lane = matrix.lanes.find((candidate) => candidate.key === laneKey);
  if (!lane) return [];
  const seen = new Set<string>();
  const out: TRow[] = [];
  for (const bucket of lane.buckets) {
    for (const row of bucket.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

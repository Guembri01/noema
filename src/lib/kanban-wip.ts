/**
 * Board WIP limits — a pure "work-in-progress limit" checker for kanban boards
 * (docs/MISSING_FEATURES.md §3 row "WIP limits").
 *
 * A board column is a WIP bucket. Given the columns produced by
 * `groupRowsByProperty` (`@/lib/board-groups`) and a per-column limit map keyed
 * by group/option id, `checkWip` grades every column as `ok` (under a stated
 * limit), `at` (exactly at it), or `over` (strictly above it) — and reports the
 * columns that breach their limit. `canMoveRow` gates a drag-and-drop move the
 * way Notion's WIP limits do: a card may not be dropped into a column that is
 * already at or over its limit unless the caller explicitly overrides, while
 * reordering *within* a column is always allowed because it adds no work.
 * `wipSummary` rolls the per-column grades up into header counters.
 *
 * This is pure logic: no DB, no routes, no React. Columns/rows are the generic
 * structural shapes from `@/lib/board-groups`; nothing is ever mutated.
 */

import type { BoardGroup, BoardRow } from "@/lib/board-groups";

/**
 * Per-column limits, keyed by group key (an option id, or the Empty column's
 * `EMPTY_GROUP_KEY`). A column absent from the map is unlimited.
 */
export type WipLimits = Readonly<Record<string, number>>;

/** Grade of one column against its limit. */
export type WipStatus = "ok" | "at" | "over";

/** One column's WIP standing. */
export type WipColumn = {
  /** Group key this column reports on. */
  key: string;
  /** Rows currently in the column. */
  count: number;
  /** The active limit; present only when the limit map declares a valid one. */
  limit?: number;
  /** `over` when above the limit, `at` when equal, else `ok`. */
  status: WipStatus;
};

/** Result of `checkWip`. */
export type WipCheck = {
  /** Per-column standings, in group order. */
  columns: WipColumn[];
  /** Keys of columns strictly over their limit, in group order. */
  violations: string[];
  /** Keys of columns exactly at their limit, in group order. */
  atLimit: string[];
  /** True when no column is over its limit. */
  ok: boolean;
};

export type CanMoveRowOptions = {
  /** Allow the move even when the target column is at/over its limit. */
  override?: boolean;
};

/** Roll-up counters for a board header. */
export type WipSummary = {
  /** Number of columns inspected. */
  columnCount: number;
  /** Columns with an active limit. */
  limitedColumns: number;
  /** Columns without an active limit (including malformed limit entries). */
  unlimitedColumns: number;
  /** Limited columns under their limit. */
  okCount: number;
  /** Limited columns exactly at their limit. */
  atCount: number;
  /** Limited columns over their limit. */
  overCount: number;
  /** Rows beyond the limit, summed across over-limit columns. */
  excessRows: number;
  /** Room left before any limited column reaches its limit (never negative). */
  remainingCapacity: number;
  /** True when no limited column is over its limit. */
  ok: boolean;
};

/**
 * Read a column's limit, accepting only a finite non-negative integer.
 * Malformed entries (negative, fractional, `NaN`, `Infinity`, non-number)
 * are treated as "no limit" so bad config can never silently block a board.
 */
function activeLimit(limits: WipLimits, key: string): number | undefined {
  const raw: unknown = limits[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return undefined;
  return raw;
}

/** Whether any column holds `rowId`. */
function hasRow<TRow extends BoardRow>(groups: readonly BoardGroup<TRow>[], rowId: string): boolean {
  return groups.some((group) => group.rows.some((entry) => entry.id === rowId));
}

/**
 * Grade every column of `groups` against `limits`.
 *
 * A column with no valid limit is always `ok` (and reports no `limit`). With a
 * limit `L`: `count > L` is `over`, `count === L` is `at`, `count < L` is `ok`.
 * Input order is preserved, so `columns` lines up index-for-index with
 * `groups`. The inputs are never mutated.
 */
export function checkWip<TRow extends BoardRow>(
  groups: readonly BoardGroup<TRow>[],
  limits: WipLimits = {},
): WipCheck {
  const columns: WipColumn[] = [];
  const violations: string[] = [];
  const atLimit: string[] = [];
  for (const group of groups) {
    const count = group.rows.length;
    const limit = activeLimit(limits, group.key);
    const status: WipStatus =
      limit === undefined ? "ok" : count > limit ? "over" : count === limit ? "at" : "ok";
    const column: WipColumn = { key: group.key, count, status };
    if (limit !== undefined) column.limit = limit;
    columns.push(column);
    if (status === "over") violations.push(group.key);
    else if (status === "at") atLimit.push(group.key);
  }
  return { columns, violations, atLimit, ok: violations.length === 0 };
}

/**
 * Whether the card `rowId` may be dropped into the `targetKey` column.
 *
 * `false` when the row or target column does not exist. Otherwise the move is
 * allowed when: the row already sits in the target (a reorder adds no work), or
 * `options.override` is set, or the target has no valid limit, or the target
 * holds fewer rows than its limit. A target at/over its limit blocks the move.
 */
export function canMoveRow<TRow extends BoardRow>(
  groups: readonly BoardGroup<TRow>[],
  limits: WipLimits,
  rowId: string,
  targetKey: string,
  options: CanMoveRowOptions = {},
): boolean {
  const target = groups.find((group) => group.key === targetKey);
  if (!target || !hasRow(groups, rowId)) return false;
  if (target.rows.some((entry) => entry.id === rowId)) return true;
  if (options.override) return true;
  const limit = activeLimit(limits, targetKey);
  if (limit === undefined) return true;
  return target.rows.length < limit;
}

/** Roll `checkWip` up into header counters. Never mutates the groups or limits. */
export function wipSummary<TRow extends BoardRow>(
  groups: readonly BoardGroup<TRow>[],
  limits: WipLimits = {},
): WipSummary {
  const check = checkWip(groups, limits);
  let limitedColumns = 0;
  let okCount = 0;
  let atCount = 0;
  let overCount = 0;
  let excessRows = 0;
  let remainingCapacity = 0;
  for (const column of check.columns) {
    if (column.limit === undefined) continue;
    limitedColumns += 1;
    if (column.status === "ok") {
      okCount += 1;
      remainingCapacity += column.limit - column.count;
    } else if (column.status === "at") {
      atCount += 1;
    } else {
      overCount += 1;
      excessRows += column.count - column.limit;
    }
  }
  return {
    columnCount: check.columns.length,
    limitedColumns,
    unlimitedColumns: check.columns.length - limitedColumns,
    okCount,
    atCount,
    overCount,
    excessRows,
    remainingCapacity,
    ok: check.ok,
  };
}

/**
 * Pure structural operations for a table block (FEATURE_MATRIX F7).
 *
 * A table is modelled as a rectangular `string[][]`: every function takes a
 * matrix, pads ragged rows into a rectangle via {@link normalizeMatrix}, guards
 * out-of-range indices (a guarded call returns a fresh, unchanged copy rather
 * than throwing) and returns a brand-new matrix — the input is never mutated.
 *
 * An optional header row is the matrix's **first row**. Because a bare matrix
 * has no place to store a header flag, "header-ness" is positional: the row
 * operations accept `{ headerRow: true }` to keep row 0 pinned, and
 * {@link setHeaderRow} represents a header as a blank leading placeholder row
 * (adding one above data, removing one when toggled off, but never deleting a
 * labelled row).
 *
 * No DOM, no React and no I/O, so it runs in the node test environment.
 */

/** Options accepted by the row operations. */
export type TableOpOptions = {
  /** Treat the first row as a pinned header that row ops must not displace. */
  headerRow?: boolean;
};

/** True when a row exists and every cell is the empty string. */
function isBlankRow(row: string[]): boolean {
  return row.length > 0 && row.every((cell) => cell === "");
}

/** True for a finite, usable index (integers are expected but not required). */
function isUsableIndex(index: number): boolean {
  return Number.isFinite(index);
}

/** Clamp a (possibly fractional) index into `[min, max]`. */
function clampIndex(index: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(index), min), max);
}

/**
 * Pad ragged rows into a rectangle whose width is the widest row. Cells are
 * preserved verbatim (this is a structural helper, not a clipboard parser).
 * An empty (or non-array) matrix yields `[]`; the input is never mutated.
 */
export function normalizeMatrix(matrix: string[][]): string[][] {
  if (!Array.isArray(matrix) || matrix.length === 0) return [];
  const rows = matrix.map((row) =>
    Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [],
  );
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) => {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push("");
    return cells;
  });
}

/**
 * Transpose a matrix: rows become columns and vice versa. A `r x c` matrix
 * becomes `c x r`; an empty matrix stays empty. The input is never mutated.
 */
export function transpose(matrix: string[][]): string[][] {
  const rows = normalizeMatrix(matrix);
  if (rows.length === 0) return [];
  const width = rows[0].length;
  const result: string[][] = [];
  for (let column = 0; column < width; column += 1) {
    result.push(rows.map((row) => row[column]));
  }
  return result;
}

/**
 * Insert a blank row at `at`, clamped into `[0, length]`. With
 * `{ headerRow: true }` the header stays at row 0, so an insert at `0` lands
 * directly below it. A non-finite `at` is a no-op; the input is never mutated.
 */
export function insertRow(
  matrix: string[][],
  at: number,
  options: TableOpOptions = {},
): string[][] {
  const rows = normalizeMatrix(matrix);
  if (!isUsableIndex(at)) return rows;
  const headerRow = options?.headerRow ?? false;
  let target = clampIndex(at, 0, rows.length);
  if (headerRow) target = Math.min(Math.max(target, Math.min(1, rows.length)), rows.length);
  const width = rows.length > 0 ? rows[0].length : 1;
  const blank = new Array(width).fill("");
  const next = rows.slice();
  next.splice(target, 0, blank);
  return normalizeMatrix(next);
}

/**
 * Delete the row at `index`. The header row (index `0`) is protected when
 * `{ headerRow: true }` is passed and deleting the last row yields `[]`. An
 * out-of-range or non-integer `index` is a no-op; the input is never mutated.
 */
export function deleteRow(
  matrix: string[][],
  index: number,
  options: TableOpOptions = {},
): string[][] {
  const rows = normalizeMatrix(matrix);
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return rows;
  if ((options?.headerRow ?? false) && index === 0) return rows;
  const next = rows.slice();
  next.splice(index, 1);
  return normalizeMatrix(next);
}

/**
 * Insert a blank column at `at`, clamped into `[0, width]` and applied to every
 * row. A matrix with no rows has no width to extend into, so it is returned
 * unchanged. A non-finite `at` is a no-op; the input is never mutated.
 */
export function insertColumn(matrix: string[][], at: number): string[][] {
  const rows = normalizeMatrix(matrix);
  if (rows.length === 0) return rows;
  if (!isUsableIndex(at)) return rows;
  const target = clampIndex(at, 0, rows[0].length);
  return normalizeMatrix(
    rows.map((row) => {
      const cells = row.slice();
      cells.splice(target, 0, "");
      return cells;
    }),
  );
}

/**
 * Delete the column at `index` from every row. Removing the only column leaves
 * an empty table (`[]`). An out-of-range or non-integer `index` is a no-op; the
 * input is never mutated.
 */
export function deleteColumn(matrix: string[][], index: number): string[][] {
  const rows = normalizeMatrix(matrix);
  if (rows.length === 0) return rows;
  const width = rows[0].length;
  if (!Number.isInteger(index) || index < 0 || index >= width) return rows;
  const next = rows.map((row) => row.filter((_, column) => column !== index));
  if (next.length > 0 && next[0].length === 0) return [];
  return normalizeMatrix(next);
}

/**
 * Move the row at `from` to `to`, returning a new matrix. `from` must be an
 * in-bounds integer (otherwise a fresh unchanged copy is returned) and `to` is
 * clamped into `[0, length - 1]`, so any index past the end means move-to-back.
 * With `{ headerRow: true }` the header is pinned: it cannot be moved and a
 * body row can never displace it (a target of `0` becomes `1`). The input is
 * never mutated.
 */
export function moveRow(
  matrix: string[][],
  from: number,
  to: number,
  options: TableOpOptions = {},
): string[][] {
  const rows = normalizeMatrix(matrix);
  if (!Number.isInteger(from) || from < 0 || from >= rows.length) return rows;
  if (!isUsableIndex(to)) return rows;
  const headerRow = options?.headerRow ?? false;
  if (headerRow && from === 0) return rows;
  let target = clampIndex(to, 0, rows.length - 1);
  if (headerRow && rows.length > 1) target = Math.max(target, 1);
  const next = rows.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return normalizeMatrix(next);
}

/**
 * Move the column at `from` to `to` across every row. `from` must be an
 * in-bounds integer (otherwise a fresh unchanged copy is returned) and `to` is
 * clamped into `[0, width - 1]`. A matrix with no rows is returned unchanged.
 * The input is never mutated.
 */
export function moveColumn(matrix: string[][], from: number, to: number): string[][] {
  const rows = normalizeMatrix(matrix);
  if (rows.length === 0) return rows;
  const width = rows[0].length;
  if (!Number.isInteger(from) || from < 0 || from >= width) return rows;
  if (!isUsableIndex(to)) return rows;
  const target = clampIndex(to, 0, width - 1);
  return normalizeMatrix(
    rows.map((row) => {
      const cells = row.slice();
      const [moved] = cells.splice(from, 1);
      cells.splice(target, 0, moved);
      return cells;
    }),
  );
}

/**
 * Toggle a header row. Because a bare matrix cannot store a header flag, the
 * header is represented as a **blank leading row**:
 *
 *   - `on`: ensure a blank row sits above the data — allocate one when the
 *     first row is labelled (never overwriting it), and seed `[[""]]` for an
 *     empty matrix;
 *   - `off`: drop a blank leading row if one is present, but never delete a
 *     labelled first row.
 *
 * Both directions are idempotent and the input is never mutated.
 */
export function setHeaderRow(matrix: string[][], on: boolean): string[][] {
  const rows = normalizeMatrix(matrix);
  if (on) {
    if (rows.length === 0) return [[""]];
    if (isBlankRow(rows[0])) return rows;
    const width = rows[0].length;
    return [new Array(width).fill(""), ...rows];
  }
  if (rows.length > 0 && isBlankRow(rows[0])) {
    return normalizeMatrix(rows.slice(1));
  }
  return rows;
}

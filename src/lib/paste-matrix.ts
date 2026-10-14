/**
 * Spreadsheet paste -> Noema table (feature F6).
 *
 * Copying a range out of Excel / Google Sheets puts *text/plain* on the
 * clipboard with tab-separated columns and newline-separated rows; a `.csv`
 * file or a "copy as CSV" action uses commas instead. This module is the pure
 * core that turns either shape into a table block:
 *
 *   1. `parseClipboardMatrix` detects the delimiter (tab wins when present,
 *      otherwise comma), splits respecting quoted fields and escaped `""`
 *      quotes, trims cells and drops a trailing empty row/column;
 *   2. `looksLikeMatrix` decides whether the pasted text is a grid at all
 *      (at least two rows and two columns) so the editor can fall back to
 *      plain text paste otherwise;
 *   3. `normalizeRect` pads ragged rows into a rectangle;
 *   4. `inferHeaderRow` guesses whether the first row is a header (a mostly
 *      non-numeric label row over data), and
 *   5. `matrixToTableBlocks` renders the matrix as a `table` RichNode whose
 *      first row is `tableHeader` cells when a header is used.
 *
 * No DOM, no React and no I/O, so it runs in the node test environment. Every
 * entry point is total: malformed or missing input yields an empty result
 * rather than throwing, because the clipboard is untrusted.
 */

import type { RichNode } from "@/lib/blocks";

/** Options for {@link matrixToTableBlocks}. */
export type MatrixTableOptions = {
  /**
   * Treat the first row as a header. When omitted the first row is a header
   * only if {@link inferHeaderRow} says so.
   */
  header?: boolean;
};

/* ---------------------------------------------------------------- parsing */

/** Default delimiter when neither a tab nor a comma appears. */
const NO_DELIMITER = "\t";

/**
 * Pick the column delimiter from the clipboard text. A tab anywhere outside a
 * quoted field means a spreadsheet copy (tab-separated); otherwise a comma
 * means CSV; otherwise every line is a single column.
 */
function detectDelimiter(text: string): string {
  let inQuotes = false;
  let tabs = 0;
  let commas = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === "\t") tabs += 1;
    else if (char === ",") commas += 1;
  }
  if (tabs > 0) return "\t";
  if (commas > 0) return ",";
  return NO_DELIMITER;
}

/** True when every cell of a row is empty. */
function isEmptyRow(row: string[]): boolean {
  return row.every((cell) => cell === "");
}

/** Drop a trailing empty row and any trailing all-empty column. */
function trimMatrix(rows: string[][]): string[][] {
  const result = rows.map((row) => row.slice());
  while (result.length > 0 && isEmptyRow(result[result.length - 1])) result.pop();
  if (result.length === 0) return [];
  const width = result.reduce((max, row) => Math.max(max, row.length), 0);
  let trimmed = width;
  while (trimmed > 0 && result.every((row) => (row[trimmed - 1] ?? "") === "")) trimmed -= 1;
  return result.map((row) => row.slice(0, trimmed));
}

/**
 * Parse clipboard text into a string matrix. Delimiter is detected (TSV vs
 * CSV), quoted fields and doubled `""` quotes are honoured, every cell is
 * trimmed, and a trailing empty row/column is dropped. Non-string or
 * whitespace-only input yields `[]`; this function never throws.
 */
export function parseClipboardMatrix(text: string): string[][] {
  if (typeof text !== "string" || text.length === 0) return [];
  const delimiter = detectDelimiter(text);
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = (): void => {
    row.push(field.trim());
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === delimiter) pushField();
    else if (char === "\n") pushRow();
    else field += char;
  }
  if (field !== "" || row.length > 0) pushRow();

  return trimMatrix(rows);
}

/* ------------------------------------------------------------ normalising */

/**
 * Pad ragged rows into a rectangle whose width is the widest row, trimming each
 * cell and returning `[]` for an empty (or non-array) matrix. It never throws.
 */
export function normalizeRect(matrix: string[][]): string[][] {
  if (!Array.isArray(matrix) || matrix.length === 0) return [];
  const rows = matrix.map((row) =>
    Array.isArray(row) ? row.map((cell) => String(cell ?? "").trim()) : [],
  );
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return [];
  return rows.map((row) => {
    const cells = row.slice(0, width);
    while (cells.length < width) cells.push("");
    return cells;
  });
}

/** True when the pasted text is at least a 2x2 grid. Never throws. */
export function looksLikeMatrix(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const matrix = normalizeRect(parseClipboardMatrix(text));
  return matrix.length >= 2 && matrix[0].length >= 2;
}

/* -------------------------------------------------------------- semantics */

/**
 * A cell is numeric when it coerces to a finite number after stripping display
 * formatting (currency, thousands separators, percent, spaces). Empty is not
 * numeric, so an all-blank column never counts as data.
 */
function isNumericCell(value: string): boolean {
  const text = value.trim();
  if (text === "") return false;
  const cleaned = text.replace(/[%,$\s\u20AC\u00A3\u00A5]/g, "");
  if (cleaned === "") return false;
  return Number.isFinite(Number(cleaned));
}

/**
 * Guess whether the first row of `matrix` is a header rather than data.
 *
 * A header is suggested when the first row is *mostly non-numeric* (strict
 * majority of its cells are labels) and the body underneath is data-like:
 *
 *   - a column whose header cell is a label but whose body is entirely numeric
 *     (the classic "Name / Age" over numbers), or
 *   - an all-text body that is homogeneous per column across at least two rows
 *     ("Name / City" over "Alice / NYC").
 *
 * An all-numeric first row, a single row, a single column or a body whose first
 * row is itself numeric (i.e. no header was present) all return `false`.
 * Returns `false` for malformed input and never throws.
 */
export function inferHeaderRow(matrix: string[][]): boolean {
  const rows = normalizeRect(matrix);
  if (rows.length < 2) return false;
  const header = rows[0];
  if (header.length < 2) return false;
  const nonNumericHeader = header.filter((cell) => !isNumericCell(cell)).length;
  if (nonNumericHeader * 2 <= header.length) return false;

  const body = rows.slice(1);
  let numericColumns = 0;
  let homogeneousColumns = 0;
  let nonEmptyColumns = 0;
  for (let column = 0; column < header.length; column += 1) {
    const cells = body
      .map((row) => row[column] ?? "")
      .filter((cell) => cell !== "");
    if (cells.length === 0) continue;
    nonEmptyColumns += 1;
    const numeric = cells.filter(isNumericCell).length;
    if (numeric === cells.length) numericColumns += 1;
    if (numeric === 0 || numeric === cells.length) homogeneousColumns += 1;
  }

  if (numericColumns >= 1) return true;
  return body.length >= 2 && nonEmptyColumns > 0 && homogeneousColumns === nonEmptyColumns;
}

/* ------------------------------------------------------------- rendering */

function cell(text: string, header: boolean): RichNode {
  return {
    type: header ? "tableHeader" : "tableCell",
    content: [
      text
        ? { type: "paragraph", content: [{ type: "text", text }] }
        : { type: "paragraph" },
    ],
  };
}

/**
 * Render a matrix as a single `table` block. `tableHeader` cells are used for
 * the first row when `header` is true; when the option is omitted the header is
 * inferred with {@link inferHeaderRow}. Ragged rows are padded via
 * {@link normalizeRect}. An empty (or non-array) matrix yields `[]`.
 */
export function matrixToTableBlocks(
  matrix: string[][],
  options: MatrixTableOptions = {},
): RichNode[] {
  const rows = normalizeRect(matrix);
  if (rows.length === 0) return [];
  const hasHeader = options?.header ?? inferHeaderRow(rows);
  const tableRows: RichNode[] = rows.map((row, index) => ({
    type: "tableRow",
    content: row.map((value) => cell(value, hasHeader && index === 0)),
  }));
  return [{ type: "table", content: tableRows }];
}

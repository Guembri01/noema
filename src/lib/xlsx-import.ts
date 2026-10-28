import JSZip from "jszip";

/**
 * Dependency-light XLSX reader for the import dialog.
 *
 * Spreadsheet import only needs the first worksheet as a matrix; the existing
 * CSV/database mapping flow already owns column types, header validation and
 * the server-side import. Reading the OOXML ZIP here avoids pulling a second
 * full spreadsheet engine (and its parser attack surface) into the client.
 */

const MAX_ROWS = 5_000;
const MAX_COLUMNS = 200;

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function textRuns(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)) {
    text += decodeXml(match[1] ?? "");
  }
  return text;
}

/** Convert an A1 reference to a zero-based column index; rejects junk. */
export function columnIndex(reference: string): number | null {
  const letters = /^([A-Z]+)\d+$/i.exec(reference)?.[1]?.toUpperCase();
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    values.push(textRuns(match[1] ?? ""));
  }
  return values;
}

function firstSheetPath(workbook: string | null, relationships: string | null): string {
  const firstSheet = workbook
    ? /<sheet\b[^>]*\br:id="([^"]+)"/i.exec(workbook)?.[1]
    : undefined;
  if (firstSheet && relationships) {
    const relationship = new RegExp(
      `<Relationship\\b[^>]*\\bId="${firstSheet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
      "i",
    ).exec(relationships)?.[0];
    const target = relationship
      ? /\bTarget="([^"]+)"/i.exec(relationship)?.[1]
      : undefined;
    if (target) {
      const path = target.replace(/^\/+/, "").replace(/^xl\//, "");
      return `xl/${path}`;
    }
  }
  return "xl/worksheets/sheet1.xml";
}

function cellValue(
  attributes: string,
  body: string,
  shared: readonly string[],
): string {
  const type = /\bt="([^"]+)"/i.exec(attributes)?.[1]?.toLowerCase();
  if (type === "inlinestr") return textRuns(body);
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? "";
  const value = decodeXml(raw);
  if (type === "s") {
    const index = Number(value);
    return Number.isInteger(index) ? shared[index] ?? "" : "";
  }
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return value;
}

/**
 * Parse the first worksheet into a rectangular string matrix. Empty trailing
 * rows/columns are removed; malformed cells are skipped rather than throwing.
 */
export async function parseXlsxMatrix(
  input: ArrayBuffer | Uint8Array,
): Promise<string[][]> {
  const zip = await JSZip.loadAsync(input);
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  const sheetPath = firstSheetPath(workbook ?? null, rels ?? null);
  const sheet = await zip.file(sheetPath)?.async("string");
  if (!sheet) throw new Error("That workbook has no readable worksheet.");

  const shared = sharedStrings(
    (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? null,
  );
  const rows: string[][] = [];
  const cells = [...sheet.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi)];
  for (const match of cells) {
    const attributes = match[1] ?? match[3] ?? "";
    const reference = /\br="([^"]+)"/i.exec(attributes)?.[1];
    if (!reference) continue;
    const column = columnIndex(reference);
    const rowNumber = Number(/\d+$/.exec(reference)?.[0] ?? "");
    if (column === null || column < 0 || column >= MAX_COLUMNS) continue;
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROWS) continue;
    const row = rows[rowNumber - 1] ?? [];
    row[column] = cellValue(attributes, match[2] ?? "", shared);
    rows[rowNumber - 1] = row;
  }

  const matrix = rows.map((row) =>
    Array.from({ length: row.length }, (_, index) => row[index] ?? ""),
  );
  while (matrix.length > 0 && matrix[matrix.length - 1].every((cell) => cell === "")) {
    matrix.pop();
  }
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  return matrix.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? ""),
  );
}

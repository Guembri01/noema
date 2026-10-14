import { describe, expect, it } from "vitest";
import {
  inferHeaderRow,
  looksLikeMatrix,
  matrixToTableBlocks,
  normalizeRect,
  parseClipboardMatrix,
} from "@/lib/paste-matrix";

/**
 * Red-first suite for the spreadsheet-paste slice (F6): clipboard text copied
 * from Excel / Google Sheets / a CSV file -> a string matrix -> a Noema table
 * block. The module owns the *pure* half: delimiter detection (TSV vs CSV),
 * quoted-field parsing, rectangular normalisation, header inference and the
 * matrix -> `RichNode[]` table conversion. No DOM, no React, no I/O, and every
 * entry point is total: malformed input yields an empty result, never a throw.
 */

describe("parseClipboardMatrix — delimiter detection and field parsing", () => {
  it("parses a tab-separated block from a spreadsheet", () => {
    expect(parseClipboardMatrix("Name\tAge\nAlice\t30\nBob\t25")).toEqual([
      ["Name", "Age"],
      ["Alice", "30"],
      ["Bob", "25"],
    ]);
  });

  it("parses comma-separated text (CSV) the same way", () => {
    expect(parseClipboardMatrix("Name,Age\nAlice,30")).toEqual([
      ["Name", "Age"],
      ["Alice", "30"],
    ]);
  });

  it("treats commas inside quoted CSV fields as data, not delimiters", () => {
    expect(parseClipboardMatrix('"Doe, Jane",42\n"Roe, Rick",7')).toEqual([
      ["Doe, Jane", "42"],
      ["Roe, Rick", "7"],
    ]);
  });

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(parseClipboardMatrix('"say ""hi""",x')).toEqual([['say "hi"', "x"]]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(parseClipboardMatrix('"line1\nline2",b\nc,d')).toEqual([
      ["line1\nline2", "b"],
      ["c", "d"],
    ]);
  });

  it("trims surrounding whitespace on every cell", () => {
    expect(parseClipboardMatrix("  a \t b  \n c \t d ")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("drops a trailing empty row and a trailing empty column", () => {
    expect(parseClipboardMatrix("a\tb\t\nc\td\t\n\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("prefers tabs when both tabs and commas are present (spreadsheet copy)", () => {
    expect(parseClipboardMatrix("a,b\tc\nd,e\tf")).toEqual([
      ["a,b", "c"],
      ["d,e", "f"],
    ]);
  });

  it("returns an empty matrix for empty, whitespace-only or non-string input", () => {
    expect(parseClipboardMatrix("")).toEqual([]);
    expect(parseClipboardMatrix("   \n  ")).toEqual([]);
    expect(parseClipboardMatrix(null as unknown as string)).toEqual([]);
  });
});

describe("looksLikeMatrix — a block is a matrix when it is at least 2x2", () => {
  it("accepts a two-row, two-column block", () => {
    expect(looksLikeMatrix("a\tb\nc\td")).toBe(true);
    expect(looksLikeMatrix("a,b\nc,d")).toBe(true);
  });

  it("rejects a single row or a single column", () => {
    expect(looksLikeMatrix("a\tb\tc")).toBe(false);
    expect(looksLikeMatrix("a\nb\nc")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(looksLikeMatrix("")).toBe(false);
    expect(looksLikeMatrix(undefined as unknown as string)).toBe(false);
  });
});

describe("normalizeRect — pad ragged rows into a rectangle", () => {
  it("pads short rows with empty cells to the widest row", () => {
    expect(normalizeRect([["a", "b", "c"], ["d"], ["e", "f"]])).toEqual([
      ["a", "b", "c"],
      ["d", "", ""],
      ["e", "f", ""],
    ]);
  });

  it("trims cells and returns an empty matrix for empty input", () => {
    expect(normalizeRect([[" a "], [" b "]])).toEqual([["a"], ["b"]]);
    expect(normalizeRect([])).toEqual([]);
  });
});

describe("inferHeaderRow — label row over data", () => {
  it("detects a non-numeric header over numeric columns", () => {
    expect(
      inferHeaderRow([
        ["Name", "Age"],
        ["Alice", "30"],
        ["Bob", "25"],
      ]),
    ).toBe(true);
  });

  it("detects an all-text header when the body is consistent", () => {
    expect(
      inferHeaderRow([
        ["Name", "City"],
        ["Alice", "NYC"],
        ["Bob", "LA"],
      ]),
    ).toBe(true);
  });

  it("rejects a fully numeric block", () => {
    expect(
      inferHeaderRow([
        ["1", "2"],
        ["3", "4"],
      ]),
    ).toBe(false);
  });

  it("rejects a data block whose first row is numeric", () => {
    expect(
      inferHeaderRow([
        ["Alice", "30"],
        ["Bob", "25"],
      ]),
    ).toBe(false);
  });

  it("rejects a single row", () => {
    expect(inferHeaderRow([["Name", "Age"]])).toBe(false);
  });
});

describe("matrixToTableBlocks — matrix -> table RichNode[]", () => {
  const cell = (type: string, text: string) => ({
    type,
    content: text
      ? [{ type: "paragraph", content: [{ type: "text", text }] }]
      : [{ type: "paragraph" }],
  });

  it("infers a header row by default", () => {
    expect(
      matrixToTableBlocks([
        ["Name", "Age"],
        ["Alice", "30"],
      ]),
    ).toEqual([
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("tableHeader", "Name"), cell("tableHeader", "Age")] },
          { type: "tableRow", content: [cell("tableCell", "Alice"), cell("tableCell", "30")] },
        ],
      },
    ]);
  });

  it("honours an explicit header: false", () => {
    const [table] = matrixToTableBlocks(
      [
        ["Name", "Age"],
        ["Alice", "30"],
      ],
      { header: false },
    );
    expect(table?.content?.[0]?.content?.map((c) => c.type)).toEqual([
      "tableCell",
      "tableCell",
    ]);
  });

  it("honours an explicit header: true even for a numeric first row", () => {
    const [table] = matrixToTableBlocks(
      [
        ["1", "2"],
        ["3", "4"],
      ],
      { header: true },
    );
    expect(table?.content?.[0]?.content?.map((c) => c.type)).toEqual([
      "tableHeader",
      "tableHeader",
    ]);
  });

  it("turns an empty cell into an empty paragraph", () => {
    const [table] = matrixToTableBlocks([["a", ""], ["", "d"]], { header: false });
    expect(table?.content?.[0]?.content?.[1]).toEqual({
      type: "tableCell",
      content: [{ type: "paragraph" }],
    });
  });

  it("returns no blocks for an empty matrix", () => {
    expect(matrixToTableBlocks([])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  normalizeMatrix,
  setHeaderRow,
  transpose,
} from "./table-ops";

/**
 * Table structural operations — the pure core behind a table block's
 * add/delete/move row & column affordances (FEATURE_MATRIX F7).
 *
 * Red-first: `src/lib/table-ops.ts` did not exist when this suite was written,
 * so it fails on the missing module until the helper lands. Every operation is
 * total and immutable: it normalises ragged input into a rectangle, guards
 * out-of-range indices (returning a fresh, unchanged copy rather than throwing)
 * and never mutates its argument.
 */

describe("normalizeMatrix", () => {
  it("pads ragged rows up to the widest row", () => {
    expect(
      normalizeMatrix([
        ["a", "b", "c"],
        ["d"],
        ["e", "f"],
      ]),
    ).toEqual([
      ["a", "b", "c"],
      ["d", "", ""],
      ["e", "f", ""],
    ]);
  });

  it("leaves an already-rectangular matrix equal but freshly allocated", () => {
    const input = [
      ["a", "b"],
      ["c", "d"],
    ];
    const result = normalizeMatrix(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(input[0]);
  });

  it("returns an empty matrix for empty input", () => {
    expect(normalizeMatrix([])).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [["a"], ["b", "c"]];
    const snapshot = input.map((row) => row.slice());
    normalizeMatrix(input);
    expect(input).toEqual(snapshot);
  });
});

describe("transpose", () => {
  it("turns a 2x3 matrix into a 3x2 matrix", () => {
    expect(
      transpose([
        ["a", "b", "c"],
        ["d", "e", "f"],
      ]),
    ).toEqual([
      ["a", "d"],
      ["b", "e"],
      ["c", "f"],
    ]);
  });

  it("is its own inverse", () => {
    const matrix = [
      ["1", "2", "3"],
      ["4", "5", "6"],
    ];
    expect(transpose(transpose(matrix))).toEqual(matrix);
  });

  it("turns a single row into a single column", () => {
    expect(transpose([["a", "b"]])).toEqual([["a"], ["b"]]);
  });

  it("returns an empty matrix for empty input", () => {
    expect(transpose([])).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [["a", "b"]];
    const snapshot = input.map((row) => row.slice());
    transpose(input);
    expect(input).toEqual(snapshot);
  });
});

describe("insertRow", () => {
  it("inserts a blank row at the given index", () => {
    expect(
      insertRow(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        1,
      ),
    ).toEqual([
      ["a", "b"],
      ["", ""],
      ["c", "d"],
    ]);
  });

  it("appends when the index is past the end", () => {
    expect(insertRow([["a"], ["b"]], 99)).toEqual([["a"], ["b"], [""]]);
  });

  it("clamps a negative index to the top", () => {
    expect(insertRow([["a"]], -3)).toEqual([[""], ["a"]]);
  });

  it("creates a one-cell row for an empty matrix", () => {
    expect(insertRow([], 0)).toEqual([[""]]);
  });

  it("pins the header row: inserting at 0 goes just below it", () => {
    expect(
      insertRow(
        [
          ["Name", "Age"],
          ["Al", "3"],
        ],
        0,
        { headerRow: true },
      ),
    ).toEqual([
      ["Name", "Age"],
      ["", ""],
      ["Al", "3"],
    ]);
  });

  it("is a no-op copy for a non-finite index and truncates a fractional one", () => {
    const input = [["a"]];
    expect(insertRow(input, Number.NaN)).toEqual([["a"]]);
    expect(insertRow(input, 0.5)).toEqual([[""], ["a"]]);
  });

  it("does not mutate the input", () => {
    const input = [["a"], ["b"]];
    const snapshot = input.map((row) => row.slice());
    insertRow(input, 1);
    expect(input).toEqual(snapshot);
  });
});

describe("deleteRow", () => {
  it("removes the indexed row", () => {
    expect(deleteRow([["a"], ["b"], ["c"]], 1)).toEqual([["a"], ["c"]]);
  });

  it("returns a fresh unchanged copy for an out-of-range index", () => {
    const input = [["a"], ["b"]];
    const result = deleteRow(input, 9);
    expect(result).toEqual([["a"], ["b"]]);
    expect(result).not.toBe(input);
  });

  it("refuses to delete the header row", () => {
    expect(
      deleteRow(
        [
          ["Name", "Age"],
          ["Al", "3"],
        ],
        0,
        { headerRow: true },
      ),
    ).toEqual([
      ["Name", "Age"],
      ["Al", "3"],
    ]);
  });

  it("deletes the only row into an empty matrix", () => {
    expect(deleteRow([["a"]], 0)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [["a"], ["b"]];
    const snapshot = input.map((row) => row.slice());
    deleteRow(input, 0);
    expect(input).toEqual(snapshot);
  });
});

describe("moveRow", () => {
  it("moves a row down", () => {
    expect(moveRow([["a"], ["b"], ["c"], ["d"]], 0, 2)).toEqual([
      ["b"],
      ["c"],
      ["a"],
      ["d"],
    ]);
  });

  it("moves a row up", () => {
    expect(moveRow([["a"], ["b"], ["c"]], 2, 0)).toEqual([["c"], ["a"], ["b"]]);
  });

  it("clamps a target past the end to move-to-back", () => {
    expect(moveRow([["a"], ["b"], ["c"]], 0, 99)).toEqual([["b"], ["c"], ["a"]]);
  });

  it("leaves the header row pinned at the top", () => {
    expect(
      moveRow([["H"], ["a"], ["b"]], 0, 2, { headerRow: true }),
    ).toEqual([["H"], ["a"], ["b"]]);
  });

  it("never moves a body row into the header slot", () => {
    // A target of 0 clamps to the first body slot (index 1), so `b` stays put.
    expect(
      moveRow([["H"], ["a"], ["b"], ["c"]], 2, 0, { headerRow: true }),
    ).toEqual([["H"], ["b"], ["a"], ["c"]]);
  });

  it("returns a fresh equal copy when the indices are equal or invalid", () => {
    const input = [["a"], ["b"]];
    const same = moveRow(input, 1, 1);
    expect(same).toEqual(input);
    expect(same).not.toBe(input);
    expect(moveRow(input, 5, 0)).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = [["a"], ["b"], ["c"]];
    const snapshot = input.map((row) => row.slice());
    moveRow(input, 0, 2);
    expect(input).toEqual(snapshot);
  });
});

describe("insertColumn", () => {
  it("inserts a blank column at the given index across every row", () => {
    expect(
      insertColumn(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        1,
      ),
    ).toEqual([
      ["a", "", "b"],
      ["c", "", "d"],
    ]);
  });

  it("appends when the index is past the end", () => {
    expect(insertColumn([["a"], ["b"]], 99)).toEqual([
      ["a", ""],
      ["b", ""],
    ]);
  });

  it("returns an empty matrix when there are no rows", () => {
    expect(insertColumn([], 0)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [["a", "b"]];
    const snapshot = input.map((row) => row.slice());
    insertColumn(input, 0);
    expect(input).toEqual(snapshot);
  });
});

describe("deleteColumn", () => {
  it("removes the indexed column from every row", () => {
    expect(
      deleteColumn(
        [
          ["a", "b", "c"],
          ["d", "e", "f"],
        ],
        1,
      ),
    ).toEqual([
      ["a", "c"],
      ["d", "f"],
    ]);
  });

  it("returns a fresh unchanged copy for an out-of-range index", () => {
    const input = [["a", "b"]];
    expect(deleteColumn(input, 5)).toEqual([["a", "b"]]);
  });

  it("drops the table when the last column is removed", () => {
    expect(deleteColumn([["a"], ["b"]], 0)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [
      ["a", "b"],
      ["c", "d"],
    ];
    const snapshot = input.map((row) => row.slice());
    deleteColumn(input, 0);
    expect(input).toEqual(snapshot);
  });
});

describe("moveColumn", () => {
  it("moves a column to the right across every row", () => {
    expect(
      moveColumn(
        [
          ["a", "b", "c"],
          ["d", "e", "f"],
        ],
        0,
        2,
      ),
    ).toEqual([
      ["b", "c", "a"],
      ["e", "f", "d"],
    ]);
  });

  it("clamps a target past the end to move-to-end", () => {
    expect(
      moveColumn(
        [
          ["a", "b", "c"],
          ["d", "e", "f"],
        ],
        0,
        99,
      ),
    ).toEqual([
      ["b", "c", "a"],
      ["e", "f", "d"],
    ]);
  });

  it("returns an empty matrix when there are no rows", () => {
    expect(moveColumn([], 0, 0)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [
      ["a", "b"],
      ["c", "d"],
    ];
    const snapshot = input.map((row) => row.slice());
    moveColumn(input, 1, 0);
    expect(input).toEqual(snapshot);
  });
});

describe("setHeaderRow", () => {
  it("adds a blank header row above labelled data", () => {
    expect(
      setHeaderRow(
        [
          ["Name", "Age"],
          ["Al", "3"],
        ],
        true,
      ),
    ).toEqual([
      ["", ""],
      ["Name", "Age"],
      ["Al", "3"],
    ]);
  });

  it("is idempotent when a blank header row is already present", () => {
    const headed = [
      ["", ""],
      ["Al", "3"],
    ];
    expect(setHeaderRow(headed, true)).toEqual(headed);
  });

  it("removes a blank header row when turned off", () => {
    expect(
      setHeaderRow(
        [
          ["", ""],
          ["Al", "3"],
        ],
        false,
      ),
    ).toEqual([["Al", "3"]]);
  });

  it("never deletes a labelled first row when turned off", () => {
    expect(
      setHeaderRow(
        [
          ["Name", "Age"],
          ["Al", "3"],
        ],
        false,
      ),
    ).toEqual([
      ["Name", "Age"],
      ["Al", "3"],
    ]);
  });

  it("creates a single-cell header for an empty matrix and clears it back", () => {
    expect(setHeaderRow([], true)).toEqual([[""]]);
    expect(setHeaderRow([], false)).toEqual([]);
  });
});

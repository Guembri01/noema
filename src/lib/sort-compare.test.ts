import { describe, expect, it } from "vitest";
import {
  applySort,
  buildComparator,
  compareValues,
  valueFor,
  type SortRow,
  type SortSpec,
} from "./sort-compare";

/**
 * Multi-key table sorting — the pure comparison core of the database table
 * view (F5). A saved view hands the table a list of `SortSpec`s; this module
 * turns them into one comparator over rows.
 *
 * Red-first: `src/lib/sort-compare.ts` did not exist when this suite was
 * written, so it fails on the missing module until the helper lands. The
 * ordering rules (typed comparison, null policy, `id` tiebreak) must be
 * provable without a renderer, a database or the DOM.
 */

type Row = { id: string; propertyValues: { propertyId: string; value: unknown }[] };

const row = (id: string, values: Record<string, unknown> = {}): Row => ({
  id,
  propertyValues: Object.entries(values).map(([propertyId, value]) => ({ propertyId, value })),
});
const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id);

const spec = (
  propertyId: string,
  type: SortSpec["type"],
  dir: SortSpec["dir"] = "asc",
  extra: Partial<SortSpec> = {},
): SortSpec => ({ propertyId, type, dir, ...extra });

describe("valueFor", () => {
  it("reads a property value by id", () => {
    const r = row("a", { name: "Ada", score: 3 });
    expect(valueFor(r, "name")).toBe("Ada");
    expect(valueFor(r, "score")).toBe(3);
  });

  it("returns undefined for a missing property or propertyValues", () => {
    expect(valueFor(row("a", { name: "Ada" }), "nope")).toBeUndefined();
    expect(valueFor({ id: "b" } as SortRow, "name")).toBeUndefined();
  });
});

describe("compareValues — text", () => {
  it("orders text ascending with localeCompare", () => {
    expect(compareValues("apple", "banana", spec("t", "text"))).toBeLessThan(0);
    expect(compareValues("banana", "apple", spec("t", "text"))).toBeGreaterThan(0);
    expect(compareValues("same", "same", spec("t", "text"))).toBe(0);
  });

  it("reverses the order when descending", () => {
    expect(compareValues("apple", "banana", spec("t", "text", "desc"))).toBeGreaterThan(0);
  });

  it("compares embedded numbers naturally (item2 before item10)", () => {
    expect(compareValues("item2", "item10", spec("t", "text"))).toBeLessThan(0);
  });

  it("extracts text from a { text } cell value", () => {
    const a = { text: "Zed" };
    const b = { text: "Ann" };
    expect(compareValues(a, b, spec("t", "text"))).toBeGreaterThan(0);
  });

  it("treats an empty or blank string as null", () => {
    expect(compareValues("", "a", spec("t", "text"))).toBeGreaterThan(0); // null last
    expect(compareValues("   ", "a", spec("t", "text"))).toBeGreaterThan(0);
  });
});

describe("compareValues — number", () => {
  it("orders numbers numerically, not lexically", () => {
    expect(compareValues(2, 10, spec("n", "number"))).toBeLessThan(0);
    expect(compareValues(10, 2, spec("n", "number"))).toBeGreaterThan(0);
  });

  it("reads numbers from { number } cells and numeric strings", () => {
    expect(compareValues({ number: 3 }, { number: 5 }, spec("n", "number"))).toBeLessThan(0);
    expect(compareValues("7", "12", spec("n", "number"))).toBeLessThan(0);
  });

  it("treats a non-finite number as null", () => {
    expect(compareValues(Number.NaN, 1, spec("n", "number"))).toBeGreaterThan(0);
    expect(compareValues(Number.POSITIVE_INFINITY, 1, spec("n", "number"))).toBeGreaterThan(0);
  });
});

describe("compareValues — date", () => {
  it("orders ISO dates chronologically", () => {
    expect(compareValues("2024-01-01", "2024-06-15", spec("d", "date"))).toBeLessThan(0);
    expect(
      compareValues("2024-06-15T10:00:00.000Z", "2024-06-15T09:00:00.000Z", spec("d", "date")),
    ).toBeGreaterThan(0);
  });

  it("reads the start of a { start } date cell", () => {
    const a = { start: "2024-03-01" };
    const b = { start: "2024-02-01" };
    expect(compareValues(a, b, spec("d", "date"))).toBeGreaterThan(0);
  });

  it("treats an unparseable date as null", () => {
    expect(compareValues("not a date", "2024-01-01", spec("d", "date"))).toBeGreaterThan(0);
  });
});

describe("compareValues — checkbox", () => {
  it("orders unchecked before checked ascending", () => {
    expect(compareValues(false, true, spec("c", "checkbox"))).toBeLessThan(0);
    expect(compareValues(true, false, spec("c", "checkbox"))).toBeGreaterThan(0);
  });

  it("keeps false as a real value, not null", () => {
    // false must rank with values, so it beats a genuinely empty cell.
    expect(compareValues(false, undefined, spec("c", "checkbox"))).toBeLessThan(0);
  });

  it("reads { checked } cells", () => {
    expect(compareValues({ checked: true }, { checked: false }, spec("c", "checkbox"))).toBeGreaterThan(0);
  });
});

describe("compareValues — select", () => {
  const options = ["todo", "doing", "done"];

  it("orders by the optionOrder index, not alphabetically", () => {
    // "todo" < "doing" by position, though alphabetically "doing" < "todo".
    expect(
      compareValues("todo", "doing", spec("s", "select", "asc", { optionOrder: options })),
    ).toBeLessThan(0);
    expect(
      compareValues("done", "todo", spec("s", "select", "asc", { optionOrder: options })),
    ).toBeGreaterThan(0);
  });

  it("reads the optionId of a select cell", () => {
    const a = { optionId: "done" };
    const b = { optionId: "doing" };
    expect(compareValues(a, b, spec("s", "select", "asc", { optionOrder: options }))).toBeGreaterThan(0);
  });

  it("treats an option missing from optionOrder as null", () => {
    expect(
      compareValues("archived", "todo", spec("s", "select", "asc", { optionOrder: options })),
    ).toBeGreaterThan(0);
  });

  it("falls back to text order when no optionOrder is given", () => {
    expect(compareValues("apple", "banana", spec("s", "select"))).toBeLessThan(0);
  });
});

describe("compareValues — null policy", () => {
  it("sorts nulls last by default in both directions", () => {
    expect(compareValues(undefined, 1, spec("n", "number"))).toBeGreaterThan(0);
    expect(compareValues(undefined, 1, spec("n", "number", "desc"))).toBeGreaterThan(0);
    expect(compareValues(1, undefined, spec("n", "number"))).toBeLessThan(0);
  });

  it("sorts nulls first when asked, in both directions", () => {
    const first = spec("n", "number", "asc", { nulls: "first" });
    const firstDesc = spec("n", "number", "desc", { nulls: "first" });
    expect(compareValues(undefined, 1, first)).toBeLessThan(0);
    expect(compareValues(undefined, 1, firstDesc)).toBeLessThan(0);
    expect(compareValues(1, undefined, first)).toBeGreaterThan(0);
  });

  it("treats two nulls as equal", () => {
    expect(compareValues(undefined, null, spec("n", "number"))).toBe(0);
    expect(compareValues("", null, spec("t", "text"))).toBe(0);
  });
});

describe("buildComparator", () => {
  it("decides on the first key that differs and ignores the rest", () => {
    const cmp = buildComparator([spec("a", "number"), spec("b", "number")]);
    const x = row("x", { a: 1, b: 99 });
    const y = row("y", { a: 2, b: 0 });
    expect(cmp(x, y)).toBeLessThan(0);
  });

  it("falls through to the next key when the first ties", () => {
    const cmp = buildComparator([spec("a", "number"), spec("b", "number")]);
    const x = row("x", { a: 1, b: 5 });
    const y = row("y", { a: 1, b: 2 });
    expect(cmp(x, y)).toBeGreaterThan(0);
  });

  it("breaks a complete tie by id ascending", () => {
    const cmp = buildComparator([spec("a", "number")]);
    expect(cmp(row("b", { a: 1 }), row("a", { a: 1 }))).toBeGreaterThan(0);
    expect(cmp(row("a", { a: 1 }), row("b", { a: 1 }))).toBeLessThan(0);
  });

  it("is a total order that returns 0 only for the same id", () => {
    const cmp = buildComparator([spec("a", "number")]);
    expect(cmp(row("same", { a: 1 }), row("same", { a: 1 }))).toBe(0);
  });
});

describe("applySort", () => {
  const people = [
    row("p1", { name: "Charlie", age: 30, joined: "2023-05-01", done: false, status: "todo" }),
    row("p2", { name: "alice", age: 25, joined: "2024-01-15", done: true, status: "done" }),
    row("p3", { name: "Bob", age: 30, joined: "2022-11-20", done: false, status: "doing" }),
  ];

  it("sorts by a single numeric key ascending", () => {
    // p1 & p3 both have 30; the id tiebreak puts p1 before p3.
    expect(ids(applySort(people, [spec("age", "number")]))).toEqual(["p2", "p1", "p3"]);
  });

  it("sorts by a numeric key descending", () => {
    expect(ids(applySort(people, [spec("age", "number", "desc")]))).toEqual(["p1", "p3", "p2"]);
  });

  it("applies a multi-key sort: age desc, then name asc", () => {
    const specs = [spec("age", "number", "desc"), spec("name", "text")];
    // p1 & p3 tie on 30; "Bob" < "Charlie" so p3 first.
    expect(ids(applySort(people, specs))).toEqual(["p3", "p1", "p2"]);
  });

  it("sorts a select column by option order", () => {
    const specs = [spec("status", "select", "asc", { optionOrder: ["todo", "doing", "done"] })];
    expect(ids(applySort(people, specs))).toEqual(["p1", "p3", "p2"]);
  });

  it("sorts a checkbox column and a date column", () => {
    expect(ids(applySort(people, [spec("done", "checkbox")]))).toEqual(["p1", "p3", "p2"]);
    expect(ids(applySort(people, [spec("joined", "date")]))).toEqual(["p3", "p1", "p2"]);
  });

  it("returns a fresh copy and does not mutate the input", () => {
    const snapshot = people.map((r) => r.id);
    const sorted = applySort(people, [spec("age", "number")]);
    expect(sorted).not.toBe(people);
    expect(ids(people)).toEqual(snapshot);
  });

  it("returns an equal copy when there are no specs", () => {
    const copy = applySort(people, []);
    expect(copy).toEqual(people);
    expect(copy).not.toBe(people);
    expect(ids(applySort(people, undefined))).toEqual(ids(people));
  });

  it("produces the same sequence for any input permutation", () => {
    const specs = [spec("age", "number"), spec("name", "text")];
    const other = [people[2], people[0], people[1]];
    expect(ids(applySort(people, specs))).toEqual(ids(applySort(other, specs)));
  });
});

import { describe, expect, it } from "vitest";
import {
  balanceLayout,
  flattenLayout,
  moveToColumn,
  parsePropertyLayout,
  serializeLayout,
  validateLayout,
  type PropertyLayout,
} from "@/lib/property-layout";

/** Deep snapshot used to prove operations never mutate their input. */
const snapshot = (value: PropertyLayout): PropertyLayout =>
  JSON.parse(JSON.stringify(value)) as PropertyLayout;

/** The property ids a fixture page declares, in schema order. */
const known = ["title", "status", "owner", "due", "tags", "priority"];

describe("parsePropertyLayout", () => {
  it("parses a serialized layout back into its columns", () => {
    const raw = JSON.stringify({ columns: [["title", "status"], ["owner"]] });
    expect(parsePropertyLayout(raw, known)).toEqual({
      columns: [["title", "status"], ["owner"]],
    });
  });

  it("accepts an already-parsed object as well as a string", () => {
    expect(parsePropertyLayout({ columns: [["title"], []] }, known)).toEqual({
      columns: [["title"], []],
    });
  });

  it("drops property ids the schema does not know", () => {
    const raw = { columns: [["title", "ghost"], ["status", "nope"]] };
    expect(parsePropertyLayout(raw, known)).toEqual({
      columns: [["title"], ["status"]],
    });
  });

  it("removes duplicates, keeping the first occurrence", () => {
    const raw = { columns: [["title", "status"], ["title", "owner"]] };
    expect(parsePropertyLayout(raw, known)).toEqual({
      columns: [["title", "status"], ["owner"]],
    });
  });

  it("ignores non-string and blank entries", () => {
    const raw = { columns: [["title", 7, null, "", "status"]] };
    expect(parsePropertyLayout(raw, known)).toEqual({ columns: [["title", "status"]] });
  });

  it("degrades to an empty layout for unparseable or malformed input", () => {
    expect(parsePropertyLayout("{not json", known)).toEqual({ columns: [] });
    expect(parsePropertyLayout(null, known)).toEqual({ columns: [] });
    expect(parsePropertyLayout(42, known)).toEqual({ columns: [] });
    expect(parsePropertyLayout({ columns: "nope" }, known)).toEqual({ columns: [] });
  });

  it("keeps empty columns as empty columns", () => {
    expect(parsePropertyLayout({ columns: [[], []] }, known)).toEqual({
      columns: [[], []],
    });
  });
});

describe("balanceLayout", () => {
  it("gives zero properties two empty columns", () => {
    expect(balanceLayout([])).toEqual({ columns: [[], []] });
  });

  it("puts a lone property in the first column", () => {
    expect(balanceLayout(["title"])).toEqual({ columns: [["title"], []] });
  });

  it("splits an even list down the middle", () => {
    expect(balanceLayout(["title", "status", "owner", "due"])).toEqual({
      columns: [
        ["title", "status"],
        ["owner", "due"],
      ],
    });
  });

  it("gives the left column the extra item when the count is odd", () => {
    expect(balanceLayout(["title", "status", "owner"])).toEqual({
      columns: [["title", "status"], ["owner"]],
    });
  });

  it("de-duplicates and drops blank ids before splitting", () => {
    expect(balanceLayout(["title", "title", "", "status"])).toEqual({
      columns: [["title"], ["status"]],
    });
  });

  it("never mutates the input array", () => {
    const ids = ["title", "status", "owner"];
    const copy = [...ids];
    balanceLayout(ids);
    expect(ids).toEqual(copy);
  });
});

describe("moveToColumn", () => {
  const layout: PropertyLayout = {
    columns: [["title", "status"], ["owner", "due"]],
  };

  it("moves a property from the first column to the second", () => {
    expect(moveToColumn(layout, "title", 1)).toEqual({
      columns: [["status"], ["owner", "due", "title"]],
    });
  });

  it("moves a property from the second column back to the first", () => {
    expect(moveToColumn(layout, "owner", 0)).toEqual({
      columns: [["title", "status", "owner"], ["due"]],
    });
  });

  it("honours the optional insertion index", () => {
    expect(moveToColumn(layout, "due", 0, 1)).toEqual({
      columns: [["title", "due", "status"], ["owner"]],
    });
  });

  it("appends when the index is past the end", () => {
    expect(moveToColumn(layout, "title", 1, 99)).toEqual({
      columns: [["status"], ["owner", "due", "title"]],
    });
  });

  it("reorders within the same column", () => {
    expect(moveToColumn(layout, "title", 0, 1)).toEqual({
      columns: [["status", "title"], ["owner", "due"]],
    });
  });

  it("is a no-op for a property not in the layout", () => {
    expect(moveToColumn(layout, "missing", 1)).toEqual(layout);
  });

  it("is a no-op for an out-of-range column index", () => {
    expect(moveToColumn(layout, "title", 5)).toEqual(layout);
    expect(moveToColumn(layout, "title", -1)).toEqual(layout);
  });

  it("never mutates the input or aliases its arrays", () => {
    const base: PropertyLayout = { columns: [["title", "status"], ["owner"]] };
    const before = snapshot(base);
    const result = moveToColumn(base, "title", 1);
    expect(base).toEqual(before);
    expect(result.columns).not.toBe(base.columns);
    expect(result.columns[0]).not.toBe(base.columns[0]);
  });
});

describe("flattenLayout", () => {
  it("reads the columns left-to-right, top-to-bottom", () => {
    expect(
      flattenLayout({ columns: [["title", "status"], ["owner", "due"]] }),
    ).toEqual(["title", "status", "owner", "due"]);
  });

  it("returns an empty list for an empty layout", () => {
    expect(flattenLayout({ columns: [] })).toEqual([]);
    expect(flattenLayout({ columns: [[], []] })).toEqual([]);
  });

  it("round-trips with balanceLayout for a single property", () => {
    expect(flattenLayout(balanceLayout(["title"]))).toEqual(["title"]);
  });
});

describe("validateLayout", () => {
  it("accepts a well-formed layout", () => {
    expect(
      validateLayout({ columns: [["title", "status"], ["owner"]] }, known),
    ).toEqual({ valid: true, issues: [] });
  });

  it("flags a property that appears more than once", () => {
    const result = validateLayout(
      { columns: [["title", "status"], ["title"]] },
      known,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ code: "duplicate", propertyId: "title" });
  });

  it("flags property ids the schema does not know", () => {
    const result = validateLayout({ columns: [["title", "ghost"], []] }, known);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      code: "unknown",
      propertyId: "ghost",
      columnIndex: 0,
    });
  });

  it("flags an empty column", () => {
    const result = validateLayout({ columns: [["title"], []] }, known);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ code: "empty", columnIndex: 1 });
  });

  it("reports every issue it finds, not just the first", () => {
    // One unknown id, one duplicate, and one empty column at once.
    const result = validateLayout(
      { columns: [["title", "ghost"], ["title"], []] },
      known,
    );
    expect(result.issues).toHaveLength(3);
    expect(result.valid).toBe(false);
  });

  it("treats a layout with no columns as valid-but-empty", () => {
    expect(validateLayout({ columns: [] }, known)).toEqual({
      valid: true,
      issues: [],
    });
  });
});

describe("serializeLayout", () => {
  it("round-trips through parsePropertyLayout", () => {
    const layout: PropertyLayout = { columns: [["title", "status"], ["owner"]] };
    expect(parsePropertyLayout(serializeLayout(layout), known)).toEqual(layout);
  });

  it("canonicalises away non-string and blank entries", () => {
    const messy = { columns: [["title", 1, ""], ["status"]] } as unknown as PropertyLayout;
    expect(serializeLayout(messy)).toBe(
      JSON.stringify({ columns: [["title"], ["status"]] }),
    );
  });

  it("serialises an empty layout to canonical JSON", () => {
    expect(serializeLayout({ columns: [] })).toBe('{"columns":[]}');
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_MAX_WIDTH,
  DEFAULT_MIN_WIDTH,
  autoFitWidths,
  clampWidth,
  deserializeLayout,
  mergeLayout,
  reorderColumns,
  serializeLayout,
  setColumnWidth,
  toggleColumnVisibility,
  visibleColumns,
  type ColumnLayout,
} from "@/lib/column-layout";

/* A four-column fixture: a is the primary (widest) column, all widths sit
   inside the default 80..800 bounds so any clamp is a no-op here. */
const layout = (over: Partial<ColumnLayout> = {}): ColumnLayout => ({
  order: ["a", "b", "c", "d"],
  widths: { a: 200, b: 150, c: 120, d: 100 },
  hidden: {},
  ...over,
});

/** Deep snapshot used to prove operations never mutate their input. */
const snapshot = (value: ColumnLayout): ColumnLayout =>
  JSON.parse(JSON.stringify(value)) as ColumnLayout;

describe("reorderColumns", () => {
  it("moves a column forward to the target's original index", () => {
    expect(reorderColumns(layout(), "a", "c").order).toEqual(["b", "c", "a", "d"]);
  });

  it("moves a column backward to the target's original index", () => {
    expect(reorderColumns(layout(), "d", "b").order).toEqual(["a", "d", "b", "c"]);
  });

  it("preserves widths and hidden state while reordering", () => {
    const result = reorderColumns(layout({ hidden: { d: true } }), "a", "d");
    expect(result.widths).toEqual({ a: 200, b: 150, c: 120, d: 100 });
    expect(result.hidden).toEqual({ d: true });
  });

  it("is a no-op when from and to are the same column", () => {
    expect(reorderColumns(layout(), "b", "b").order).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves the order unchanged for an unknown source id", () => {
    expect(reorderColumns(layout(), "zzz", "c").order).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves the order unchanged for an unknown target id", () => {
    expect(reorderColumns(layout(), "a", "zzz").order).toEqual(["a", "b", "c", "d"]);
  });

  it("never mutates the input layout or aliases its arrays", () => {
    const base = layout();
    const before = snapshot(base);
    const result = reorderColumns(base, "a", "d");
    expect(base).toEqual(before);
    expect(result).not.toBe(base);
    expect(result.order).not.toBe(base.order);
    expect(result.widths).not.toBe(base.widths);
  });
});

describe("clampWidth", () => {
  it("raises a width below the minimum to the minimum", () => {
    expect(clampWidth(20)).toBe(DEFAULT_MIN_WIDTH);
  });

  it("lowers a width above the maximum to the maximum", () => {
    expect(clampWidth(5000)).toBe(DEFAULT_MAX_WIDTH);
  });

  it("leaves a width between the bounds unchanged", () => {
    expect(clampWidth(240)).toBe(240);
  });

  it("rounds fractional widths to whole pixels", () => {
    expect(clampWidth(150.6)).toBe(151);
  });

  it("honours custom bounds", () => {
    expect(clampWidth(50, { min: 100, max: 300 })).toBe(100);
    expect(clampWidth(500, { min: 100, max: 300 })).toBe(300);
    expect(clampWidth(250, { min: 100, max: 300 })).toBe(250);
  });

  it("treats NaN as the minimum rather than propagating it", () => {
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_MIN_WIDTH);
  });

  it("clamps infinities to the nearest bound", () => {
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_WIDTH);
    expect(clampWidth(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_MIN_WIDTH);
  });

  it("degrades a reversed range to the minimum", () => {
    expect(clampWidth(500, { min: 400, max: 100 })).toBe(400);
  });
});

describe("setColumnWidth", () => {
  it("clamps an oversized width to the maximum", () => {
    expect(setColumnWidth(layout(), "a", 9999).widths.a).toBe(DEFAULT_MAX_WIDTH);
  });

  it("clamps an undersized width to the minimum", () => {
    expect(setColumnWidth(layout(), "a", 5).widths.a).toBe(DEFAULT_MIN_WIDTH);
  });

  it("keeps the other columns' widths intact", () => {
    expect(setColumnWidth(layout(), "b", 300).widths).toEqual({
      a: 200,
      b: 300,
      c: 120,
      d: 100,
    });
  });

  it("never mutates the input layout", () => {
    const base = layout();
    const before = snapshot(base);
    setColumnWidth(base, "a", 640);
    expect(base).toEqual(before);
  });
});

describe("toggleColumnVisibility", () => {
  it("hides a visible column", () => {
    expect(toggleColumnVisibility(layout(), "a").hidden).toEqual({ a: true });
  });

  it("shows a hidden column again", () => {
    const hidden = toggleColumnVisibility(layout(), "a");
    expect(toggleColumnVisibility(hidden, "a").hidden).toEqual({});
  });

  it("refuses to hide the last visible column", () => {
    const onlyOne = layout({ order: ["a"], widths: { a: 200 } });
    const result = toggleColumnVisibility(onlyOne, "a");
    expect(result.hidden.a).not.toBe(true);
    expect(result.order).toEqual(["a"]);
  });

  it("refuses to hide the last visible column among several", () => {
    const mostlyHidden = layout({ hidden: { a: true, b: true, c: true } });
    const result = toggleColumnVisibility(mostlyHidden, "d");
    expect(result.hidden.d).not.toBe(true);
    expect(visibleColumns(result, result.order)).toEqual(["d"]);
  });

  it("is a no-op for an unknown column id", () => {
    const result = toggleColumnVisibility(layout(), "zzz");
    expect(result.hidden).toEqual({});
    expect(result.order).toEqual(["a", "b", "c", "d"]);
  });

  it("never mutates the input layout", () => {
    const base = layout();
    const before = snapshot(base);
    toggleColumnVisibility(base, "b");
    expect(base).toEqual(before);
  });
});

describe("mergeLayout", () => {
  it("appends newly-added columns with a default width", () => {
    const saved = layout({ order: ["a", "b"], widths: { a: 200, b: 150 } });
    const merged = mergeLayout(saved, ["a", "b", "c"]);
    expect(merged.order).toEqual(["a", "b", "c"]);
    expect(merged.widths.c).toBe(DEFAULT_COLUMN_WIDTH);
  });

  it("drops columns removed from the schema", () => {
    const merged = mergeLayout(layout(), ["b", "d"]);
    expect(merged.order).toEqual(["b", "d"]);
    expect(Object.keys(merged.widths).sort()).toEqual(["b", "d"]);
  });

  it("keeps the saved relative order for surviving columns", () => {
    const saved = layout({ order: ["c", "a", "b"] });
    expect(mergeLayout(saved, ["a", "b", "c"]).order).toEqual(["c", "a", "b"]);
  });

  it("keeps saved widths and hidden flags for surviving columns", () => {
    const saved = layout({ hidden: { b: true } });
    const merged = mergeLayout(saved, ["a", "b", "c", "d", "e"]);
    expect(merged.widths.b).toBe(150);
    expect(merged.hidden.b).toBe(true);
  });

  it("leaves newly-added columns visible", () => {
    const saved = layout({ order: ["a"], widths: { a: 200 }, hidden: {} });
    expect(mergeLayout(saved, ["a", "b"]).hidden).toEqual({});
  });

  it("falls back to the schema order when nothing was saved", () => {
    const merged = mergeLayout({ order: [], widths: {}, hidden: {} }, ["x", "y", "z"]);
    expect(merged.order).toEqual(["x", "y", "z"]);
    expect(merged.widths.x).toBe(DEFAULT_COLUMN_WIDTH);
  });

  it("dedupes repeated schema ids", () => {
    expect(mergeLayout(layout(), ["a", "a", "b"]).order).toEqual(["a", "b"]);
  });
});

describe("autoFitWidths", () => {
  it("splits the available space evenly", () => {
    const widths = autoFitWidths(900, ["a", "b", "c"]);
    expect(widths).toEqual({ a: 300, b: 300, c: 300 });
  });

  it("keeps every column at or above the minimum when space is tight", () => {
    const widths = autoFitWidths(100, ["a", "b", "c"]);
    expect(Object.values(widths).every((w) => w >= DEFAULT_MIN_WIDTH)).toBe(true);
    expect(widths.a).toBe(DEFAULT_MIN_WIDTH);
  });

  it("caps every column at the maximum when space is plentiful", () => {
    const widths = autoFitWidths(10000, ["a", "b"], { max: 800 });
    expect(widths.a).toBe(800);
    expect(widths.b).toBe(800);
  });

  it("returns an empty map for no columns", () => {
    expect(autoFitWidths(500, [])).toEqual({});
  });

  it("dedupes repeated column ids", () => {
    expect(Object.keys(autoFitWidths(300, ["a", "a", "b"]))).toEqual(["a", "b"]);
  });

  it("falls back to the minimum for a non-finite available width", () => {
    expect(autoFitWidths(Number.NaN, ["a", "b"])).toEqual({
      a: DEFAULT_MIN_WIDTH,
      b: DEFAULT_MIN_WIDTH,
    });
  });
});

describe("visibleColumns", () => {
  it("filters out hidden columns", () => {
    const hidden = layout({ hidden: { b: true, d: true } });
    expect(visibleColumns(hidden, ["a", "b", "c", "d"])).toEqual(["a", "c"]);
  });

  it("follows the saved order rather than the schema order", () => {
    const saved = layout({ order: ["c", "a", "b"], widths: { c: 1, a: 1, b: 1 } });
    expect(visibleColumns(saved, ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });

  it("appends newly-added schema columns that the order does not list", () => {
    const saved = layout({ order: ["a"], widths: { a: 200 } });
    expect(visibleColumns(saved, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns every column when nothing is hidden", () => {
    expect(visibleColumns(layout(), ["a", "b", "c", "d"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("serializeLayout / deserializeLayout", () => {
  it("round-trips a layout through JSON", () => {
    const base = layout({ hidden: { c: true } });
    expect(deserializeLayout(serializeLayout(base))).toEqual(base);
  });

  it("produces a parseable JSON string", () => {
    const text = serializeLayout(layout());
    expect(typeof text).toBe("string");
    expect(JSON.parse(text)).toEqual(layout());
  });

  it("returns an empty layout for null input", () => {
    expect(deserializeLayout(null)).toEqual({ order: [], widths: {}, hidden: {} });
  });

  it("returns an empty layout for unparseable text", () => {
    expect(deserializeLayout("not json {{{")).toEqual({
      order: [],
      widths: {},
      hidden: {},
    });
  });

  it("returns an empty layout for valid JSON that is not an object", () => {
    expect(deserializeLayout("42")).toEqual({ order: [], widths: {}, hidden: {} });
    expect(deserializeLayout('["a","b"]')).toEqual({
      order: [],
      widths: {},
      hidden: {},
    });
  });

  it("tolerates malformed fields instead of throwing", () => {
    const raw = JSON.stringify({
      order: ["a", 5, "a", "", "b"],
      widths: { a: -10, b: 99999, c: "wide", d: null },
      hidden: { a: "yes", b: true },
    });
    const result = deserializeLayout(raw);
    expect(result.order).toEqual(["a", "b"]);
    expect(result.widths.a).toBe(DEFAULT_MIN_WIDTH);
    expect(result.widths.b).toBe(DEFAULT_MAX_WIDTH);
    expect(result.widths.c).toBeUndefined();
    expect(result.hidden).toEqual({ b: true });
  });
});

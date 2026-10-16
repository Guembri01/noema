import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_MAX_WIDTH,
  DEFAULT_MIN_WIDTH,
  DEFAULT_WIDTH_BY_TYPE,
  autoFitWidths,
  clampWidth,
  defaultWidthForType,
  deserializeLayout,
  describeLayout,
  mergeLayout,
  moveColumn,
  parseColumnLayout,
  pinColumn,
  reorderColumns,
  resetLayout,
  resizeColumn,
  resolveLayout,
  serializeColumnLayout,
  serializeLayout,
  setColumnWidth,
  toggleColumnVisibility,
  toggleVisibility,
  unpinColumn,
  validateLayout,
  visibleColumns,
  type ColumnLayout,
  type ColumnProperty,
  type ViewColumnLayout,
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

/* ======================================================================== *
 * Per-view column width / order model (R89.13)
 * ======================================================================== */

/* A four-property fixture spanning several default-width buckets: `name` is the
   primary TEXT column, and each type gets its own `DEFAULT_WIDTH_BY_TYPE`. */
const viewProperties: ColumnProperty[] = [
  { id: "name", name: "Name", type: "TEXT" },
  { id: "status", name: "Status", type: "STATUS" },
  { id: "due", name: "Due", type: "DATE" },
  { id: "done", name: "Done", type: "CHECKBOX" },
];

const viewPropertyName = (id: string): string => {
  const map: Record<string, string> = {
    name: "Name",
    status: "Status",
    due: "Due",
    done: "Done",
  };
  return map[id] ?? id;
};

const emptyViewLayout = (): ViewColumnLayout => ({
  order: [],
  widths: {},
  pinned: [],
  hidden: [],
});

/* A saved layout: a custom order, one explicit width, and no pin/hide. */
const viewLayout = (over: Partial<ViewColumnLayout> = {}): ViewColumnLayout => ({
  order: ["due", "name", "status", "done"],
  widths: { due: 150 },
  pinned: [],
  hidden: [],
  ...over,
});

const resolvedIds = (columns: { propertyId: string }[]): string[] =>
  columns.map((column) => column.propertyId);

/** Deep snapshot used to prove the per-view mutators never touch their input. */
const viewSnapshot = (value: ViewColumnLayout): ViewColumnLayout =>
  JSON.parse(JSON.stringify(value)) as ViewColumnLayout;

describe("DEFAULT_WIDTH_BY_TYPE", () => {
  it("maps representative property types to their default pixel widths", () => {
    expect(DEFAULT_WIDTH_BY_TYPE.TEXT).toBe(240);
    expect(DEFAULT_WIDTH_BY_TYPE.NUMBER).toBe(120);
    expect(DEFAULT_WIDTH_BY_TYPE.CHECKBOX).toBe(80);
    expect(DEFAULT_WIDTH_BY_TYPE.DATE).toBe(160);
  });

  it("resolves a type case-insensitively and trims whitespace", () => {
    expect(defaultWidthForType(" text ")).toBe(240);
    expect(defaultWidthForType("checkbox")).toBe(80);
  });

  it("falls back to the generic width for an unknown or absent type", () => {
    expect(defaultWidthForType("SOMETHING_NEW")).toBe(DEFAULT_COLUMN_WIDTH);
    expect(defaultWidthForType(undefined)).toBe(DEFAULT_COLUMN_WIDTH);
  });
});

describe("parseColumnLayout", () => {
  it("returns an empty layout for null and undefined", () => {
    expect(parseColumnLayout(null)).toEqual(emptyViewLayout());
    expect(parseColumnLayout(undefined)).toEqual(emptyViewLayout());
  });

  it("returns an empty layout for unparseable text", () => {
    expect(parseColumnLayout("not json {{{")).toEqual(emptyViewLayout());
  });

  it("returns an empty layout for JSON that is not an object", () => {
    expect(parseColumnLayout("42")).toEqual(emptyViewLayout());
    expect(parseColumnLayout('["a","b"]')).toEqual(emptyViewLayout());
  });

  it("parses a serialized layout with pinned and hidden ids", () => {
    const raw = JSON.stringify({
      order: ["due", "name"],
      widths: { due: 150 },
      pinned: ["name"],
      hidden: ["status"],
    });
    expect(parseColumnLayout(raw)).toEqual({
      order: ["due", "name"],
      widths: { due: 150 },
      pinned: ["name"],
      hidden: ["status"],
    });
  });

  it("accepts an already-parsed object as well as a string", () => {
    expect(parseColumnLayout({ order: ["a"], widths: {}, pinned: [], hidden: [] })).toEqual({
      order: ["a"],
      widths: {},
      pinned: [],
      hidden: [],
    });
  });

  it("dedupes order/pinned/hidden and drops blanks and non-strings", () => {
    const raw = JSON.stringify({
      order: ["a", 5, "a", "", "b"],
      pinned: ["a", "a"],
      hidden: ["b", "", "b"],
    });
    expect(parseColumnLayout(raw)).toEqual({
      order: ["a", "b"],
      widths: {},
      pinned: ["a"],
      hidden: ["b"],
    });
  });

  it("drops malformed widths and clamps out-of-range ones", () => {
    const raw = JSON.stringify({ widths: { a: 20, b: 5000, c: "wide", d: null } });
    expect(parseColumnLayout(raw).widths).toEqual({
      a: DEFAULT_MIN_WIDTH,
      b: DEFAULT_MAX_WIDTH,
    });
  });

  it("round-trips through serializeColumnLayout", () => {
    const base = viewLayout({ widths: { name: 210 } });
    expect(parseColumnLayout(serializeColumnLayout(base))).toEqual(base);
  });
});

describe("resolveLayout", () => {
  it("follows the saved order, then appends missing schema ids in schema order", () => {
    const resolved = resolveLayout(viewLayout({ order: ["due", "name"] }), {
      properties: viewProperties,
    });
    expect(resolvedIds(resolved)).toEqual(["due", "name", "status", "done"]);
  });

  it("drops order ids that no longer exist in the schema", () => {
    const resolved = resolveLayout(viewLayout({ order: ["ghost", "name"] }), {
      properties: viewProperties,
    });
    expect(resolvedIds(resolved)).toEqual(["name", "status", "due", "done"]);
  });

  it("removes hidden ids while keeping the rest of the order", () => {
    const resolved = resolveLayout(viewLayout({ hidden: ["status"] }), {
      properties: viewProperties,
    });
    expect(resolvedIds(resolved)).toEqual(["due", "name", "done"]);
  });

  it("moves pinned ids to the front, preserving their relative order", () => {
    const resolved = resolveLayout(
      viewLayout({ order: ["name", "status", "due", "done"], pinned: ["done", "name"] }),
      { properties: viewProperties },
    );
    expect(resolvedIds(resolved)).toEqual(["name", "done", "status", "due"]);
  });

  it("uses a saved width over the type default", () => {
    const resolved = resolveLayout(viewLayout({ order: ["name"], widths: { name: 333 } }), {
      properties: viewProperties,
    });
    expect(resolved.find((column) => column.propertyId === "name")?.width).toBe(333);
  });

  it("falls back to the per-type default width when none is saved", () => {
    const resolved = resolveLayout(viewLayout({ widths: {} }), { properties: viewProperties });
    expect(resolved.map((column) => column.width)).toEqual([160, 240, 160, 80]);
  });

  it("marks pinned columns in the resolved output", () => {
    const resolved = resolveLayout(viewLayout({ pinned: ["name"] }), {
      properties: viewProperties,
    });
    expect(resolved.find((column) => column.propertyId === "name")?.pinned).toBe(true);
    expect(resolved.find((column) => column.propertyId === "status")?.pinned).toBe(false);
  });

  it("dedupes schema ids and ignores blank ids", () => {
    const resolved = resolveLayout(emptyViewLayout(), {
      properties: [{ id: "a" }, { id: "a" }, { id: "" }],
    });
    expect(resolvedIds(resolved)).toEqual(["a"]);
  });

  it("never mutates the input layout", () => {
    const base = viewLayout({ pinned: ["name"], hidden: ["status"] });
    const before = viewSnapshot(base);
    resolveLayout(base, { properties: viewProperties });
    expect(base).toEqual(before);
  });
});

describe("resizeColumn", () => {
  it("clamps a width above the default maximum", () => {
    expect(resizeColumn(viewLayout(), "name", 9999).widths.name).toBe(DEFAULT_MAX_WIDTH);
  });

  it("clamps a width below the default minimum", () => {
    expect(resizeColumn(viewLayout(), "name", 5).widths.name).toBe(DEFAULT_MIN_WIDTH);
  });

  it("honours custom bounds", () => {
    const options = { min: 100, max: 300 };
    expect(resizeColumn(viewLayout(), "name", 50, options).widths.name).toBe(100);
    expect(resizeColumn(viewLayout(), "name", 500, options).widths.name).toBe(300);
    expect(resizeColumn(viewLayout(), "name", 250, options).widths.name).toBe(250);
  });

  it("keeps the other widths intact and is immutable", () => {
    const base = viewLayout();
    const before = viewSnapshot(base);
    const resized = resizeColumn(base, "name", 300);
    expect(resized.widths).toEqual({ due: 150, name: 300 });
    expect(base).toEqual(before);
  });

  it("ignores a blank property id", () => {
    expect(resizeColumn(viewLayout(), "", 500).widths).toEqual({ due: 150 });
  });
});

describe("moveColumn", () => {
  it("moves a column to the requested index", () => {
    const order = ["name", "status", "due", "done"];
    expect(moveColumn(viewLayout({ order }), "done", 0).order).toEqual([
      "done",
      "name",
      "status",
      "due",
    ]);
  });

  it("clamps an out-of-range index to the end", () => {
    const order = ["name", "status", "due", "done"];
    expect(moveColumn(viewLayout({ order }), "name", 99).order).toEqual([
      "status",
      "due",
      "done",
      "name",
    ]);
  });

  it("is a no-op for an unknown column id", () => {
    const order = ["name", "status", "due", "done"];
    expect(moveColumn(viewLayout({ order }), "ghost", 0).order).toEqual(order);
  });

  it("never mutates the input layout", () => {
    const base = viewLayout();
    const before = viewSnapshot(base);
    moveColumn(base, "due", 3);
    expect(base).toEqual(before);
  });
});

describe("pinColumn / unpinColumn / toggleVisibility", () => {
  it("pins a column once and drops blank ids", () => {
    const once = pinColumn(viewLayout(), "due");
    expect(once.pinned).toEqual(["due"]);
    expect(pinColumn(once, "due").pinned).toEqual(["due"]);
    expect(pinColumn(viewLayout(), "").pinned).toEqual([]);
  });

  it("unpins a column", () => {
    expect(unpinColumn(viewLayout({ pinned: ["name", "due"] }), "name").pinned).toEqual(["due"]);
    expect(unpinColumn(viewLayout(), "ghost").pinned).toEqual([]);
  });

  it("toggles visibility off and back on", () => {
    const hidden = toggleVisibility(viewLayout(), "status");
    expect(hidden.hidden).toEqual(["status"]);
    expect(toggleVisibility(hidden, "status").hidden).toEqual([]);
  });

  it("never mutates the input layout", () => {
    const base = viewLayout({ pinned: ["name"] });
    const before = viewSnapshot(base);
    pinColumn(base, "due");
    unpinColumn(base, "name");
    toggleVisibility(base, "status");
    expect(base).toEqual(before);
  });
});

describe("resetLayout", () => {
  it("resets order to the schema order and widths to per-type defaults", () => {
    const reset = resetLayout(viewLayout({ widths: { due: 999 } }), {
      properties: viewProperties,
    });
    expect(reset.order).toEqual(["name", "status", "due", "done"]);
    expect(reset.widths).toEqual({ name: 240, status: 160, due: 160, done: 80 });
  });

  it("keeps pinned/hidden choices for surviving ids and drops stale ones", () => {
    const reset = resetLayout(viewLayout({ pinned: ["ghost", "name"], hidden: ["due"] }), {
      properties: viewProperties,
    });
    expect(reset.pinned).toEqual(["name"]);
    expect(reset.hidden).toEqual(["due"]);
  });

  it("uses the first property's type when schema ids repeat", () => {
    const reset = resetLayout(emptyViewLayout(), {
      properties: [
        { id: "a", type: "TEXT" },
        { id: "a", type: "NUMBER" },
      ],
    });
    expect(reset.widths).toEqual({ a: 240 });
  });
});

describe("validateLayout", () => {
  it("reports a valid layout when every id exists and order is unique", () => {
    expect(validateLayout(viewLayout(), { properties: viewProperties })).toEqual({
      valid: true,
      unknownIds: [],
      duplicateIds: [],
    });
  });

  it("reports ids that are not in the schema", () => {
    const result = validateLayout(
      viewLayout({ order: ["ghost"], widths: { name: 200 }, pinned: ["phantom"] }),
      { properties: viewProperties },
    );
    expect(result.valid).toBe(false);
    expect(result.unknownIds).toEqual(["ghost", "phantom"]);
  });

  it("reports duplicate ids in the saved order", () => {
    const result = validateLayout(
      { order: ["name", "name", "status"], widths: {}, pinned: [], hidden: [] },
      { properties: viewProperties },
    );
    expect(result.valid).toBe(false);
    expect(result.duplicateIds).toEqual(["name"]);
  });
});

describe("describeLayout", () => {
  it("lists the visible columns in order using the provided name lookup", () => {
    expect(
      describeLayout(viewLayout({ order: ["name", "status"] }), {
        propertyName: viewPropertyName,
      }),
    ).toBe("Name, Status");
  });

  it("annotates pinned and hidden columns", () => {
    const description = describeLayout(
      viewLayout({ order: ["name", "status", "due"], pinned: ["name"], hidden: ["due"] }),
      { propertyName: viewPropertyName },
    );
    expect(description).toBe("Name, Status (pinned: Name; hidden: Due)");
  });

  it("handles an empty layout", () => {
    expect(describeLayout(emptyViewLayout(), { propertyName: viewPropertyName })).toBe(
      "No columns",
    );
  });
});

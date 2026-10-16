import { describe, expect, it } from "vitest";
import {
  BUCKET_AVAILABLE_WIDTH,
  LAYOUT_MIN_COLUMN_WIDTH,
  describeLayout,
  moveProperty,
  parsePropertyLayout,
  resolveLayout,
  responsivePlan,
  setSpan,
  toggleColumns,
  validateLayout,
  type PropertyLayout,
} from "@/lib/property-layout-engine";

/** Deep snapshot used to prove operations never mutate their input. */
const snapshot = (value: PropertyLayout): PropertyLayout =>
  JSON.parse(JSON.stringify(value)) as PropertyLayout;

/** The property ids a fixture page declares, in schema order. */
const properties = [
  { id: "title" },
  { id: "status" },
  { id: "owner" },
  { id: "due" },
  { id: "tags" },
] as const;

/** Build a schema from bare ids, for tests that want an exact property set. */
const schema = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }));

/** A tidy, fully-normalised two-column layout to mutate in the tests. */
const twoColumn = (over: Partial<PropertyLayout> = {}): PropertyLayout => ({
  columns: 2,
  order: ["title", "status", "owner"],
  spans: {},
  dividers: false,
  ...over,
});

describe("parsePropertyLayout", () => {
  it("parses a serialized layout back into its fields", () => {
    const raw = JSON.stringify({
      columns: 2,
      order: ["title", "owner"],
      spans: { owner: 2 },
      dividers: true,
    });
    expect(parsePropertyLayout(raw)).toEqual({
      columns: 2,
      order: ["title", "owner"],
      spans: { owner: 2 },
      dividers: true,
    });
  });

  it("accepts an already-parsed object as well as a string", () => {
    expect(
      parsePropertyLayout({ columns: 2, order: ["title"], dividers: true }),
    ).toEqual({ columns: 2, order: ["title"], spans: {}, dividers: true });
  });

  it("defaults the column count to one when missing or invalid", () => {
    expect(parsePropertyLayout({ order: ["title"] }).columns).toBe(1);
    expect(parsePropertyLayout({ columns: 3, order: ["title"] }).columns).toBe(1);
    expect(parsePropertyLayout({ columns: "2", order: ["title"] }).columns).toBe(1);
  });

  it("de-duplicates order and drops non-string and blank entries", () => {
    const raw = { order: ["title", 7, null, "", "title", "status"] };
    expect(parsePropertyLayout(raw).order).toEqual(["title", "status"]);
  });

  it("keeps only span-2 entries for ids that are in order", () => {
    const raw = {
      columns: 2,
      order: ["title", "owner"],
      spans: { title: 1, owner: 2, ghost: 2, bogus: 3 },
    };
    expect(parsePropertyLayout(raw).spans).toEqual({ owner: 2 });
  });

  it("only stores dividers when explicitly true", () => {
    expect(parsePropertyLayout({ order: ["title"] }).dividers).toBe(false);
    expect(parsePropertyLayout({ order: ["title"], dividers: false }).dividers).toBe(false);
    expect(parsePropertyLayout({ order: ["title"], dividers: true }).dividers).toBe(true);
    expect(parsePropertyLayout({ order: ["title"], dividers: "yes" }).dividers).toBe(false);
  });

  it("degrades to an empty one-column layout for malformed input", () => {
    const empty = { columns: 1, order: [], spans: {}, dividers: false };
    expect(parsePropertyLayout("{not json")).toEqual(empty);
    expect(parsePropertyLayout(null)).toEqual(empty);
    expect(parsePropertyLayout(42)).toEqual(empty);
    expect(parsePropertyLayout({ order: "nope" })).toEqual(empty);
  });
});

describe("resolveLayout", () => {
  it("stacks every property in one column", () => {
    const layout = parsePropertyLayout({ columns: 1, order: ["title", "status"] });
    expect(resolveLayout(layout, { properties: schema("title", "status") })).toEqual([
      { propertyId: "title", column: 0, span: 1, row: 0 },
      { propertyId: "status", column: 0, span: 1, row: 1 },
    ]);
  });

  it("fills two columns row-major, left then right", () => {
    const layout = parsePropertyLayout({
      columns: 2,
      order: ["title", "status", "owner", "due"],
    });
    expect(
      resolveLayout(layout, { properties: schema("title", "status", "owner", "due") }),
    ).toEqual([
      { propertyId: "title", column: 0, span: 1, row: 0 },
      { propertyId: "status", column: 1, span: 1, row: 0 },
      { propertyId: "owner", column: 0, span: 1, row: 1 },
      { propertyId: "due", column: 1, span: 1, row: 1 },
    ]);
  });

  it("leaves the trailing cell empty for an odd count", () => {
    const layout = parsePropertyLayout({ columns: 2, order: ["title", "status", "owner"] });
    expect(resolveLayout(layout, { properties: schema("title", "status", "owner") })).toEqual([
      { propertyId: "title", column: 0, span: 1, row: 0 },
      { propertyId: "status", column: 1, span: 1, row: 0 },
      { propertyId: "owner", column: 0, span: 1, row: 1 },
    ]);
  });

  it("gives a span-2 property a full row of its own", () => {
    const layout = parsePropertyLayout({
      columns: 2,
      order: ["title", "owner", "status"],
      spans: { owner: 2 },
    });
    expect(resolveLayout(layout, { properties: schema("title", "owner", "status") })).toEqual([
      { propertyId: "title", column: 0, span: 1, row: 0 },
      { propertyId: "owner", column: 0, span: 2, row: 1 },
      { propertyId: "status", column: 0, span: 1, row: 2 },
    ]);
  });

  it("advances past a half-filled row so a span-2 item starts clean", () => {
    const layout = parsePropertyLayout({
      columns: 2,
      order: ["title", "owner", "status", "due"],
      spans: { owner: 2 },
    });
    expect(
      resolveLayout(layout, { properties: schema("title", "owner", "status", "due") }),
    ).toEqual([
      { propertyId: "title", column: 0, span: 1, row: 0 },
      { propertyId: "owner", column: 0, span: 2, row: 1 },
      { propertyId: "status", column: 0, span: 1, row: 2 },
      { propertyId: "due", column: 1, span: 1, row: 2 },
    ]);
  });

  it("ignores spans in a one-column layout", () => {
    const layout = parsePropertyLayout({
      columns: 1,
      order: ["title", "owner"],
      spans: { owner: 2 },
    });
    expect(resolveLayout(layout, { properties: schema("title", "owner") })).toEqual([
      { propertyId: "title", column: 0, span: 1, row: 0 },
      { propertyId: "owner", column: 0, span: 1, row: 1 },
    ]);
  });

  it("appends schema properties the saved order does not mention", () => {
    const layout = parsePropertyLayout({ columns: 2, order: ["owner"] });
    expect(resolveLayout(layout, { properties })).toEqual([
      { propertyId: "owner", column: 0, span: 1, row: 0 },
      { propertyId: "title", column: 1, span: 1, row: 0 },
      { propertyId: "status", column: 0, span: 1, row: 1 },
      { propertyId: "due", column: 1, span: 1, row: 1 },
      { propertyId: "tags", column: 0, span: 1, row: 2 },
    ]);
  });

  it("drops order ids the schema does not know", () => {
    const layout = parsePropertyLayout({ columns: 2, order: ["ghost", "title"] });
    expect(resolveLayout(layout, { properties })).toEqual([
      { propertyId: "title", column: 0, span: 1, row: 0 },
      { propertyId: "status", column: 1, span: 1, row: 0 },
      { propertyId: "owner", column: 0, span: 1, row: 1 },
      { propertyId: "due", column: 1, span: 1, row: 1 },
      { propertyId: "tags", column: 0, span: 1, row: 2 },
    ]);
  });

  it("never mutates the input layout", () => {
    const layout = twoColumn({ spans: { owner: 2 } });
    const before = snapshot(layout);
    resolveLayout(layout, { properties });
    expect(layout).toEqual(before);
  });
});

describe("moveProperty", () => {
  it("moves a property later in the order", () => {
    expect(moveProperty(twoColumn(), "title", 2).order).toEqual(["status", "owner", "title"]);
  });

  it("moves a property earlier in the order", () => {
    expect(moveProperty(twoColumn(), "owner", 0).order).toEqual(["owner", "title", "status"]);
  });

  it("appends when the index is past the end", () => {
    expect(moveProperty(twoColumn(), "title", 99).order).toEqual(["status", "owner", "title"]);
  });

  it("is a no-op for a property not in the layout", () => {
    expect(moveProperty(twoColumn(), "ghost", 0)).toEqual(twoColumn());
  });

  it("never mutates the input or aliases its arrays", () => {
    const base = twoColumn();
    const before = snapshot(base);
    const result = moveProperty(base, "title", 2);
    expect(base).toEqual(before);
    expect(result.order).not.toBe(base.order);
  });
});

describe("toggleColumns", () => {
  it("collapses two columns to one without losing order", () => {
    const result = toggleColumns(twoColumn());
    expect(result.columns).toBe(1);
    expect(result.order).toEqual(["title", "status", "owner"]);
  });

  it("expands one column back to two", () => {
    expect(toggleColumns(twoColumn({ columns: 1 })).columns).toBe(2);
  });

  it("round-trips order and spans through a collapse and expand", () => {
    const layout = twoColumn({ spans: { owner: 2 }, dividers: true });
    expect(toggleColumns(toggleColumns(layout))).toEqual(layout);
  });

  it("normalises a malformed column count before toggling", () => {
    const raw = { columns: 7, order: ["title"], spans: {} } as unknown as PropertyLayout;
    expect(toggleColumns(raw).columns).toBe(2);
  });
});

describe("setSpan", () => {
  it("marks a property as full width", () => {
    expect(setSpan(twoColumn(), "owner", 2).spans).toEqual({ owner: 2 });
  });

  it("clears the span when set back to one", () => {
    const layout = twoColumn({ spans: { owner: 2, title: 2 } });
    expect(setSpan(layout, "owner", 1).spans).toEqual({ title: 2 });
  });

  it("is a no-op for a property not in the layout", () => {
    expect(setSpan(twoColumn(), "ghost", 2)).toEqual(twoColumn());
  });

  it("is a no-op for an out-of-range span", () => {
    expect(setSpan(twoColumn(), "owner", 3 as unknown as 1 | 2)).toEqual(twoColumn());
  });

  it("never mutates the input span map", () => {
    const base = twoColumn({ spans: { title: 2 } });
    const before = snapshot(base);
    const result = setSpan(base, "owner", 2);
    expect(base).toEqual(before);
    expect(result.spans).not.toBe(base.spans);
  });
});

describe("validateLayout", () => {
  it("accepts a clean layout", () => {
    expect(validateLayout(twoColumn(), { properties })).toEqual({ valid: true, issues: [] });
  });

  it("flags property ids the schema does not know", () => {
    const result = validateLayout(twoColumn({ order: ["title", "ghost"] }), { properties });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ code: "unknown", propertyId: "ghost" });
  });

  it("flags a property that appears more than once", () => {
    const raw = { ...twoColumn(), order: ["title", "title", "owner"] };
    const result = validateLayout(raw, { properties });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ code: "duplicate", propertyId: "title" });
  });

  it("flags an invalid span value", () => {
    const raw = { ...twoColumn(), spans: { owner: 5 } } as unknown as PropertyLayout;
    const result = validateLayout(raw, { properties });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ code: "invalid-span", propertyId: "owner" });
  });

  it("flags an invalid column count", () => {
    const raw = { ...twoColumn(), columns: 4 } as unknown as PropertyLayout;
    const result = validateLayout(raw, { properties });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ code: "invalid-columns" });
  });

  it("reports every issue it finds, not just the first", () => {
    const raw = {
      columns: 4,
      order: ["ghost", "ghost"],
      spans: { owner: 0 },
    } as unknown as PropertyLayout;
    const result = validateLayout(raw, { properties });
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(4);
  });
});

describe("responsivePlan", () => {
  it("collapses two columns to one under the narrow bucket", () => {
    const plan = responsivePlan(twoColumn(), { widthBucket: "narrow" });
    expect(plan.columns).toBe(1);
    expect(plan.collapsed).toBe(true);
    expect(plan.columnWidth).toBe(BUCKET_AVAILABLE_WIDTH.narrow);
  });

  it("keeps two columns for the medium and wide buckets", () => {
    expect(responsivePlan(twoColumn(), { widthBucket: "medium" })).toMatchObject({
      columns: 2,
      collapsed: false,
      columnWidth: BUCKET_AVAILABLE_WIDTH.medium / 2,
    });
    expect(responsivePlan(twoColumn(), { widthBucket: "wide" }).columns).toBe(2);
  });

  it("leaves a one-column layout alone in every bucket", () => {
    for (const widthBucket of ["narrow", "medium", "wide"] as const) {
      expect(responsivePlan(twoColumn({ columns: 1 }), { widthBucket })).toMatchObject({
        columns: 1,
        collapsed: false,
      });
    }
  });

  it("collapses when an explicit width cannot honour the minimum", () => {
    const plan = responsivePlan(twoColumn(), {
      widthBucket: "medium",
      availableWidth: LAYOUT_MIN_COLUMN_WIDTH * 2 - 1,
    });
    expect(plan.columns).toBe(1);
    expect(plan.collapsed).toBe(true);
  });

  it("honours the minimum width when two columns fit", () => {
    const plan = responsivePlan(twoColumn(), { widthBucket: "medium", availableWidth: 400 });
    expect(plan.columns).toBe(2);
    expect(plan.columnWidth).toBeGreaterThanOrEqual(LAYOUT_MIN_COLUMN_WIDTH);
  });

  it("preserves the order in the plan", () => {
    expect(responsivePlan(twoColumn(), { widthBucket: "wide" }).order).toEqual([
      "title",
      "status",
      "owner",
    ]);
  });
});

describe("describeLayout", () => {
  const nameOf = (id: string): string => id[0].toUpperCase() + id.slice(1);

  it("describes a two-column layout with display names", () => {
    expect(describeLayout(twoColumn({ order: ["title", "owner"] }), { propertyName: nameOf })).toBe(
      "2 columns: Title, Owner",
    );
  });

  it("describes a one-column layout", () => {
    expect(
      describeLayout(twoColumn({ columns: 1, order: ["title"] }), { propertyName: nameOf }),
    ).toBe("1 column: Title");
  });

  it("notes full-width properties and dividers", () => {
    const layout = twoColumn({ order: ["title", "owner"], spans: { owner: 2 }, dividers: true });
    expect(describeLayout(layout, { propertyName: nameOf })).toBe(
      "2 columns: Title, Owner (full-width: Owner; dividers)",
    );
  });

  it("falls back to the raw id when no name is available", () => {
    expect(describeLayout(twoColumn({ order: ["title"] }))).toBe("2 columns: title");
  });

  it("describes an empty layout as having no properties", () => {
    expect(describeLayout(parsePropertyLayout(null))).toBe("No properties");
  });
});

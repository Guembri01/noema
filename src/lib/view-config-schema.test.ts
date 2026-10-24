import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_CONFIG,
  VIEW_TYPES,
  isViewType,
  mergeViewConfig,
  normalizeViewConfig,
  validateViewConfig,
} from "./view-config-schema";
import type { ViewConfig, ViewProperty } from "./view-config-schema";

/**
 * Database view config schema (docs/FEATURE_MATRIX.md "Per-view configuration"
 * / "Show/hide properties" / "Column resize/reorder";
 * docs/specs/database-deep.md R89.1, R89.5, R89.13).
 *
 * Red-first: `src/lib/view-config-schema.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 * This is the pure schema half — tolerant normalization against a property
 * schema, shape validation with stable codes, an immutable patch merge, the
 * default config and the view-type guard. No DB, no routes, no React.
 */

/** The property schema the fixtures below normalize against. */
const PROPS: ViewProperty[] = [
  { id: "title", type: "title" },
  { id: "status", type: "select" },
  { id: "due", type: "date" },
];

describe("VIEW_TYPES / isViewType", () => {
  it("lists the eight canonical view types in menu order", () => {
    expect(VIEW_TYPES).toEqual([
      "TABLE",
      "BOARD",
      "LIST",
      "GALLERY",
      "CALENDAR",
      "TIMELINE",
      "CHART",
      "FORM",
    ]);
  });

  it("accepts a canonical type and rejects a lowercase name or a non-string", () => {
    expect(isViewType("BOARD")).toBe(true);
    expect(isViewType("board")).toBe(false);
    expect(isViewType(null)).toBe(false);
  });
});

describe("DEFAULT_VIEW_CONFIG", () => {
  it("is a table view with no other settings", () => {
    expect(DEFAULT_VIEW_CONFIG).toEqual({ viewType: "TABLE" });
  });

  it("is not the object a normalized config hands back", () => {
    const config = normalizeViewConfig({}, PROPS);
    config.wrapCells = true;
    expect(DEFAULT_VIEW_CONFIG).toEqual({ viewType: "TABLE" });
  });
});

describe("normalizeViewConfig", () => {
  it("defaults a non-object to a plain table config", () => {
    expect(normalizeViewConfig(null, PROPS)).toEqual({ viewType: "TABLE" });
  });

  it("parses a JSON string and defaults a missing view type", () => {
    expect(normalizeViewConfig('{"group":"status"}', PROPS)).toEqual({
      viewType: "TABLE",
      group: "status",
    });
  });

  it("falls back to TABLE for an unknown view type but keeps a known one", () => {
    expect(normalizeViewConfig({ viewType: "NOPE" }, PROPS).viewType).toBe("TABLE");
    expect(normalizeViewConfig({ viewType: "FORM" }, PROPS).viewType).toBe("FORM");
    expect(normalizeViewConfig({ viewType: "BOARD" }, PROPS).viewType).toBe("BOARD");
  });

  it("drops unknown top-level keys but keeps the known ones", () => {
    expect(
      normalizeViewConfig({ viewType: "TABLE", colorRules: [], nope: 1 }, PROPS),
    ).toEqual({ viewType: "TABLE" });
  });

  it("keeps an opaque filter object and drops a malformed one", () => {
    const filter = { and: [{ propertyId: "status", operator: "is", value: "Done" }] };
    expect(normalizeViewConfig({ filter }, PROPS).filter).toEqual(filter);
    expect(normalizeViewConfig({ filter: "nope" }, PROPS).filter).toBeUndefined();
  });

  it("keeps an opaque form object and drops a malformed one", () => {
    const form = { id: "form-1", fields: [{ propertyId: "title", label: "Title" }] };
    expect(normalizeViewConfig({ viewType: "FORM", form }, PROPS).form).toEqual(form);
    expect(normalizeViewConfig({ viewType: "FORM", form: "nope" }, PROPS).form).toBeUndefined();
  });

  it("normalizes sorts: default direction, known properties only, first wins", () => {
    expect(
      normalizeViewConfig(
        {
          sort: [
            { propertyId: "due" },
            { propertyId: "status", direction: "desc" },
            { propertyId: "gone" },
            { propertyId: "due", direction: "desc" },
          ],
        },
        PROPS,
      ).sort,
    ).toEqual([
      { propertyId: "due", direction: "asc" },
      { propertyId: "status", direction: "desc" },
    ]);
  });

  it("keeps a known group and drops a blank or unknown one", () => {
    expect(normalizeViewConfig({ group: "status" }, PROPS).group).toBe("status");
    expect(normalizeViewConfig({ group: "gone" }, PROPS).group).toBeUndefined();
  });

  it("de-duplicates and filters hidden and visible property ids", () => {
    expect(
      normalizeViewConfig({ hiddenPropertyIds: ["due", "due", "gone"] }, PROPS)
        .hiddenPropertyIds,
    ).toEqual(["due"]);
    expect(
      normalizeViewConfig({ visiblePropertyIds: ["title", "title", "gone"] }, PROPS)
        .visiblePropertyIds,
    ).toEqual(["title"]);
  });

  it("keeps positive, finite widths for known properties only", () => {
    expect(
      normalizeViewConfig(
        { columnWidths: { status: 220, due: 0, title: -5, gone: 100 } },
        PROPS,
      ).columnWidths,
    ).toEqual({ status: 220 });
  });

  it("keeps a boolean wrapCells and drops a non-boolean", () => {
    expect(normalizeViewConfig({ wrapCells: true }, PROPS).wrapCells).toBe(true);
    expect(normalizeViewConfig({ wrapCells: "yes" }, PROPS).wrapCells).toBeUndefined();
  });

  it("normalizes colour rules: keeps known fields, drops unknown refs and colourless rules", () => {
    expect(
      normalizeViewConfig(
        {
          rowColorRules: [
            { id: "r1", propertyId: "status", color: "red", target: "row", junk: 1 },
            { propertyId: "gone", color: "blue" },
            { id: "r3" },
          ],
        },
        PROPS,
      ).rowColorRules,
    ).toEqual([
      { id: "r1", color: "red", propertyId: "status", target: "row" },
      { color: "blue" },
    ]);
  });

  it("drops every property reference when the schema has no properties", () => {
    expect(
      normalizeViewConfig(
        { group: "status", hiddenPropertyIds: ["due"], sort: [{ propertyId: "due" }] },
        [],
      ),
    ).toEqual({ viewType: "TABLE" });
  });
});

describe("validateViewConfig", () => {
  it("reports nothing for a well-formed config", () => {
    expect(
      validateViewConfig({
        viewType: "TABLE",
        filter: { and: [] },
        sort: [{ propertyId: "due", direction: "asc" }],
        group: "status",
        hiddenPropertyIds: ["due"],
        visiblePropertyIds: ["title"],
        columnWidths: { status: 200 },
        rowColorRules: [{ color: "red" }],
        wrapCells: false,
      }),
    ).toEqual([]);
  });

  it("flags a non-object and a missing or invalid view type", () => {
    expect(validateViewConfig(null).map((issue) => issue.code)).toEqual(["not_an_object"]);
    expect(validateViewConfig({ viewType: "NOPE" }).map((issue) => issue.code)).toEqual([
      "invalid_view_type",
    ]);
    expect(validateViewConfig({ viewType: "FORM" })).toEqual([]);
  });

  it("flags every malformed field at once with stable codes", () => {
    const codes = validateViewConfig({
      viewType: "TABLE",
      filter: [],
      sort: [{ direction: "asc" }],
      group: 5,
      hiddenPropertyIds: ["ok", 3],
      visiblePropertyIds: "title",
      columnWidths: { status: -1 },
      rowColorRules: [{ id: "x" }],
      wrapCells: "yes",
    }).map((issue) => issue.code);
    expect(codes).toEqual([
      "invalid_filter",
      "invalid_sort",
      "invalid_group",
      "invalid_hidden_property_ids",
      "invalid_visible_property_ids",
      "invalid_column_widths",
      "invalid_row_color_rules",
      "invalid_wrap_cells",
    ]);
  });
});

describe("mergeViewConfig", () => {
  const base: ViewConfig = {
    viewType: "TABLE",
    sort: [{ propertyId: "due", direction: "asc" }],
    hiddenPropertyIds: ["due"],
    wrapCells: false,
  };

  it("keeps the base fields the patch leaves unset", () => {
    const merged = mergeViewConfig(base, { wrapCells: true });
    expect(merged).toEqual({
      viewType: "TABLE",
      sort: [{ propertyId: "due", direction: "asc" }],
      hiddenPropertyIds: ["due"],
      wrapCells: true,
    });
  });

  it("lets the patch replace any field, including with an empty list", () => {
    const merged = mergeViewConfig(base, { viewType: "BOARD", hiddenPropertyIds: [] });
    expect(merged.viewType).toBe("BOARD");
    expect(merged.hiddenPropertyIds).toEqual([]);
  });

  it("copies arrays so neither input is aliased", () => {
    const merged = mergeViewConfig(base, {
      sort: [{ propertyId: "status", direction: "desc" }],
    });
    merged.sort?.[0] && (merged.sort[0].direction = "asc");
    merged.hiddenPropertyIds?.push("status");
    expect(base.sort).toEqual([{ propertyId: "due", direction: "asc" }]);
    expect(base.hiddenPropertyIds).toEqual(["due"]);
  });

  it("returns the base alone for an empty patch", () => {
    expect(mergeViewConfig(base, {})).toEqual(base);
  });
});

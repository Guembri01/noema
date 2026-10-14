import { describe, expect, it } from "vitest";
import {
  CARD_SIZES,
  cardFieldOrder,
  cardSizeFor,
  densityOptions,
  listRowModel,
  resolveCardPreview,
} from "./view-presets";
import type { ViewPropertyLike, ViewRowLike } from "./view-presets";

/**
 * Gallery previews + list view models (docs/MISSING_FEATURES.md §3 row
 * "Gallery previews": "Show cover or page content on cards").
 *
 * Red-first: `src/lib/view-presets.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 * These are the pure view-model halves of a gallery card (which image the
 * cover shows, which fields a card lists and how big it is) and of a list row
 * (title/secondary/expanded under a density). No DB, no routes, no React.
 */

const properties: ViewPropertyLike[] = [
  { id: "title", name: "Name", type: "title" },
  { id: "cover", name: "Cover", type: "files" },
  { id: "status", name: "Status", type: "select" },
  { id: "owner", name: "Owner", type: "person" },
  { id: "link", name: "Link", type: "url" },
];

const row = (
  values: Record<string, unknown> = {},
  overrides: Partial<ViewRowLike> = {},
): ViewRowLike => ({
  id: "r1",
  title: "Row one",
  icon: null,
  propertyValues: Object.entries(values).map(([propertyId, value]) => ({
    propertyId,
    value,
  })),
  ...overrides,
});

describe("resolveCardPreview", () => {
  it("prefers the cover property over the page icon", () => {
    const preview = resolveCardPreview(
      row({ cover: "https://cdn.test/cover.png" }),
      properties,
      { coverPropertyId: "cover", icon: "📄" },
    );
    expect(preview).toEqual({ kind: "cover", value: "https://cdn.test/cover.png" });
  });

  it("reads the first url out of a files array", () => {
    const preview = resolveCardPreview(
      row({ cover: [{ url: "https://cdn.test/a.png" }, { url: "https://cdn.test/b.png" }] }),
      properties,
      { coverPropertyId: "cover" },
    );
    expect(preview.kind).toBe("cover");
    expect(preview.value).toBe("https://cdn.test/a.png");
  });

  it("reads a url out of an object value", () => {
    const preview = resolveCardPreview(
      row({ cover: { url: "  https://cdn.test/obj.png  " } }),
      properties,
      { coverPropertyId: "cover" },
    );
    expect(preview).toEqual({ kind: "cover", value: "https://cdn.test/obj.png" });
  });

  it("ignores a blank cover and falls back to the icon", () => {
    const preview = resolveCardPreview(row({ cover: "   " }), properties, {
      coverPropertyId: "cover",
      icon: "📄",
    });
    expect(preview).toEqual({ kind: "icon", value: "📄" });
  });

  it("ignores a cover property whose declared type is not media", () => {
    const preview = resolveCardPreview(
      row({ status: "In progress" }),
      properties,
      { coverPropertyId: "status", icon: "📄" },
    );
    expect(preview).toEqual({ kind: "icon", value: "📄" });
  });

  it("falls back to the icon when a stale cover property has no value", () => {
    const preview = resolveCardPreview(row({}), properties, {
      coverPropertyId: "deleted_property",
      icon: "📄",
    });
    expect(preview).toEqual({ kind: "icon", value: "📄" });
  });

  it("falls back to the row icon when no icon option is given", () => {
    const preview = resolveCardPreview(row({}, { icon: "🗂️" }), properties, {});
    expect(preview).toEqual({ kind: "icon", value: "🗂️" });
  });

  it("lets the icon option override the row icon", () => {
    const preview = resolveCardPreview(row({}, { icon: "🗂️" }), properties, {
      icon: "⭐",
    });
    expect(preview.value).toBe("⭐");
  });

  it("returns none when there is neither cover nor icon", () => {
    const preview = resolveCardPreview(row({}), properties, {});
    expect(preview).toEqual({ kind: "none" });
    expect(preview.value).toBeUndefined();
  });

  it("treats a whitespace-only icon as no icon", () => {
    expect(resolveCardPreview(row({}, { icon: "   " }), properties, {})).toEqual({
      kind: "none",
    });
  });

  it("does not mutate the row or its values", () => {
    const values = [{ propertyId: "cover", value: "https://cdn.test/x.png" }];
    const target = row({}, { propertyValues: values });
    const snapshot = JSON.parse(JSON.stringify(target));
    resolveCardPreview(target, properties, { coverPropertyId: "cover" });
    expect(target).toEqual(snapshot);
    expect(values).toEqual([{ propertyId: "cover", value: "https://cdn.test/x.png" }]);
  });
});

describe("cardFieldOrder", () => {
  it("keeps schema order", () => {
    expect(cardFieldOrder(properties)).toEqual(["title", "cover", "status"]);
  });

  it("excludes the property duplicated by the card preview", () => {
    expect(cardFieldOrder(properties, { previewPropertyId: "cover" })).toEqual([
      "title",
      "status",
      "owner",
    ]);
  });

  it("caps the list at the default limit", () => {
    expect(cardFieldOrder(properties)).toHaveLength(3);
  });

  it("honours a custom maxFields cap", () => {
    expect(cardFieldOrder(properties, { maxFields: 2 })).toEqual(["title", "cover"]);
  });

  it("returns nothing when maxFields is zero", () => {
    expect(cardFieldOrder(properties, { maxFields: 0 })).toEqual([]);
  });

  it("returns every field when maxFields is Infinity", () => {
    expect(cardFieldOrder(properties, { maxFields: Infinity })).toEqual([
      "title",
      "cover",
      "status",
      "owner",
      "link",
    ]);
  });

  it("applies the cap after excluding the preview property", () => {
    expect(
      cardFieldOrder(properties, { previewPropertyId: "title", maxFields: 2 }),
    ).toEqual(["cover", "status"]);
  });

  it("handles empty props", () => {
    expect(cardFieldOrder([])).toEqual([]);
  });

  it("does not mutate the schema", () => {
    const snapshot = JSON.parse(JSON.stringify(properties));
    cardFieldOrder(properties, { previewPropertyId: "cover", maxFields: 1 });
    expect(properties).toEqual(snapshot);
  });
});

describe("card size presets", () => {
  it("maps each named size to its column count", () => {
    expect(CARD_SIZES.small.columns).toBe(4);
    expect(CARD_SIZES.medium.columns).toBe(3);
    expect(CARD_SIZES.large.columns).toBe(2);
  });

  it("exposes an aspect ratio for every size", () => {
    expect(CARD_SIZES.small.aspect).toBe("1 / 1");
    expect(CARD_SIZES.medium.aspect).toBe("4 / 3");
    expect(CARD_SIZES.large.aspect).toBe("16 / 9");
  });

  it("only shows the cover on medium and large cards", () => {
    expect(CARD_SIZES.small.showPreview).toBe(false);
    expect(CARD_SIZES.medium.showPreview).toBe(true);
    expect(CARD_SIZES.large.showPreview).toBe(true);
  });
});

describe("cardSizeFor", () => {
  it("picks small on a narrow container", () => {
    expect(cardSizeFor(320)).toBe("small");
  });

  it("stays small just below the medium breakpoint", () => {
    expect(cardSizeFor(639)).toBe("small");
  });

  it("picks medium at the medium breakpoint", () => {
    expect(cardSizeFor(640)).toBe("medium");
  });

  it("stays medium just below the large breakpoint", () => {
    expect(cardSizeFor(1023)).toBe("medium");
  });

  it("picks large at the large breakpoint", () => {
    expect(cardSizeFor(1024)).toBe("large");
  });

  it("picks large on a very wide container", () => {
    expect(cardSizeFor(4096)).toBe("large");
  });

  it("falls back to small for degenerate widths", () => {
    expect(cardSizeFor(0)).toBe("small");
    expect(cardSizeFor(-100)).toBe("small");
    expect(cardSizeFor(Number.NaN)).toBe("small");
  });
});

describe("listRowModel", () => {
  it("uses the title as the primary line", () => {
    expect(listRowModel(row({}), properties, { density: "compact" }).primary).toBe(
      "Row one",
    );
  });

  it("collapses a compact row", () => {
    expect(listRowModel(row({}), properties, { density: "compact" }).expanded).toBe(
      false,
    );
  });

  it("expands a comfortable row", () => {
    expect(
      listRowModel(row({}), properties, { density: "comfortable" }).expanded,
    ).toBe(true);
  });

  it("uses the first non-empty property value as the secondary line", () => {
    const model = listRowModel(row({ status: "In progress", owner: "Ada" }), properties, {
      density: "compact",
    });
    expect(model.secondary).toBe("In progress");
  });

  it("skips empty property values when choosing the secondary line", () => {
    const model = listRowModel(row({ status: "", owner: "Ada" }), properties, {
      density: "compact",
    });
    expect(model.secondary).toBe("Ada");
  });

  it("renders numbers, booleans and arrays as text", () => {
    const compact = listRowModel(row({ status: 42 }), properties, { density: "compact" });
    expect(compact.secondary).toBe("42");
    const bool = listRowModel(row({ status: true }), properties, { density: "compact" });
    expect(bool.secondary).toBe("Yes");
    const list = listRowModel(row({ status: ["a", "b"] }), properties, {
      density: "compact",
    });
    expect(list.secondary).toBe("a, b");
  });

  it("defaults to compact for a missing or unknown density", () => {
    expect(listRowModel(row({}), properties, {}).expanded).toBe(false);
    expect(
      listRowModel(row({}), properties, { density: "loose" as never }).expanded,
    ).toBe(false);
  });

  it("handles empty rows and empty schemas", () => {
    const model = listRowModel(row({}, { title: "" }), [], { density: "compact" });
    expect(model.primary).toBe("");
    expect(model.secondary).toBe("");
  });

  it("does not mutate the row", () => {
    const target = row({ status: "Todo" });
    const snapshot = JSON.parse(JSON.stringify(target));
    listRowModel(target, properties, { density: "comfortable" });
    expect(target).toEqual(snapshot);
  });
});

describe("densityOptions", () => {
  it("offers compact and comfortable in that order", () => {
    expect(densityOptions().map((option) => option.value)).toEqual([
      "compact",
      "comfortable",
    ]);
  });

  it("labels each option for the UI", () => {
    expect(densityOptions()).toEqual([
      { value: "compact", label: "Compact" },
      { value: "comfortable", label: "Comfortable" },
    ]);
  });

  it("returns a fresh array each call", () => {
    const first = densityOptions();
    const second = densityOptions();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

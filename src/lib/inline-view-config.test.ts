import { describe, expect, it } from "vitest";
import {
  inlineDisplayForViewType,
  resolveInlineView,
  sanitizeInlineOverrides,
  setInlineOverride,
  toggleVisibleProperty,
  visibleInlineProperties,
} from "@/lib/inline-view-config";

/**
 * Inline / linked database node view configuration.
 *
 * The node persists `sourceViewId`, `mode`, `display` and `overrides`. These
 * tests pin the read-back contract: a JSON round-trip keeps a configuration,
 * a stale/foreign view falls back to the source's first view, and overrides
 * that name properties the source no longer has are clamped instead of being
 * applied to the wrong schema.
 */

const properties = [
  { id: "title", name: "Title", type: "TEXT" },
  { id: "status", name: "Status", type: "STATUS" },
  { id: "estimate", name: "Estimate", type: "NUMBER" },
];

const views = [
  {
    id: "v1",
    name: "Table view",
    type: "TABLE",
    config: {
      filters: [{ propertyId: "status", operator: "is", value: "todo" }],
      sorts: [{ propertyId: "estimate", direction: "asc" }],
    },
  },
  {
    id: "v2",
    name: "Board view",
    type: "BOARD",
    config: { groupByPropertyId: "status" },
  },
];

function resolve(overrides: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return resolveInlineView({
    instanceId: "block-1",
    databaseId: "db-1",
    views,
    properties,
    sourceViewId: "v1",
    mode: "detached",
    ...extra,
    overrides,
  });
}

describe("inlineDisplayForViewType", () => {
  it("maps renderable source types and falls back to gallery", () => {
    expect(inlineDisplayForViewType("TABLE")).toBe("table");
    expect(inlineDisplayForViewType("list")).toBe("list");
    expect(inlineDisplayForViewType("BOARD")).toBe("board");
    expect(inlineDisplayForViewType("GALLERY")).toBe("gallery");
    expect(inlineDisplayForViewType("CALENDAR")).toBe("gallery");
    expect(inlineDisplayForViewType(null)).toBe("gallery");
  });
});

describe("resolveInlineView — persistence + fallback", () => {
  it("round-trips the node attrs through JSON", () => {
    const attrs = {
      sourceViewId: "v2",
      mode: "detached",
      display: "board",
      overrides: {
        visiblePropertyIds: ["title", "status"],
        groupByPropertyId: "status",
        sorts: [{ propertyId: "estimate", direction: "desc" }],
      },
    };
    const restored = JSON.parse(JSON.stringify(attrs)) as typeof attrs;
    const resolved = resolveInlineView({
      instanceId: "block-1",
      databaseId: "db-1",
      views,
      properties,
      ...restored,
    });
    expect(resolved.staleView).toBe(false);
    expect(resolved.sourceView?.id).toBe("v2");
    expect(resolved.display).toBe("board");
    expect(resolved.visiblePropertyIds).toEqual(["title", "status"]);
    expect(resolved.groupByPropertyId).toBe("status");
    expect(resolved.effective.sorts).toEqual([
      { propertyId: "estimate", direction: "desc" },
    ]);
  });

  it("falls back to the first view and drops overrides when the bound view is stale", () => {
    const resolved = resolve(
      {
        visiblePropertyIds: ["title"],
        groupByPropertyId: "status",
        filters: [{ propertyId: "status", operator: "is", value: "done" }],
      },
      { sourceViewId: "deleted-view" },
    );
    expect(resolved.staleView).toBe(true);
    expect(resolved.sourceView?.id).toBe("v1");
    expect(resolved.linked.overrides).toEqual({});
    expect(resolved.visiblePropertyIds).toBeUndefined();
    expect(resolved.groupByPropertyId).toBeUndefined();
    // The source view's own config still applies.
    expect(resolved.effective.filters).toEqual([
      { propertyId: "status", operator: "is", value: "todo" },
    ]);
  });

  it("clamps a foreign visible-property list, group and sorts to the live schema", () => {
    const resolved = resolve({
      visiblePropertyIds: ["ghost", "missing"],
      groupByPropertyId: "ghost",
      sorts: [
        { propertyId: "ghost", direction: "asc" },
        { propertyId: "estimate", direction: "desc" },
      ],
    });
    expect(resolved.effective.visiblePropertyIds).toBeUndefined();
    expect(resolved.groupByPropertyId).toBeUndefined();
    expect(resolved.effective.sorts).toEqual([
      { propertyId: "estimate", direction: "desc" },
    ]);
  });

  it("drops a group-by that exists but is not groupable", () => {
    const resolved = resolve({ groupByPropertyId: "estimate" });
    expect(resolved.groupByPropertyId).toBeUndefined();
  });

  it("honours an explicit display and ignores an invalid one", () => {
    expect(resolve({}, { display: "list" }).display).toBe("list");
    expect(resolve({}, { display: "calendar" }).display).toBe("table");
  });

  it("survives a source with no views", () => {
    const resolved = resolveInlineView({
      instanceId: "block-1",
      databaseId: "db-1",
      views: [],
      properties,
      sourceViewId: "v1",
      mode: "detached",
      overrides: { visiblePropertyIds: ["title"] },
    });
    expect(resolved.sourceView).toBeNull();
    expect(resolved.staleView).toBe(true);
    expect(resolved.display).toBe("gallery");
    expect(resolved.sourceConfig).toBeNull();
  });
});

describe("override editing helpers", () => {
  it("sets and clears a persisted override without mutating the input", () => {
    const before = { groupByPropertyId: "status" };
    const added = setInlineOverride(before, "visiblePropertyIds", ["title"]);
    expect(added).toEqual({
      groupByPropertyId: "status",
      visiblePropertyIds: ["title"],
    });
    expect(before).toEqual({ groupByPropertyId: "status" });
    expect(setInlineOverride(added, "visiblePropertyIds", undefined)).toEqual({
      groupByPropertyId: "status",
    });
  });

  it("toggles visible properties without duplicates", () => {
    const selected = toggleVisibleProperty(["title", "status"], "status", false);
    expect(selected).toEqual(["title"]);
    expect(toggleVisibleProperty(selected, "estimate", true)).toEqual([
      "title",
      "estimate",
    ]);
  });

  it("resolves the settings selection against the effective config", () => {
    expect(visibleInlineProperties(properties, {})).toEqual([
      "title",
      "status",
      "estimate",
    ]);
    expect(
      visibleInlineProperties(properties, {
        visiblePropertyIds: ["status", "ghost"],
      }),
    ).toEqual(["status"]);
  });
});

describe("sanitizeInlineOverrides", () => {
  it("is a no-op for a well-formed override object", () => {
    const overrides = {
      visiblePropertyIds: ["title", "status"],
      groupByPropertyId: "status",
      sorts: [{ propertyId: "estimate", direction: "asc" }],
    };
    expect(sanitizeInlineOverrides(overrides, properties)).toEqual(overrides);
  });

  it("drops non-array visible ids and malformed sorts", () => {
    expect(
      sanitizeInlineOverrides(
        {
          visiblePropertyIds: "title",
          sorts: [{ propertyId: "status", direction: "sideways" }],
        },
        properties,
      ),
    ).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import {
  canWriteLinkedRows,
  convertMode,
  createLinkedView,
  describeLinkedView,
  instancesForDatabase,
  resolveViewConfig,
  staleOverrides,
  validateLinkedView,
  type LinkedView,
} from "@/lib/linked-view";
import { normalizeViewConfig, type ViewConfig } from "@/lib/database-query";

/**
 * Linked-database view identity + per-instance overrides (R89.14 / R89.15).
 *
 * `src/lib/linked-view.ts` did not exist when this file was first written
 * (module-not-found -> suite red; "Red-first").
 *
 * A linked block is an *instance* of a database bound to one source view. The
 * instance carries a `mode`:
 *  - `"synced"`  -> mirrors the source view (its filters/sorts win); only
 *                   display-level overrides may apply locally;
 *  - `"detached"` -> owns its full config; overrides (including filters/sorts)
 *                   win over the source.
 *
 * Everything here is pure: no Prisma, no React, no clock, no I/O. Inputs are
 * never mutated; every function is total apart from the factory's explicit
 * identity validation.
 */

const source: ViewConfig = {
  filters: [{ propertyId: "status", operator: "is", value: "todo" }],
  sorts: [{ propertyId: "due", direction: "asc" }],
  filterMode: "and",
  groupByPropertyId: "status",
  visiblePropertyIds: ["status", "due"],
  description: "Source view",
  cardSize: "medium",
};

const base: LinkedView = {
  instanceId: "inst-1",
  databaseId: "db-1",
  sourceViewId: "view-1",
  mode: "synced",
  overrides: {},
};

/** Build an instance with arbitrary (possibly unknown) override keys. */
const withOverrides = (
  linked: LinkedView,
  overrides: Record<string, unknown>,
): LinkedView => ({ ...linked, overrides: overrides as LinkedView["overrides"] });

describe("createLinkedView", () => {
  it("defaults to synced mode with no overrides", () => {
    const view = createLinkedView({ instanceId: "i1", databaseId: "d1" });
    expect(view).toEqual({
      instanceId: "i1",
      databaseId: "d1",
      mode: "synced",
      overrides: {},
    });
    expect(view.sourceViewId).toBeUndefined();
  });

  it("keeps an explicit sourceViewId and detached mode", () => {
    const view = createLinkedView({
      instanceId: "i1",
      databaseId: "d1",
      sourceViewId: "v9",
      mode: "detached",
    });
    expect(view.sourceViewId).toBe("v9");
    expect(view.mode).toBe("detached");
    expect(view.overrides).toEqual({});
  });

  it("trims identity fields and drops a blank sourceViewId", () => {
    const view = createLinkedView({
      instanceId: "  i1  ",
      databaseId: "  d1  ",
      sourceViewId: "   ",
    });
    expect(view.instanceId).toBe("i1");
    expect(view.databaseId).toBe("d1");
    expect(view.sourceViewId).toBeUndefined();
  });

  it("returns a fresh, independent overrides object", () => {
    const a = createLinkedView({ instanceId: "i1", databaseId: "d1" });
    const b = createLinkedView({ instanceId: "i2", databaseId: "d1" });
    a.overrides.description = "only on a";
    expect(b.overrides).toEqual({});
  });

  it("rejects an empty instanceId", () => {
    expect(() => createLinkedView({ instanceId: "  ", databaseId: "d1" })).toThrow(
      /instanceId/,
    );
  });

  it("rejects an empty databaseId", () => {
    expect(() => createLinkedView({ instanceId: "i1", databaseId: "" })).toThrow(
      /databaseId/,
    );
  });
});

describe("resolveViewConfig", () => {
  it("merges non-filter overrides over the source", () => {
    const linked = withOverrides(base, { description: "Instance view", cardSize: "large" });
    const resolved = resolveViewConfig(source, linked);
    expect(resolved.description).toBe("Instance view");
    expect(resolved.cardSize).toBe("large");
    // untouched keys keep the source value
    expect(resolved.groupByPropertyId).toBe("status");
    expect(resolved.visiblePropertyIds).toEqual(["status", "due"]);
  });

  it("keeps the source filters in synced mode even when overridden", () => {
    const linked = withOverrides(base, {
      filters: [{ propertyId: "status", operator: "is", value: "done" }],
    });
    const resolved = resolveViewConfig(source, linked);
    expect(resolved.filters).toEqual(source.filters);
  });

  it("keeps the source sorts and filter mode in synced mode", () => {
    const linked = withOverrides(base, {
      sorts: [{ propertyId: "status", direction: "desc" }],
      filterMode: "or",
    });
    const resolved = resolveViewConfig(source, linked);
    expect(resolved.sorts).toEqual(source.sorts);
    expect(resolved.filterMode).toBe("and");
  });

  it("drops a filter tree override in synced mode when the source has none", () => {
    const linked = withOverrides(base, {
      filterTree: [{ and: [{ propertyId: "status", operator: "is", value: "done" }] }],
    });
    const resolved = resolveViewConfig(source, linked);
    expect(resolved.filterTree).toBeUndefined();
  });

  it("applies filter and sort overrides in detached mode", () => {
    const detached: LinkedView = { ...base, mode: "detached" };
    const linked = withOverrides(detached, {
      filters: [{ propertyId: "status", operator: "is", value: "done" }],
      sorts: [{ propertyId: "status", direction: "desc" }],
    });
    const resolved = resolveViewConfig(source, linked);
    expect(resolved.filters).toEqual([
      { propertyId: "status", operator: "is", value: "done" },
    ]);
    expect(resolved.sorts).toEqual([{ propertyId: "status", direction: "desc" }]);
  });

  it("falls back to the source when a detached override is absent", () => {
    const detached: LinkedView = { ...base, mode: "detached" };
    const resolved = resolveViewConfig(source, withOverrides(detached, { cardSize: "small" }));
    expect(resolved.filters).toEqual(source.filters);
    expect(resolved.sorts).toEqual(source.sorts);
    expect(resolved.cardSize).toBe("small");
  });

  it("treats a missing source as an empty config", () => {
    const syncedDesc = resolveViewConfig(null, withOverrides(base, { description: "d" }));
    expect(syncedDesc.description).toBe("d");
    // synced mode still drops filter/sort overrides with no source
    const syncedFilters = resolveViewConfig(null, withOverrides(base, { filters: source.filters }));
    expect(syncedFilters.filters).toBeUndefined();

    const detached: LinkedView = { ...base, mode: "detached" };
    const detachedFilters = resolveViewConfig(
      undefined,
      withOverrides(detached, { filters: source.filters }),
    );
    expect(detachedFilters.filters).toEqual(source.filters);
  });

  it("normalizes the merged result and drops unknown override keys", () => {
    const linked = withOverrides(base, {
      description: "ok",
      bogusKey: "nope",
    });
    const resolved = resolveViewConfig(source, linked);
    expect(resolved.description).toBe("ok");
    expect("bogusKey" in (resolved as Record<string, unknown>)).toBe(false);
  });

  it("does not mutate the source or the instance", () => {
    const linked = withOverrides(base, { description: "changed" });
    const beforeSource = JSON.parse(JSON.stringify(source));
    const beforeLinked = JSON.parse(JSON.stringify(linked));
    resolveViewConfig(source, linked);
    expect(source).toEqual(beforeSource);
    expect(linked).toEqual(beforeLinked);
  });
});

describe("convertMode", () => {
  it("drops overrides when converting detached -> synced", () => {
    const detached: LinkedView = {
      ...base,
      mode: "detached",
      overrides: { description: "local", cardSize: "large" },
    };
    const synced = convertMode(detached, "synced");
    expect(synced.mode).toBe("synced");
    expect(synced.overrides).toEqual({});
  });

  it("snapshots the effective config when converting synced -> detached", () => {
    const linked = withOverrides(base, { description: "Instance" });
    const detached = convertMode(linked, "detached", source);
    expect(detached.mode).toBe("detached");
    expect(detached.overrides.filters).toEqual(source.filters);
    expect(detached.overrides.sorts).toEqual(source.sorts);
    expect(detached.overrides.description).toBe("Instance");
  });

  it("round-trips the effective config through detached -> synced", () => {
    const linked = withOverrides(base, { description: "Instance", cardSize: "large" });
    const effective = resolveViewConfig(source, linked);
    const detached = convertMode(linked, "detached", source);
    const syncedAgain = convertMode(detached, "synced");
    // detaching preserves what the block rendered...
    expect(resolveViewConfig(source, detached)).toEqual(effective);
    // ...then syncing back drops the local overrides and mirrors the source.
    expect(resolveViewConfig(source, syncedAgain)).toEqual(normalizeViewConfig(source));
  });

  it("keeps existing overrides when detaching without a source config", () => {
    const linked = withOverrides(base, { description: "Instance" });
    const detached = convertMode(linked, "detached");
    expect(detached.mode).toBe("detached");
    expect(detached.overrides).toEqual({ description: "Instance" });
  });

  it("returns an equivalent copy when the mode is unchanged", () => {
    const linked = withOverrides(base, { description: "Instance" });
    const same = convertMode(linked, "synced", source);
    expect(same).toEqual(linked);
    expect(same).not.toBe(linked);
  });

  it("never mutates the instance it converts", () => {
    const linked: LinkedView = {
      ...base,
      mode: "detached",
      overrides: { description: "local" },
    };
    convertMode(linked, "synced");
    expect(linked.mode).toBe("detached");
    expect(linked.overrides).toEqual({ description: "local" });
  });
});

describe("validateLinkedView", () => {
  const exists = () => true;

  it("accepts a well-formed instance", () => {
    const result = validateLinkedView(base, { exists });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags a dangling source database", () => {
    const result = validateLinkedView(base, { exists: () => false });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_database");
  });

  it("flags a dangling source view when the checker is provided", () => {
    const result = validateLinkedView(base, {
      exists,
      viewExists: (_databaseId, viewId) => viewId !== "view-1",
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("unknown_source_view");
  });

  it("does not check the source view when no checker is provided", () => {
    expect(validateLinkedView(base, { exists }).valid).toBe(true);
  });

  it("flags unknown override keys, sorted for determinism", () => {
    const linked = withOverrides(base, { zebra: 1, apple: 2, description: "ok" });
    const result = validateLinkedView(linked, { exists });
    expect(result.valid).toBe(false);
    const unknown = result.issues.filter((issue) => issue.code === "unknown_override_key");
    expect(unknown.map((issue) => issue.key)).toEqual(["apple", "zebra"]);
  });

  it("flags empty identity fields", () => {
    const linked: LinkedView = { ...base, instanceId: "", databaseId: "" };
    const result = validateLinkedView(linked, { exists });
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("empty_instance_id");
    expect(codes).toContain("empty_database_id");
  });

  it("collects multiple independent issues at once", () => {
    const linked = withOverrides({ ...base, instanceId: "" }, { bogus: true });
    const result = validateLinkedView(linked, {
      exists: () => true,
      viewExists: () => false,
    });
    expect(result.valid).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("empty_instance_id");
    expect(codes).toContain("unknown_source_view");
    expect(codes).toContain("unknown_override_key");
  });

  it("accepts every known ViewConfig override key", () => {
    const linked = withOverrides(base, {
      filters: source.filters,
      filterMode: "and",
      filterTree: [{ and: [] }],
      sorts: source.sorts,
      groupByPropertyId: "status",
      visiblePropertyIds: ["status"],
      freezeFirstColumn: true,
      colorRules: [{ propertyId: "status", operator: "is", value: "todo", color: "red" }],
      laneBy: "status",
      wipLimits: { todo: 3 },
      numberFormat: { kind: "number" },
      columnLayout: "[{}]",
      visibleGroups: { todo: false },
      cardSize: "large",
      description: "ok",
      chartType: "pie",
      chartAggregate: "count",
      aggregationPropertyId: "estimate",
      previewPropertyId: "status",
    });
    const result = validateLinkedView(linked, { exists });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe("instancesForDatabase", () => {
  const views: LinkedView[] = [
    { instanceId: "a", databaseId: "db-1", mode: "synced", overrides: {} },
    { instanceId: "b", databaseId: "db-2", mode: "detached", overrides: {} },
    { instanceId: "c", databaseId: "db-1", mode: "detached", overrides: {} },
  ];

  it("returns every instance bound to the database, in order", () => {
    expect(instancesForDatabase(views, "db-1").map((v) => v.instanceId)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns an empty list when no instance matches", () => {
    expect(instancesForDatabase(views, "db-9")).toEqual([]);
  });

  it("is not confused by a source view id", () => {
    const withView: LinkedView[] = [
      { instanceId: "a", databaseId: "db-1", sourceViewId: "db-2", mode: "synced", overrides: {} },
    ];
    expect(instancesForDatabase(withView, "db-2")).toEqual([]);
  });
});

describe("describeLinkedView", () => {
  it("names a synced instance and its source view", () => {
    expect(describeLinkedView(base)).toBe(
      "Synced linked view of db-1 via view view-1 (inst-1)",
    );
  });

  it("names a detached instance without a source view", () => {
    const linked: LinkedView = {
      instanceId: "inst-2",
      databaseId: "db-2",
      mode: "detached",
      overrides: {},
    };
    expect(describeLinkedView(linked)).toBe(
      "Detached linked view of db-2 via default view (inst-2)",
    );
  });
});

describe("staleOverrides", () => {
  it("reports an override identical to the source value", () => {
    const linked = withOverrides(base, { description: source.description });
    expect(staleOverrides(source, linked)).toEqual(["description"]);
  });

  it("ignores an override that differs from the source", () => {
    const linked = withOverrides(base, { description: "different" });
    expect(staleOverrides(source, linked)).toEqual([]);
  });

  it("compares arrays and objects deeply", () => {
    const linked = withOverrides(base, {
      filters: [{ propertyId: "status", operator: "is", value: "todo" }],
      visiblePropertyIds: ["due", "status"],
    });
    // filters equal (deep, key-order insensitive); visiblePropertyIds differ
    expect(staleOverrides(source, linked)).toEqual(["filters"]);
  });

  it("does not report a key the source never had", () => {
    const linked = withOverrides(base, { chartType: "pie" });
    expect(staleOverrides(source, linked)).toEqual([]);
  });

  it("returns nothing for an instance with no overrides", () => {
    expect(staleOverrides(source, base)).toEqual([]);
  });

  it("ignores unknown override keys", () => {
    const linked = withOverrides(base, { bogus: "x", description: source.description });
    expect(staleOverrides(source, linked)).toEqual(["description"]);
  });

  it("treats a missing source as having no keys", () => {
    const linked = withOverrides(base, { description: "d" });
    expect(staleOverrides(null, linked)).toEqual([]);
  });
});

describe("normalizeViewConfig interop", () => {
  it("a resolved config round-trips through the shared normalizer", () => {
    const linked = withOverrides(base, { description: "Instance" });
    const resolved = resolveViewConfig(source, linked);
    expect(normalizeViewConfig(resolved)).toEqual(resolved);
  });
});

describe("canWriteLinkedRows", () => {
  it("only writes through a detached instance the reader may edit", () => {
    expect(canWriteLinkedRows("detached", true)).toBe(true);
    expect(canWriteLinkedRows("detached", false)).toBe(false);
    expect(canWriteLinkedRows("synced", true)).toBe(false);
    expect(canWriteLinkedRows("synced", false)).toBe(false);
    expect(canWriteLinkedRows(null, true)).toBe(false);
  });
});

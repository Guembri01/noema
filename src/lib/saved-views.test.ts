import { describe, expect, it } from "vitest";
import {
  applySavedView,
  deserializeSavedViews,
  findByName,
  parseSavedView,
  serializeSavedViews,
  validateSavedView,
} from "./saved-views";
import type { SavedView, ViewConfigLike } from "./saved-views";

/**
 * Saved views — named filter/sort/group presets (docs/MISSING_FEATURES.md §2
 * "Saved views": "Named filter/sort/group presets for databases and tickets").
 *
 * Red-first: `src/lib/saved-views.ts` did not exist when this file was written,
 * so the suite fails on the missing module until the helpers land. This is the
 * pure storage/validation half — tolerant parsing, validation, JSON
 * (de)serialisation with case-insensitive de-duplication, merging a preset onto
 * a base view config, and name lookup. No DB, no routes, no React.
 */

const view = (overrides: Partial<SavedView> = {}): SavedView => ({
  id: "sv_one",
  name: "My view",
  scope: "database",
  ...overrides,
});

describe("parseSavedView", () => {
  it("parses a JSON string into a view", () => {
    const parsed = parseSavedView(JSON.stringify({ id: "sv_a", name: "Alpha", scope: "tickets" }));
    expect(parsed).toMatchObject({ id: "sv_a", name: "Alpha", scope: "tickets" });
  });

  it("parses an already-decoded object", () => {
    expect(parseSavedView({ id: "sv_b", name: "Beta", scope: "database" })?.name).toBe("Beta");
  });

  it("trims the name", () => {
    expect(parseSavedView({ name: "  Spaced  " })?.name).toBe("Spaced");
  });

  it("defaults a missing scope to database", () => {
    expect(parseSavedView({ name: "Loose" })?.scope).toBe("database");
  });

  it("defaults an unknown scope to database rather than dropping the view", () => {
    expect(parseSavedView({ name: "Odd", scope: "kanban" })?.scope).toBe("database");
  });

  it("keeps an explicit tickets scope", () => {
    expect(parseSavedView({ name: "Board", scope: "tickets" })?.scope).toBe("tickets");
  });

  it("derives an id from the name when none is stored", () => {
    expect(parseSavedView({ name: "Team Sprint" })?.id).toBe("sv_team-sprint");
  });

  it("keeps a stored id", () => {
    expect(parseSavedView({ id: "custom_1", name: "X" })?.id).toBe("custom_1");
  });

  it("accepts filter, sort, group, hidden and viewType loosely", () => {
    const parsed = parseSavedView({
      name: "Full",
      viewType: "board",
      filter: [{ propertyId: "status", operator: "is", value: "Done" }, { and: [] }],
      sort: [{ propertyId: "due", direction: "desc" }],
      group: "status",
      hidden: ["secret"],
    });
    expect(parsed?.viewType).toBe("board");
    expect(parsed?.filter).toEqual([
      { propertyId: "status", operator: "is", value: "Done" },
      { and: [] },
    ]);
    expect(parsed?.sort).toEqual([{ propertyId: "due", direction: "desc" }]);
    expect(parsed?.group).toBe("status");
    expect(parsed?.hidden).toEqual(["secret"]);
  });

  it("normalises an unknown sort direction to ascending", () => {
    expect(parseSavedView({ name: "S", sort: [{ propertyId: "a", direction: "up" }] })?.sort).toEqual([
      { propertyId: "a", direction: "asc" },
    ]);
  });

  it("drops malformed sort entries that have no propertyId", () => {
    expect(parseSavedView({ name: "S", sort: [{ direction: "desc" }, { propertyId: "ok" }] })?.sort).toEqual([
      { propertyId: "ok", direction: "asc" },
    ]);
  });

  it("de-duplicates and blanks out bad hidden entries", () => {
    expect(parseSavedView({ name: "H", hidden: ["a", "", "a", 7, "b"] })?.hidden).toEqual(["a", "b"]);
  });

  it("ignores a non-array filter", () => {
    expect(parseSavedView({ name: "F", filter: "nope" })?.filter).toBeUndefined();
  });

  it("returns null for non-objects and blank names", () => {
    expect(parseSavedView(null)).toBeNull();
    expect(parseSavedView("not json")).toBeNull();
    expect(parseSavedView(42)).toBeNull();
    expect(parseSavedView({ name: "   " })).toBeNull();
    expect(parseSavedView({})).toBeNull();
  });
});

describe("validateSavedView", () => {
  it("accepts a well-formed view", () => {
    expect(validateSavedView(view())).toEqual({ ok: true });
  });

  it("accepts a view with only the required fields", () => {
    expect(validateSavedView({ id: "a", name: "A", scope: "database" }).ok).toBe(true);
  });

  it("flags a missing id", () => {
    const result = validateSavedView({ name: "A", scope: "database" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing_id");
  });

  it("flags a blank name", () => {
    expect(validateSavedView({ id: "a", name: "   ", scope: "database" }).errors).toContain(
      "missing_name",
    );
  });

  it("flags an invalid scope", () => {
    expect(validateSavedView({ id: "a", name: "A", scope: "kanban" }).errors).toContain(
      "invalid_scope",
    );
  });

  it("flags a non-array filter and non-array hidden", () => {
    const result = validateSavedView(
      view({ filter: "nope" as unknown as SavedView["filter"], hidden: "x" as unknown as string[] }),
    );
    expect(result.errors).toContain("invalid_filter");
    expect(result.errors).toContain("invalid_hidden");
  });

  it("flags a sort entry with no propertyId", () => {
    expect(
      validateSavedView(view({ sort: [{ direction: "desc" } as unknown as { propertyId: string }] }))
        .errors,
    ).toContain("invalid_sort");
  });

  it("collects every problem in one pass", () => {
    const result = validateSavedView({ scope: "nope" });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining(["missing_id", "missing_name", "invalid_scope"]),
    );
  });
});

describe("serialize / deserialize", () => {
  it("round-trips a list of views", () => {
    const views = [view({ id: "sv_a", name: "Alpha" }), view({ id: "sv_b", name: "Beta", scope: "tickets" })];
    expect(deserializeSavedViews(serializeSavedViews(views))).toEqual(views);
  });

  it("serialises to a JSON array string", () => {
    const raw = serializeSavedViews([view({ id: "sv_a", name: "Alpha" })]);
    expect(JSON.parse(raw)).toEqual([{ id: "sv_a", name: "Alpha", scope: "database" }]);
  });

  it("serialises an empty list to an empty JSON array", () => {
    expect(serializeSavedViews([])).toBe("[]");
  });

  it("de-duplicates ids on serialise", () => {
    const raw = serializeSavedViews([
      view({ id: "same", name: "First" }),
      view({ id: "same", name: "Second" }),
    ]);
    expect(deserializeSavedViews(raw)).toHaveLength(1);
    expect(deserializeSavedViews(raw)[0].name).toBe("First");
  });

  it("de-duplicates ids on deserialise", () => {
    const parsed = deserializeSavedViews(
      JSON.stringify([
        { id: "dup", name: "One" },
        { id: "dup", name: "Two" },
      ]),
    );
    expect(parsed).toHaveLength(1);
  });

  it("de-duplicates names case-insensitively, keeping the first", () => {
    const parsed = deserializeSavedViews(
      JSON.stringify([
        { id: "a", name: "Roadmap" },
        { id: "b", name: "  roadmap  " },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("a");
  });

  it("keeps an already-decoded array (not just a string)", () => {
    expect(deserializeSavedViews([{ id: "a", name: "A" }])).toHaveLength(1);
  });

  it("accepts a { views: [...] } wrapper", () => {
    expect(deserializeSavedViews({ views: [{ id: "a", name: "A" }] })[0].name).toBe("A");
  });

  it("returns an empty list for malformed JSON or wrong shapes", () => {
    expect(deserializeSavedViews("{not json")).toEqual([]);
    expect(deserializeSavedViews(null)).toEqual([]);
    expect(deserializeSavedViews(42)).toEqual([]);
  });

  it("skips unparseable entries", () => {
    expect(deserializeSavedViews([{ id: "a", name: "A" }, { name: "" }, null, "x"])).toHaveLength(1);
  });
});

describe("applySavedView", () => {
  const base: ViewConfigLike = {
    viewType: "table",
    filter: [{ propertyId: "old" }],
    sort: [{ propertyId: "old", direction: "asc" }],
    group: "old",
    hidden: ["x"],
  };

  it("overlays every preset field onto the base", () => {
    const merged = applySavedView(base, view({
      viewType: "board",
      filter: [{ propertyId: "status" }],
      sort: [{ propertyId: "due", direction: "desc" }],
      group: "status",
      hidden: ["y"],
    }));
    expect(merged).toEqual({
      viewType: "board",
      filter: [{ propertyId: "status" }],
      sort: [{ propertyId: "due", direction: "desc" }],
      group: "status",
      hidden: ["y"],
    });
  });

  it("keeps base fields the preset does not set", () => {
    const merged = applySavedView(base, view({ group: "status" }));
    expect(merged.viewType).toBe("table");
    expect(merged.filter).toEqual([{ propertyId: "old" }]);
    expect(merged.group).toBe("status");
  });

  it("works with no base config", () => {
    expect(applySavedView(null, view({ group: "status" }))).toEqual({ group: "status" });
    expect(applySavedView(undefined, view())).toEqual({});
  });

  it("returns fresh arrays so callers cannot mutate the inputs", () => {
    const merged = applySavedView(base, view());
    expect(merged.filter).not.toBe(base.filter);
    expect(merged.filter).toEqual(base.filter);
    merged.filter!.push({ propertyId: "leak" });
    expect(base.filter).toEqual([{ propertyId: "old" }]);
  });
});

describe("findByName", () => {
  const views = [view({ id: "a", name: "Roadmap" }), view({ id: "b", name: "Sprint Board" })];

  it("finds a view by name, ignoring case and surrounding space", () => {
    expect(findByName(views, "  sprint board ")?.id).toBe("b");
    expect(findByName(views, "ROADMAP")?.id).toBe("a");
  });

  it("returns undefined when nothing matches or the name is blank", () => {
    expect(findByName(views, "missing")).toBeUndefined();
    expect(findByName(views, "   ")).toBeUndefined();
  });
});

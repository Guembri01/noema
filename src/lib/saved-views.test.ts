import { describe, expect, it } from "vitest";
import {
  applySavedView,
  captureView,
  deleteView,
  describeSavedView,
  deserializeSavedViews,
  diffView,
  duplicateView,
  findByName,
  listSavedViews,
  parseSavedView,
  pinView,
  renameView,
  reorderViews,
  serializeSavedViews,
  validateSavedView,
} from "./saved-views";
import type { SavedView, SavedViewRecord, ViewConfigLike } from "./saved-views";

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

/* ---------------------------------------------------------------------------
   Named-preset engine (docs/MISSING_FEATURES.md §2 "Saved views", §3 Databases).
   A `SavedViewRecord` captures a normalised `ViewConfig` snapshot under a name
   and an audience; the helpers below capture it, validate it, diff and apply it,
   reorder/pin/rename/duplicate/delete it, list it ranked, and describe it.
   Red-first: these imports did not resolve until the engine landed.
   --------------------------------------------------------------------------- */

const TS = "2026-06-01T12:00:00.000Z";
const TS2 = "2026-06-02T12:00:00.000Z";

const record = (overrides: Partial<SavedViewRecord> = {}): SavedViewRecord => ({
  ...captureView({}, { name: "Sprint", scope: "personal", id: "sv_sprint", now: TS }),
  ...overrides,
});

describe("captureView", () => {
  it("captures a normalised snapshot and stamps both timestamps", () => {
    const view = captureView(
      { filters: [{ propertyId: "status", operator: "is", value: "Done" }] },
      { name: "Done", id: "sv_done", now: TS },
    );
    expect(view).toEqual({
      id: "sv_done",
      name: "Done",
      scope: "personal",
      config: { filters: [{ propertyId: "status", operator: "is", value: "Done" }] },
      createdAt: TS,
      updatedAt: TS,
    });
  });

  it("derives an id from the name when none is given", () => {
    expect(captureView({}, { name: "Team Sprint", now: TS }).id).toBe("sv_team-sprint");
  });

  it("keeps an explicit id and trims the name", () => {
    const view = captureView({}, { name: "  Roadmap  ", id: "custom_9", now: TS });
    expect(view.id).toBe("custom_9");
    expect(view.name).toBe("Roadmap");
  });

  it("defaults the scope to personal and accepts shared", () => {
    expect(captureView({}, { name: "A", now: TS }).scope).toBe("personal");
    expect(captureView({}, { name: "B", scope: "shared", now: TS }).scope).toBe("shared");
  });

  it("normalises the captured config, dropping unknown keys and de-duplicating", () => {
    const view = captureView(
      {
        filters: [],
        sorts: [
          { propertyId: "a", direction: "desc" },
          { propertyId: "a", direction: "asc" },
        ],
        visiblePropertyIds: ["x", "x", "y"],
        nope: true,
      },
      { name: "N", now: TS },
    );
    expect(view.config.sorts).toEqual([{ propertyId: "a", direction: "desc" }]);
    expect(view.config.visiblePropertyIds).toEqual(["x", "y"]);
    expect("nope" in view.config).toBe(false);
    expect(view.config.filters).toEqual([]);
  });

  it("does not mutate the input config", () => {
    const input = { filters: [{ propertyId: "a", operator: "is", value: "1" }] };
    const view = captureView(input, { name: "X", now: TS });
    view.config.filters![0].value = "mutated";
    expect(input.filters[0].value).toBe("1");
  });

  it("accepts a numeric now", () => {
    expect(captureView({}, { name: "N", now: Date.UTC(2026, 0, 2) }).createdAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });
});

describe("validateSavedView - named presets", () => {
  const existing: SavedViewRecord[] = [
    captureView({}, { name: "Sprint", scope: "personal", id: "sv_1", now: TS }),
    captureView({}, { name: "Shared board", scope: "shared", id: "sv_2", now: TS }),
  ];

  it("accepts a well-formed named view", () => {
    expect(validateSavedView(record({ id: "sv_x", name: "Unique" }), existing)).toEqual({
      ok: true,
    });
  });

  it("flags an empty name", () => {
    expect(validateSavedView(record({ name: "   " }), existing).errors).toContain("empty_name");
  });

  it("flags an empty id", () => {
    expect(validateSavedView(record({ id: "" }), existing).errors).toContain("empty_id");
  });

  it("flags a duplicate name in the same scope, case-insensitively", () => {
    expect(
      validateSavedView(record({ id: "sv_other", name: "  sprint  " }), existing).errors,
    ).toContain("duplicate_name");
  });

  it("allows the same name in a different scope", () => {
    const shared = captureView({}, { name: "Sprint", scope: "shared", id: "sv_3", now: TS });
    expect(validateSavedView(shared, [existing[0]]).ok).toBe(true);
  });

  it("does not flag a view against itself", () => {
    expect(validateSavedView(existing[0], existing).ok).toBe(true);
  });

  it("flags unsupported config keys", () => {
    const bad = record({ config: { nope: true } as unknown as SavedViewRecord["config"] });
    expect(validateSavedView(bad, []).errors).toContain("unsupported_key:nope");
  });

  it("accepts a config made only of known keys", () => {
    const good = record({ config: { filters: [], sorts: [], groupByPropertyId: null } });
    expect(validateSavedView(good, []).ok).toBe(true);
  });

  it("flags an invalid config and pinned value in one pass", () => {
    const bad = record({
      config: "nope" as unknown as SavedViewRecord["config"],
      pinned: "yes" as unknown as boolean,
    });
    expect(validateSavedView(bad, []).errors).toEqual(
      expect.arrayContaining(["invalid_config", "invalid_pinned"]),
    );
  });
});

describe("applySavedView - named presets", () => {
  const base = {
    filters: [{ propertyId: "a", operator: "is" as const, value: "1" }],
    sorts: [] as { propertyId: string; direction: "asc" | "desc" }[],
    freezeFirstColumn: true,
  };

  it("overlays the preset config while keeping unspecified base keys", () => {
    const view = captureView(
      { sorts: [{ propertyId: "b", direction: "desc" }] },
      { name: "V", now: TS },
    );
    const merged = applySavedView(base, view);
    expect(merged.freezeFirstColumn).toBe(true);
    expect(merged.sorts).toEqual([{ propertyId: "b", direction: "desc" }]);
    expect(merged.filters).toEqual(base.filters);
  });

  it("applies onto an empty base", () => {
    const view = captureView({ visiblePropertyIds: ["x"] }, { name: "V", now: TS });
    expect(applySavedView({}, view)).toEqual({ visiblePropertyIds: ["x"] });
  });

  it("does not mutate the base or the view", () => {
    const view = captureView(
      { filters: [{ propertyId: "z", operator: "is", value: "1" }] },
      { name: "V", now: TS },
    );
    const merged = applySavedView(base, view);
    merged.filters!.push({ propertyId: "leak", operator: "is" });
    expect(base.filters).toHaveLength(1);
    expect(view.config.filters).toHaveLength(1);
  });

  it("round-trips: applying a captured view reproduces its config", () => {
    const view = captureView(
      {
        filters: [{ propertyId: "a", operator: "is", value: "1" }],
        sorts: [{ propertyId: "b", direction: "asc" }],
      },
      { name: "V", now: TS },
    );
    expect(applySavedView({}, view)).toEqual(view.config);
  });
});

describe("diffView", () => {
  it("reports added, changed and removed keys", () => {
    const base = {
      filters: [{ propertyId: "a", operator: "is", value: "1" }],
      freezeFirstColumn: true,
    };
    const view = captureView(
      {
        filters: [{ propertyId: "a", operator: "is", value: "2" }],
        sorts: [{ propertyId: "s", direction: "asc" }],
      },
      { name: "V", now: TS },
    );
    expect(diffView(base, view)).toEqual([
      { key: "filters", kind: "changed", from: base.filters, to: view.config.filters },
      { key: "freezeFirstColumn", kind: "removed", from: true },
      { key: "sorts", kind: "added", to: view.config.sorts },
    ]);
  });

  it("returns an empty diff for identical configs", () => {
    const view = captureView({ sorts: [{ propertyId: "s", direction: "asc" }] }, { name: "V", now: TS });
    expect(diffView(view.config, view)).toEqual([]);
  });

  it("orders entries by key for determinism", () => {
    const view = captureView({ sorts: [], visiblePropertyIds: [] }, { name: "V", now: TS });
    expect(diffView({}, view).map((entry) => entry.key)).toEqual(["sorts", "visiblePropertyIds"]);
  });
});

describe("reducers", () => {
  const views: SavedViewRecord[] = [
    captureView({}, { name: "Alpha", id: "a", now: TS }),
    captureView({}, { name: "Beta", id: "b", now: TS }),
    captureView({}, { name: "Gamma", id: "c", now: TS }),
  ];

  it("renames a view and bumps updatedAt without mutating the input", () => {
    const next = renameView(views, "b", "  Beta renamed  ", TS2);
    expect(next[1].name).toBe("Beta renamed");
    expect(next[1].updatedAt).toBe(TS2);
    expect(next[1].createdAt).toBe(TS);
    expect(views[1].name).toBe("Beta");
    expect(next[0]).toBe(views[0]);
  });

  it("ignores a blank name (fresh, unchanged array)", () => {
    const next = renameView(views, "a", "   ", TS2);
    expect(next).toEqual(views);
    expect(next).not.toBe(views);
    expect(next[0]).toBe(views[0]);
  });

  it("reorders views by id without mutating the input", () => {
    const next = reorderViews(views, "c", "a");
    expect(next.map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(views.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op copy for an unknown or identical id", () => {
    expect(reorderViews(views, "missing", "a").map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(reorderViews(views, "a", "a").map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("pins and unpins a view without mutating the input", () => {
    const pinned = pinView(views, "a");
    expect(pinned[0].pinned).toBe(true);
    expect(views[0].pinned).toBeUndefined();
    expect(pinView(pinned, "a", false)[0].pinned).toBe(false);
  });

  it("duplicates a view after the original with a new id and name", () => {
    const next = duplicateView(views, "b", { now: TS2, id: "b2", name: "Beta copy" });
    expect(next.map((item) => item.id)).toEqual(["a", "b", "b2", "c"]);
    expect(next[2].name).toBe("Beta copy");
    expect(next[2].createdAt).toBe(TS2);
    expect(views).toHaveLength(3);
  });

  it("auto-names and auto-ids a duplicate when none is given", () => {
    const next = duplicateView(views, "a", { now: TS2 });
    expect(next[1].name).toBe("Alpha copy");
    expect(next[1].id).toBe("a-copy");
  });

  it("deletes a view by id without mutating the input", () => {
    const next = deleteView(views, "b");
    expect(next.map((item) => item.id)).toEqual(["a", "c"]);
    expect(views).toHaveLength(3);
  });
});

describe("listSavedViews", () => {
  const views: SavedViewRecord[] = [
    captureView({}, { name: "Roadmap", id: "r", scope: "personal", now: TS }),
    captureView({}, { name: "Sprint board", id: "s", scope: "shared", now: TS2 }),
    captureView({}, { name: "Sprint retro", id: "t", scope: "personal", now: TS }),
  ];

  it("filters by scope", () => {
    expect(listSavedViews(views, { scope: "personal" }).map((item) => item.id)).toEqual(["r", "t"]);
    expect(listSavedViews(views, { scope: "shared" }).map((item) => item.id)).toEqual(["s"]);
  });

  it("ranks an exact name match first and a prefix before a substring", () => {
    expect(listSavedViews(views, { query: "sprint" }).map((item) => item.id)).toEqual(["s", "t"]);
    expect(listSavedViews(views, { query: "roadmap" })[0].id).toBe("r");
  });

  it("keeps pinned views first even when sorting by name", () => {
    const pinned = [pinView(views, "t")[2], views[0], views[1]];
    expect(listSavedViews(pinned, { sort: "name" })[0].id).toBe("t");
  });

  it("sorts by name and by updated", () => {
    expect(listSavedViews(views, { sort: "name" }).map((item) => item.name)).toEqual([
      "Roadmap",
      "Sprint board",
      "Sprint retro",
    ]);
    expect(listSavedViews(views, { sort: "updated" })[0].id).toBe("s");
  });

  it("returns an empty list when nothing matches", () => {
    expect(listSavedViews(views, { query: "zzz" })).toEqual([]);
  });
});

describe("describeSavedView", () => {
  it("summarises name, scope, pin and config counts", () => {
    const view = captureView(
      {
        filters: [
          { propertyId: "a", operator: "is", value: "1" },
          { propertyId: "b", operator: "is", value: "2" },
        ],
        sorts: [{ propertyId: "a", direction: "asc" }],
        groupByPropertyId: "status",
      },
      { name: "Sprint", scope: "shared", id: "s", now: TS },
    );
    expect(describeSavedView({ ...view, pinned: true })).toBe(
      "Sprint (shared, pinned) — 2 filters, 1 sort, grouped by status",
    );
  });

  it("omits the detail list for an empty preset", () => {
    expect(describeSavedView(record({ name: "Plain" }))).toBe("Plain (personal)");
  });
});

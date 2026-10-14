import { describe, expect, it } from "vitest";
import {
  duplicateDatabase,
  remapReferences,
  validateCopy,
} from "@/lib/database-copy";
import type {
  CopyProperty,
  CopyView,
  DatabaseStructure,
  IdFactory,
} from "@/lib/database-copy";

/** Deterministic factory: `new-1`, `new-2`, … in allocation order. */
function seqFactory(start = 1): IdFactory {
  let n = start - 1;
  return () => {
    n += 1;
    return `new-${n}`;
  };
}

/**
 * A small, readable fixture. Allocation order (see `buildIdMap`):
 * prop-status=new-1, opt-todo=new-2, opt-done=new-3, prop-relation=new-4,
 * prop-text=new-5, view-1=new-6, row-1=new-7, row-2=new-8.
 */
function baseDatabase(): DatabaseStructure {
  return {
    properties: [
      {
        id: "prop-status",
        name: "Status",
        type: "select",
        config: null,
        options: [
          { id: "opt-todo", name: "Todo", color: "gray" },
          { id: "opt-done", name: "Done", color: "green" },
        ],
      },
      {
        id: "prop-relation",
        name: "Related",
        type: "relation",
        config: { relationDatabaseId: "db-other" },
      },
      { id: "prop-text", name: "Notes", type: "text", config: null },
    ],
    views: [
      {
        id: "view-1",
        config: {
          visiblePropertyIds: ["prop-status", "prop-relation"],
          groupByPropertyId: "prop-status",
          filters: [{ propertyId: "prop-status", operator: "is", value: "opt-todo" }],
          sorts: [{ propertyId: "prop-text", direction: "asc" }],
        },
      },
    ],
    rows: [
      {
        id: "row-1",
        propertyValues: [
          { propertyId: "prop-status", value: "opt-todo" },
          { propertyId: "prop-relation", value: ["row-2", "row-ext"] },
          { propertyId: "prop-text", value: "hello" },
        ],
      },
      {
        id: "row-2",
        propertyValues: [
          { propertyId: "prop-status", value: ["opt-done"] },
          { propertyId: "prop-relation", value: [] },
        ],
      },
    ],
  };
}

function validCopy(): DatabaseStructure {
  return duplicateDatabase(baseDatabase(), seqFactory());
}

describe("duplicateDatabase", () => {
  it("preserves counts, order and names of properties, views and rows", () => {
    const original = baseDatabase();
    const copy = duplicateDatabase(original, seqFactory());

    expect(copy.properties.map((p) => p.name)).toEqual(["Status", "Related", "Notes"]);
    expect(copy.properties.map((p) => p.type)).toEqual(["select", "relation", "text"]);
    expect(copy.views).toHaveLength(1);
    expect(copy.rows).toHaveLength(2);
    expect(copy.properties[0].options?.map((o) => o.name)).toEqual(["Todo", "Done"]);
  });

  it("gives every entity a fresh id and never reuses an original id", () => {
    const original = baseDatabase();
    const copy = duplicateDatabase(original, seqFactory());

    expect(copy.properties[0].id).toBe("new-1");
    expect(copy.properties[0].options?.map((o) => o.id)).toEqual(["new-2", "new-3"]);
    expect(copy.properties[1].id).toBe("new-4");
    expect(copy.views[0].id).toBe("new-6");
    expect(copy.rows[0].id).toBe("new-7");
    expect(copy.rows[1].id).toBe("new-8");

    const originalIds = new Set([
      ...original.properties.map((p) => p.id),
      ...original.properties.flatMap((p) => p.options?.map((o) => o.id) ?? []),
      ...original.views.map((v) => v.id),
      ...original.rows.map((r) => r.id),
    ]);
    for (const id of originalIds) expect(copy.properties.some((p) => p.id === id)).toBe(false);
  });

  it("remaps option ids in property options and in cell values", () => {
    const copy = duplicateDatabase(baseDatabase(), seqFactory());
    const status = copy.properties[0];

    expect(status.options?.[0].id).toBe("new-2");
    expect(copy.rows[0].propertyValues[0].value).toBe("new-2");
    // multi-select array value remaps element-wise
    expect(copy.rows[1].propertyValues[0].value).toEqual(["new-3"]);
  });

  it("remaps option ids and property ids inside view configs", () => {
    const copy = duplicateDatabase(baseDatabase(), seqFactory());
    const config = copy.views[0].config as {
      visiblePropertyIds: string[];
      groupByPropertyId: string;
      filters: { propertyId: string; value: string }[];
      sorts: { propertyId: string }[];
    };

    expect(config.visiblePropertyIds).toEqual(["new-1", "new-4"]);
    expect(config.groupByPropertyId).toBe("new-1");
    expect(config.filters[0].propertyId).toBe("new-1");
    expect(config.filters[0].value).toBe("new-2");
    expect(config.sorts[0].propertyId).toBe("new-5");
  });

  it("remaps relation targets that point within the set, keeping external ones", () => {
    const copy = duplicateDatabase(baseDatabase(), seqFactory());
    const relation = copy.rows[0].propertyValues.find((v) => v.propertyId === "new-4");

    expect(relation?.value).toEqual(["new-8", "row-ext"]);
  });

  it("leaves relation configs that point at an external database intact", () => {
    const copy = duplicateDatabase(baseDatabase(), seqFactory());
    const config = copy.properties[1].config as { relationDatabaseId: string };

    expect(config.relationDatabaseId).toBe("db-other");
  });

  it("does not mutate the original and returns an independent deep clone", () => {
    const original = baseDatabase();
    const before = JSON.stringify(original);
    const copy = duplicateDatabase(original, seqFactory());

    expect(JSON.stringify(original)).toBe(before);
    copy.properties[0].options![0].name = "Changed";
    (copy.rows[0].propertyValues[0] as { value: unknown }).value = "changed";
    expect(original.properties[0].options![0].name).toBe("Todo");
    expect(original.rows[0].propertyValues[0].value).toBe("opt-todo");
  });

  it("handles option lists stored in property config instead of options", () => {
    const original: DatabaseStructure = {
      properties: [
        {
          id: "p",
          name: "Colour",
          type: "status",
          config: { options: [{ id: "o", name: "Red" }] },
        },
      ],
      views: [],
      rows: [{ id: "r", propertyValues: [{ propertyId: "p", value: "o" }] }],
    };
    const copy = duplicateDatabase(original, seqFactory());

    const option = (copy.properties[0].config as { options: { id: string; name: string }[] })
      .options[0];
    expect(option.name).toBe("Red");
    expect(option.id).not.toBe("o");
    expect(copy.rows[0].propertyValues[0].value).toBe(option.id);
  });

  it("tolerates empty or missing collections", () => {
    const copy = duplicateDatabase({ properties: [], views: [], rows: [] }, seqFactory());
    expect(copy).toEqual({ properties: [], views: [], rows: [] });
  });
});

describe("remapReferences", () => {
  it("remaps matching strings through nested objects and arrays", () => {
    const input = { a: "x", b: ["y", { c: "x" }] };
    const out = remapReferences(input, new Map([["x", "X"], ["y", "Y"]]));
    expect(out).toEqual({ a: "X", b: ["Y", { c: "X" }] });
  });

  it("accepts a plain record as the id map", () => {
    expect(remapReferences("x", { x: "X" })).toBe("X");
    expect(remapReferences(["a", "x"], { x: "X" })).toEqual(["a", "X"]);
  });

  it("leaves non-matching strings and non-string primitives untouched", () => {
    const input = { n: 1, b: true, z: null, s: "keep" };
    expect(remapReferences(input, { x: "X" })).toEqual(input);
  });

  it("deep-clones without mutating its input", () => {
    const input = { a: "x", nested: { b: "x" } };
    const out = remapReferences(input, { x: "X" });
    expect(input).toEqual({ a: "x", nested: { b: "x" } });
    expect(out).toEqual({ a: "X", nested: { b: "X" } });
    expect(out).not.toBe(input);
  });
});

describe("validateCopy", () => {
  it("accepts a copy produced by duplicateDatabase", () => {
    const result = validateCopy(baseDatabase(), validCopy());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags duplicate ids inside the copy", () => {
    const copy = validCopy();
    copy.properties[1].id = copy.properties[0].id;
    const result = validateCopy(baseDatabase(), copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`duplicate id: ${copy.properties[0].id}`);
  });

  it("flags ids reused from the original", () => {
    const copy = validCopy();
    copy.properties[0].id = "prop-status";
    const result = validateCopy(baseDatabase(), copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("id reused from original: prop-status");
  });

  it("flags a stale reference to an original id", () => {
    const copy = validCopy();
    (copy.rows[0].propertyValues[2] as { value: unknown }).value = "prop-text";
    const result = validateCopy(baseDatabase(), copy);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("stale reference to original id:"))).toBe(true);
  });

  it("flags a dangling property reference", () => {
    const copy = validCopy();
    (copy as { views: CopyView[] }).views.push({
      id: "view-2",
      config: { visiblePropertyIds: ["ghost-property"] },
    });
    const result = validateCopy(baseDatabase(), copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("dangling property reference: ghost-property");
  });

  it("flags a relation value pointing at an internal row that is gone", () => {
    const copy = validCopy();
    (copy.rows[0].propertyValues[1] as { value: unknown }).value = ["row-1"];
    const result = validateCopy(baseDatabase(), copy);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("dangling relation reference: row-1");
  });

  it("does not flag external relation targets", () => {
    const result = validateCopy(baseDatabase(), validCopy());
    expect(result.errors).not.toContain("dangling relation reference: row-ext");
  });

  it("keeps extra property fields on the cloned property", () => {
    const copy = validCopy();
    const property: CopyProperty = copy.properties[0];
    expect(property.type).toBe("select");
  });
});

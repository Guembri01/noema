import { describe, expect, it } from "vitest";
import type { RowTemplate } from "@/lib/database-template-engine";
import {
  assertMutable,
  describeTemplate,
  duplicateTemplate,
  instantiateRow,
  reorderTemplates,
  resolveDefaultTemplate,
  setDefaultTemplate,
  validateTemplate,
} from "@/lib/database-template-engine";

/**
 * Unit coverage for the database row-template engine
 * (docs/specs/templates.md §3 model, §6 contracts). Requirement ids are cited
 * per test group: R31.6 (locking), R31.8 (duplication), R31.10 (apply/instantiate),
 * R31.13 (default template), R31.15 (preview/description).
 */

function template(overrides: Partial<RowTemplate> = {}): RowTemplate {
  return {
    id: "tpl-1",
    databaseId: "db-1",
    name: "Weekly report",
    values: { name: "Weekly report", status: "Todo", meta: { pomodoro: true } },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("instantiateRow [R31.10]", () => {
  const now = new Date("2026-03-04T09:00:00.000Z");

  it("copies template values into a new row payload", () => {
    const row = instantiateRow(template(), { now, actorId: "user-1" });
    expect(row.databaseId).toBe("db-1");
    expect(row.templateId).toBe("tpl-1");
    expect(row.values).toEqual({ name: "Weekly report", status: "Todo", meta: { pomodoro: true } });
  });

  it("auto-fills createdAt from now and createdById from the actor", () => {
    const row = instantiateRow(template(), { now, actorId: "user-1" });
    expect(row.createdAt).toBe("2026-03-04T09:00:00.000Z");
    expect(row.createdById).toBe("user-1");
  });

  it("applies explicit overrides over template values (precedence)", () => {
    const row = instantiateRow(template(), {
      now,
      actorId: "user-1",
      overrides: { status: "Done", name: "Overridden" },
    });
    expect(row.values.status).toBe("Done");
    expect(row.values.name).toBe("Overridden");
    expect(row.values.meta).toEqual({ pomodoro: true });
  });

  it("deep-clones nested values so later mutation cannot leak into the template", () => {
    const source = template();
    const row = instantiateRow(source, { now, actorId: "user-1" });
    (row.values.meta as { pomodoro: boolean }).pomodoro = false;
    expect((source.values.meta as { pomodoro: boolean }).pomodoro).toBe(true);
    expect(row.values).not.toBe(source.values);
  });

  it("is deterministic for identical inputs", () => {
    const first = instantiateRow(template(), { now, actorId: "user-1", overrides: { status: "Done" } });
    const second = instantiateRow(template(), { now, actorId: "user-1", overrides: { status: "Done" } });
    expect(first).toEqual(second);
  });

  it("derives only createdAt from a later now, leaving values untouched", () => {
    const later = new Date("2026-04-04T09:00:00.000Z");
    const row = instantiateRow(template(), { now: later, actorId: "user-1" });
    expect(row.createdAt).toBe("2026-04-04T09:00:00.000Z");
    expect(row.values).toEqual(template().values);
  });
});

describe("setDefaultTemplate / resolveDefaultTemplate [R31.13]", () => {
  const a = template({ id: "a", isDefault: true });
  const b = template({ id: "b" });
  const c = template({ id: "c" });

  it("marks the chosen template as default", () => {
    const next = setDefaultTemplate([b, c], "c");
    expect(next.find((t) => t.id === "c")?.isDefault).toBe(true);
  });

  it("clears any previous default (single-default invariant)", () => {
    const next = setDefaultTemplate([a, b, c], "b");
    expect(next.filter((t) => t.isDefault).map((t) => t.id)).toEqual(["b"]);
    expect(next.find((t) => t.id === "a")?.isDefault).toBe(false);
  });

  it("keeps at most one default across repeated calls", () => {
    let list = setDefaultTemplate([a, b, c], "b");
    list = setDefaultTemplate(list, "c");
    expect(list.filter((t) => t.isDefault).length).toBe(1);
    expect(resolveDefaultTemplate(list)?.id).toBe("c");
  });

  it("returns a new array without mutating the input", () => {
    const input = [a, b, c];
    const next = setDefaultTemplate(input, "b");
    // input untouched: `a` keeps its default, `b`/`c` stay unflagged.
    expect(input.map((t) => t.isDefault)).toEqual([true, undefined, undefined]);
    // the returned graph is fresh, with the new default on `b`.
    expect(next).not.toBe(input);
    expect(next.find((t) => t.id === "b")).not.toBe(input.find((t) => t.id === "b"));
    expect(next.find((t) => t.id === "b")?.isDefault).toBe(true);
  });

  it("throws for an unknown template id", () => {
    expect(() => setDefaultTemplate([a, b], "missing")).toThrow(/not found/i);
  });

  it("resolves the default template, or undefined when none is flagged", () => {
    expect(resolveDefaultTemplate([b, c])).toBeUndefined();
    expect(resolveDefaultTemplate([b, template({ id: "d", isDefault: true })])?.id).toBe("d");
  });

  it("returns the first flagged template when several are set", () => {
    expect(resolveDefaultTemplate([b, template({ id: "d", isDefault: true }), a])?.id).toBe("d");
  });
});

describe("duplicateTemplate [R31.8]", () => {
  it("assigns the new id and provided name", () => {
    const copy = duplicateTemplate(template(), { newId: "tpl-2", name: "Quarterly report" });
    expect(copy.id).toBe("tpl-2");
    expect(copy.name).toBe("Quarterly report");
  });

  it("defaults the name to the source name plus 'copy'", () => {
    expect(duplicateTemplate(template(), { newId: "tpl-2" }).name).toBe("Weekly report copy");
  });

  it("clears the default and locked flags", () => {
    const copy = duplicateTemplate(template({ isDefault: true, locked: true }), { newId: "tpl-2" });
    expect(copy.isDefault).toBe(false);
    expect(copy.locked).toBe(false);
  });

  it("deep-copies values independently of the source", () => {
    const source = template();
    const copy = duplicateTemplate(source, { newId: "tpl-2" });
    expect(copy.values).toEqual(source.values);
    expect(copy.values).not.toBe(source.values);
    (copy.values.meta as { pomodoro: boolean }).pomodoro = false;
    expect((source.values.meta as { pomodoro: boolean }).pomodoro).toBe(true);
  });

  it("leaves the source template untouched", () => {
    const source = template();
    duplicateTemplate(source, { newId: "tpl-2", name: "Renamed" });
    expect(source.id).toBe("tpl-1");
    expect(source.name).toBe("Weekly report");
  });
});

describe("validateTemplate [R31.15]", () => {
  const properties = ["name", "status", "meta"];

  it("returns no issues for a valid template", () => {
    expect(validateTemplate(template(), { properties })).toEqual([]);
  });

  it("reports unknown property ids in values", () => {
    const issues = validateTemplate(template({ values: { name: "x", ghost: 1 } }), { properties });
    expect(issues).toContainEqual(expect.objectContaining({ code: "unknown_property", path: "ghost" }));
  });

  it("accepts property objects with ids", () => {
    const issues = validateTemplate(template(), {
      properties: [{ id: "name" }, { id: "status" }, { id: "meta" }],
    });
    expect(issues).toEqual([]);
  });

  it("requires a name", () => {
    const issues = validateTemplate(template({ name: "  " }), { properties });
    expect(issues.some((issue) => issue.code === "name_required")).toBe(true);
  });

  it("requires a databaseId", () => {
    const issues = validateTemplate(template({ databaseId: "" }), { properties });
    expect(issues.some((issue) => issue.code === "database_required")).toBe(true);
  });

  it("flags a locked template as immutable", () => {
    const issues = validateTemplate(template({ locked: true }), { properties });
    expect(issues).toContainEqual(expect.objectContaining({ code: "locked" }));
  });
});

describe("assertMutable [R31.6]", () => {
  it("allows an unlocked template", () => {
    expect(() => assertMutable(template())).not.toThrow();
  });

  it("refuses a locked template with the spec message", () => {
    expect(() => assertMutable(template({ locked: true }))).toThrow("Template is locked.");
  });
});

describe("reorderTemplates [R31.13]", () => {
  const list = [template({ id: "a" }), template({ id: "b" }), template({ id: "c" })];

  it("moves a template to the requested index", () => {
    expect(reorderTemplates(list, "c", 0).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("rewrites positions to match the array order", () => {
    expect(reorderTemplates(list, "a", 2).map((t) => t.position)).toEqual([0, 1, 2]);
  });

  it("clamps an out-of-range index to the end", () => {
    expect(reorderTemplates(list, "a", 99).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("throws for an unknown template id", () => {
    expect(() => reorderTemplates(list, "missing", 0)).toThrow(/not found/i);
  });

  it("does not mutate the input array or its entries", () => {
    const input = [template({ id: "a" }), template({ id: "b" })];
    reorderTemplates(input, "b", 0);
    expect(input.map((t) => t.id)).toEqual(["a", "b"]);
    expect(input[0].position).toBeUndefined();
  });
});

describe("describeTemplate [R31.15]", () => {
  it("returns the plain name when there are no flags", () => {
    expect(describeTemplate(template({ values: {} }))).toBe("Weekly report");
  });

  it("adds the default flag", () => {
    expect(describeTemplate(template({ values: {}, isDefault: true }))).toBe("Weekly report (default)");
  });

  it("adds locked and recurrence flags", () => {
    const described = describeTemplate(template({ values: {}, locked: true, recurrence: "daily" }));
    expect(described).toBe("Weekly report (locked, repeats daily)");
  });

  it("summarizes the value count", () => {
    expect(describeTemplate(template({ values: { name: "x" } }))).toBe("Weekly report (1 field)");
    expect(describeTemplate(template())).toBe("Weekly report (3 fields)");
  });

  it("falls back to an untitled label", () => {
    expect(describeTemplate(template({ name: "", values: {} }))).toBe("Untitled template");
  });
});

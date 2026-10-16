import { describe, expect, it } from "vitest";
import type { DBProperty, DBRow } from "@/components/database/database-types";
import {
  ASANA_CUSTOM_FIELD_TYPE_MAP,
  mapAsanaColor,
  mapAsanaCustomFieldType,
  parseAsanaExport,
  type AsanaImportMeta,
} from "@/lib/import-asana";

/**
 * Canonical Asana project JSON export (objects shaped like the Asana API:
 * `gid` / `resource_type`, task `memberships` carrying the section, and
 * `custom_fields` carrying the typed value).
 */
const asanaExport = {
  gid: "1201",
  resource_type: "project",
  name: "Roadmap",
  sections: [
    { gid: "s1", resource_type: "section", name: "To Do" },
    { gid: "s2", resource_type: "section", name: "Done" },
  ],
  custom_fields: [
    {
      gid: "cf-priority",
      name: "Priority",
      type: "enum",
      enum_options: [
        { gid: "o-high", name: "High", color: "red" },
        { gid: "o-low", name: "Low", color: "green" },
      ],
    },
    { gid: "cf-points", name: "Points", type: "number" },
    {
      gid: "cf-labels2",
      name: "Labels2",
      type: "multi_enum",
      enum_options: [{ gid: "m-a", name: "Alpha" }],
    },
    { gid: "cf-dates", name: "Dates", type: "date" },
    { gid: "cf-owner", name: "Reviewer", type: "people" },
    { gid: "cf-note", name: "Note", type: "text" },
  ],
  tasks: [
    {
      gid: "t1",
      name: "Ship importer",
      notes: "Do the thing",
      completed: false,
      due_on: "2026-03-01",
      assignee: { gid: "u1", name: "Ada Lovelace" },
      memberships: [{ section: { gid: "s1", name: "To Do" } }],
      tags: [{ gid: "tag1", name: "urgent" }],
      permalink_url: "https://app.asana.com/0/1201/t1",
      custom_fields: [
        {
          gid: "cf-priority",
          name: "Priority",
          type: "enum",
          enum_value: { gid: "o-high", name: "High", color: "red" },
        },
        { gid: "cf-points", name: "Points", type: "number", number_value: 5 },
        {
          gid: "cf-labels2",
          name: "Labels2",
          type: "multi_enum",
          multi_enum_values: [{ gid: "m-a", name: "Alpha" }],
        },
        { gid: "cf-dates", name: "Dates", type: "date", date_value: { date: "2026-04-02" } },
        {
          gid: "cf-owner",
          name: "Reviewer",
          type: "people",
          people_value: [{ gid: "u2", name: "Grace Hopper" }],
        },
        { gid: "cf-note", name: "Note", type: "text", text_value: "hello" },
      ],
    },
    {
      gid: "t2",
      name: "Second",
      completed: true,
      due_at: "2026-05-01T09:00:00.000Z",
      assignee: { gid: "u1", name: "Ada Lovelace" },
      memberships: [{ section: { gid: "s2", name: "Done" } }],
      tags: [{ gid: "tag1", name: "urgent" }],
      custom_fields: [
        {
          gid: "cf-priority",
          name: "Priority",
          type: "enum",
          enum_value: { gid: "o-urgent", name: "Urgent", color: "orange" },
        },
      ],
    },
    "not-a-task",
    { gid: "t4" },
  ],
};

function propertyOf(result: { properties: DBProperty[] }, id: string): DBProperty {
  const found = result.properties.find((property) => property.id === id);
  if (!found) throw new Error(`missing property ${id}`);
  return found;
}

function valueOf(row: DBRow, propertyId: string): unknown {
  return row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value;
}

function rowByTitle(result: { rows: DBRow[] }, title: string): DBRow {
  const found = result.rows.find((row) => row.title === title);
  if (!found) throw new Error(`missing row ${title}`);
  return found;
}

describe("mapAsanaCustomFieldType", () => {
  it("maps the primitive Asana custom-field types", () => {
    expect({
      text: mapAsanaCustomFieldType("text"),
      number: mapAsanaCustomFieldType("number"),
      enum: mapAsanaCustomFieldType("enum"),
      multiEnum: mapAsanaCustomFieldType("multi_enum"),
      date: mapAsanaCustomFieldType("date"),
      people: mapAsanaCustomFieldType("people"),
      formula: mapAsanaCustomFieldType("formula"),
    }).toEqual({
      text: "TEXT",
      number: "NUMBER",
      enum: "SELECT",
      multiEnum: "MULTI_SELECT",
      date: "DATE",
      people: "PEOPLE",
      formula: "FORMULA",
    });
  });

  it("normalizes case, padding and the `multi_select` alias", () => {
    expect([
      mapAsanaCustomFieldType("  Enum "),
      mapAsanaCustomFieldType("MULTI_SELECT"),
      mapAsanaCustomFieldType("TEXT"),
    ]).toEqual(["SELECT", "MULTI_SELECT", "TEXT"]);
  });

  it("returns null for types with no Noema equivalent or non-strings", () => {
    expect([
      mapAsanaCustomFieldType("custom_id"),
      mapAsanaCustomFieldType("reference"),
      mapAsanaCustomFieldType("unknown"),
      mapAsanaCustomFieldType(""),
      mapAsanaCustomFieldType("   "),
      mapAsanaCustomFieldType(undefined),
      mapAsanaCustomFieldType(null),
      mapAsanaCustomFieldType(42),
    ]).toEqual([null, null, null, null, null, null, null, null]);
  });

  it("exposes the same vocabulary through ASANA_CUSTOM_FIELD_TYPE_MAP", () => {
    expect(ASANA_CUSTOM_FIELD_TYPE_MAP.enum).toBe("SELECT");
    expect(ASANA_CUSTOM_FIELD_TYPE_MAP.multi_enum).toBe("MULTI_SELECT");
  });
});

describe("mapAsanaColor", () => {
  it("maps shared palette names and strips light/dark prefixes", () => {
    expect([
      mapAsanaColor("red"),
      mapAsanaColor("light-blue"),
      mapAsanaColor("dark-green"),
      mapAsanaColor("brown"),
    ]).toEqual(["red", "blue", "green", "brown"]);
  });

  it("folds Asana aliases onto the palette", () => {
    expect([
      mapAsanaColor("aqua"),
      mapAsanaColor("teal"),
      mapAsanaColor("light-warm-gray"),
    ]).toEqual(["blue", "green", "gray"]);
  });

  it("returns null for unknown and non-string values", () => {
    expect([
      mapAsanaColor("chartreuse"),
      mapAsanaColor(""),
      mapAsanaColor(undefined),
      mapAsanaColor(7),
    ]).toEqual([null, null, null, null]);
  });
});

describe("parseAsanaExport — properties", () => {
  it("derives the column vocabulary in a stable order", () => {
    const result = parseAsanaExport(asanaExport);

    const properties: DBProperty[] = result.properties;
    const rows: DBRow[] = result.rows;
    expect(properties.map((property) => property.id)).toEqual([
      "name",
      "section",
      "cf-priority",
      "cf-points",
      "cf-labels2",
      "cf-dates",
      "cf-owner",
      "cf-note",
      "assignee",
      "due",
      "completed",
      "tags",
      "notes",
      "url",
    ]);
    expect(properties.map((property) => property.type)).toEqual([
      "TEXT",
      "STATUS",
      "SELECT",
      "NUMBER",
      "MULTI_SELECT",
      "DATE",
      "PEOPLE",
      "TEXT",
      "PEOPLE",
      "DATE",
      "CHECKBOX",
      "MULTI_SELECT",
      "TEXT",
      "URL",
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect(propertyOf(result, "name").config?.primary).toBe(true);
  });

  it("turns sections into STATUS options in export order", () => {
    const result = parseAsanaExport(asanaExport);
    expect(propertyOf(result, "section").config?.options).toEqual([
      { id: "s1", name: "To Do", color: "gray" },
      { id: "s2", name: "Done", color: "blue" },
    ]);
  });

  it("merges declared enum options with values encountered on tasks", () => {
    const result = parseAsanaExport(asanaExport);
    // `o-urgent` only appears as a value, so it is appended after the declared options.
    expect(propertyOf(result, "cf-priority").config?.options).toEqual([
      { id: "o-high", name: "High", color: "red" },
      { id: "o-low", name: "Low", color: "green" },
      { id: "o-urgent", name: "Urgent", color: "orange" },
    ]);
  });

  it("keeps the project name in meta and defaults it when absent", () => {
    const meta: AsanaImportMeta = parseAsanaExport(asanaExport).meta;
    expect(meta.projectName).toBe("Roadmap");
    expect(parseAsanaExport({ tasks: [{ gid: "t", name: "X" }] }).meta.projectName).toBe(
      "Asana project",
    );
  });
});

describe("parseAsanaExport — rows", () => {
  it("maps a task's core fields onto cell values", () => {
    const result = parseAsanaExport(asanaExport);
    const row = rowByTitle(result, "Ship importer");

    expect(valueOf(row, "name")).toEqual({ text: "Ship importer" });
    expect(valueOf(row, "section")).toEqual({ optionId: "s1" });
    expect(valueOf(row, "assignee")).toEqual({ names: ["Ada Lovelace"] });
    expect(valueOf(row, "due")).toEqual({ start: "2026-03-01" });
    expect(valueOf(row, "completed")).toEqual({ checked: false });
    expect(valueOf(row, "tags")).toEqual({ optionIds: ["tag1"] });
    expect(valueOf(row, "notes")).toEqual({ text: "Do the thing" });
    expect(valueOf(row, "url")).toEqual({ text: "https://app.asana.com/0/1201/t1" });
    expect(row.id).toBe("t1");
    expect(row.icon).toBeNull();
  });

  it("maps every supported custom-field value shape", () => {
    const result = parseAsanaExport(asanaExport);
    const row = rowByTitle(result, "Ship importer");

    expect(valueOf(row, "cf-priority")).toEqual({ optionId: "o-high" });
    expect(valueOf(row, "cf-points")).toEqual({ number: 5 });
    expect(valueOf(row, "cf-labels2")).toEqual({ optionIds: ["m-a"] });
    expect(valueOf(row, "cf-dates")).toEqual({ start: "2026-04-02" });
    expect(valueOf(row, "cf-owner")).toEqual({ names: ["Grace Hopper"] });
    expect(valueOf(row, "cf-note")).toEqual({ text: "hello" });
  });

  it("reads due_at when due_on is absent and completed true", () => {
    const result = parseAsanaExport(asanaExport);
    const row = rowByTitle(result, "Second");
    expect(valueOf(row, "due")).toEqual({ start: "2026-05-01T09:00:00.000Z" });
    expect(valueOf(row, "completed")).toEqual({ checked: true });
    expect(valueOf(row, "cf-priority")).toEqual({ optionId: "o-urgent" });
  });

  it("falls back to `Untitled task` and only emits the name for sparse tasks", () => {
    const result = parseAsanaExport(asanaExport);
    const row = rowByTitle(result, "Untitled task");
    expect(row.id).toBe("t4");
    expect(row.propertyValues).toEqual([{ propertyId: "name", value: { text: "Untitled task" } }]);
  });

  it("preserves first-seen order for tag options", () => {
    const result = parseAsanaExport(asanaExport);
    expect(propertyOf(result, "tags").config?.options).toEqual([
      { id: "tag1", name: "urgent", color: "gray" },
    ]);
  });
});

describe("parseAsanaExport — tolerance and reporting", () => {
  it("skips malformed tasks and reports the count", () => {
    const result = parseAsanaExport(asanaExport);
    expect(result.rows.map((row) => row.title)).toEqual(["Ship importer", "Second", "Untitled task"]);
    expect(result.meta.skippedMalformedTasks).toBe(1);
    expect(result.meta.tasks).toBe(3);
    expect(result.meta.sections).toBe(2);
    expect(result.meta.customFields).toBe(6);
  });

  it("fails safe on non-Asana input without throwing", () => {
    for (const junk of [null, undefined, "nope", 42, true, {}, { tasks: [] }, { tasks: "nope" }]) {
      const failedSafe = parseAsanaExport(junk);
      expect(failedSafe.properties).toEqual([]);
      expect(failedSafe.rows).toEqual([]);
      expect(failedSafe.meta.tasks).toBe(0);
    }
  });

  it("accepts a bare task array and an Asana `{ data }` envelope", () => {
    const bare = parseAsanaExport([{ gid: "a", name: "Alpha" }]);
    expect(bare.rows.map((row) => row.title)).toEqual(["Alpha"]);
    expect(bare.meta.projectName).toBe("Asana project");

    const enveloped = parseAsanaExport({ data: { name: "Enveloped", tasks: [{ gid: "b", name: "Beta" }] } });
    expect(enveloped.meta.projectName).toBe("Enveloped");
    expect(enveloped.rows.map((row) => row.title)).toEqual(["Beta"]);
  });

  it("infers custom fields that have no definition", () => {
    const result = parseAsanaExport({
      tasks: [
        {
          gid: "t1",
          name: "T",
          custom_fields: [
            { gid: "cf-new", name: "New Field", type: "text", text_value: "x" },
          ],
        },
      ],
    });
    expect(propertyOf(result, "cf-new").type).toBe("TEXT");
    expect(propertyOf(result, "cf-new").name).toBe("New Field");
    expect(valueOf(rowByTitle(result, "T"), "cf-new")).toEqual({ text: "x" });
    expect(result.meta.customFields).toBe(1);
  });

  it("picks up sections referenced by memberships but missing from `sections`", () => {
    const result = parseAsanaExport({
      sections: [{ gid: "s1", name: "To Do" }],
      tasks: [
        {
          gid: "t1",
          name: "T",
          memberships: [{ section: { gid: "s9", name: "Later" } }],
        },
      ],
    });
    expect(propertyOf(result, "section").config?.options).toEqual([
      { id: "s1", name: "To Do", color: "gray" },
      { id: "s9", name: "Later", color: "blue" },
    ]);
    expect(valueOf(rowByTitle(result, "T"), "section")).toEqual({ optionId: "s9" });
  });

  it("reports unmapped custom-field types once, in first-seen order", () => {
    const result = parseAsanaExport({
      tasks: [
        {
          gid: "t1",
          name: "T",
          custom_fields: [
            { gid: "cf-ref", name: "Ref", type: "reference", reference_value: [{ gid: "x", name: "X" }] },
            { gid: "cf-id", name: "ID", type: "custom_id", text_value: "ABC-1" },
            { gid: "cf-ref2", name: "Ref2", type: "reference" },
          ],
        },
      ],
    });
    expect(result.meta.unmappedCustomFieldTypes).toEqual(["reference", "custom_id"]);
    expect(result.properties.map((property) => property.id)).not.toContain("cf-ref");
    expect(result.meta.customFields).toBe(0);
  });

  it("counts custom-field values it cannot represent", () => {
    const result = parseAsanaExport({
      custom_fields: [
        { gid: "cf-num", name: "Num", type: "number" },
        { gid: "cf-enum", name: "Enum", type: "enum" },
      ],
      tasks: [
        {
          gid: "t1",
          name: "T",
          custom_fields: [
            { gid: "cf-num", name: "Num", type: "number", number_value: "not-a-number" },
            { gid: "cf-enum", name: "Enum", type: "enum" },
            "not-a-field",
          ],
        },
      ],
    });
    // `number_value: "not-a-number"` is present but unusable; the malformed entry counts too.
    // The enum entry carries no value at all, so it is not counted.
    expect(result.meta.skippedCustomFieldValues).toBe(2);
    expect(valueOf(rowByTitle(result, "T"), "cf-num")).toBeUndefined();
  });

  it("accepts custom_field_settings definitions and omits formula values", () => {
    const result = parseAsanaExport({
      custom_field_settings: [
        {
          gid: "cfs1",
          custom_field: {
            gid: "cf-formula",
            name: "Score",
            type: "formula",
            enum_options: null,
          },
        },
      ],
      tasks: [{ gid: "t1", name: "T", custom_fields: [{ gid: "cf-formula", name: "Score", type: "formula" }] }],
    });
    expect(propertyOf(result, "cf-formula").type).toBe("FORMULA");
    expect(valueOf(rowByTitle(result, "T"), "cf-formula")).toBeUndefined();
    expect(result.meta.skippedCustomFieldValues).toBe(0);
  });

  it("does not mutate its input", () => {
    const input = structuredClone(asanaExport);
    const before = JSON.stringify(input);
    parseAsanaExport(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

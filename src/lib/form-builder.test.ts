import { describe, expect, it } from "vitest";
import {
  createFormDraft,
  finalizeFormSchema,
  formDraftIssues,
  moveFormField,
  publicQuestionAvailability,
  setFormFieldIncluded,
  setFormFieldLabel,
  setFormFieldRequired,
  updateFormSettings,
  type FormBuilderDefaults,
} from "./form-builder";
import type { FormSchema } from "./form-view";

const properties = [
  { id: "title", name: "Title", type: "TEXT" },
  { id: "status", name: "Status", type: "SELECT" },
  { id: "estimate", name: "Estimate", type: "NUMBER" },
  { id: "total", name: "Total", type: "FORMULA" },
];

const defaults: FormBuilderDefaults = {
  id: "view-1",
  databaseId: "db-1",
  title: "Requests",
};

const editable = (fieldId: string, draft: FormSchema) =>
  draft.fields.find((field) => field.propertyId === fieldId);

describe("createFormDraft", () => {
  it("starts with every answerable property and hides computed types", () => {
    const draft = createFormDraft(properties, null, defaults);
    expect(draft.title).toBe("Requests");
    expect(draft.fields.map((field) => field.propertyId)).toEqual([
      "title",
      "status",
      "estimate",
    ]);
    expect(draft.fields.every((field) => field.hidden === false)).toBe(true);
    expect(draft.accepting).toBe(true);
  });

  it("keeps a legacy field selection visible and marks the rest hidden", () => {
    const draft = createFormDraft(
      properties,
      { fieldIds: ["status"], required: ["status"], submitLabel: "Send" },
      defaults,
    );
    expect(draft.fields.map((field) => field.propertyId)).toEqual([
      "status",
      "title",
      "estimate",
    ]);
    expect(editable("status", draft)?.hidden).toBe(false);
    expect(editable("status", draft)?.required).toBe(true);
    expect(editable("title", draft)?.hidden).toBe(true);
    expect(draft.submitLabel).toBe("Send");
  });

  it("uses a stored schema's order and per-question settings", () => {
    const stored: FormSchema = {
      id: "view-9",
      databaseId: "db-9",
      title: "Vacation",
      description: "Tell us when.",
      fields: [
        { propertyId: "estimate", label: "Days", required: true },
        { propertyId: "status", label: "State", hidden: true },
      ],
      accepting: false,
      submitLabel: "Request",
      successMessage: "Sent!",
    };
    const draft = createFormDraft(properties, stored, defaults);
    expect(draft.id).toBe("view-9");
    expect(draft.databaseId).toBe("db-9");
    expect(draft.title).toBe("Vacation");
    expect(draft.description).toBe("Tell us when.");
    expect(draft.accepting).toBe(false);
    expect(draft.fields.map((field) => field.propertyId)).toEqual([
      "estimate",
      "status",
      "title",
    ]);
    expect(editable("estimate", draft)).toMatchObject({
      label: "Days",
      required: true,
      hidden: false,
    });
    expect(editable("status", draft)).toMatchObject({ label: "State", hidden: true });
    expect(editable("title", draft)?.hidden).toBe(true);
  });

  it("falls back to the view name when no title is stored", () => {
    const draft = createFormDraft(properties, { title: "" }, { ...defaults, title: "" });
    expect(draft.title).toBe("Form");
  });
});

describe("draft mutations", () => {
  const base = createFormDraft(properties, { fieldIds: ["title", "status"] }, defaults);

  it("includes and excludes a question without dropping it", () => {
    const included = setFormFieldIncluded(base, "estimate", true);
    expect(editable("estimate", included)?.hidden).toBe(false);
    const excluded = setFormFieldIncluded(included, "title", false);
    expect(editable("title", excluded)?.hidden).toBe(true);
    expect(editable("title", excluded)?.required).toBe(false);
    expect(excluded.fields).toHaveLength(3);
  });

  it("toggles required and edits the label", () => {
    const required = setFormFieldRequired(base, "title", true);
    expect(editable("title", required)?.required).toBe(true);
    const labelled = setFormFieldLabel(base, "title", "What is it?");
    expect(editable("title", labelled)?.label).toBe("What is it?");
  });

  it("moves a question by one slot and clamps at the ends", () => {
    expect(moveFormField(base, "title", 1).fields.map((field) => field.propertyId)).toEqual([
      "status",
      "title",
      "estimate",
    ]);
    expect(moveFormField(base, "title", -1)).toBe(base);
    expect(moveFormField(base, "estimate", 1)).toBe(base);
  });

  it("updates only the display settings", () => {
    const next = updateFormSettings(base, {
      title: "New",
      description: "Hello",
      submitLabel: "Go",
      successMessage: "Done",
      accepting: false,
    });
    expect(next).toMatchObject({
      title: "New",
      description: "Hello",
      submitLabel: "Go",
      successMessage: "Done",
      accepting: false,
    });
    expect(next.fields).toBe(base.fields);
  });
});

describe("finalizeFormSchema", () => {
  it("trims and bounds metadata, and omits empty optional copy", () => {
    const draft = createFormDraft(properties, {}, defaults);
    const next = finalizeFormSchema({
      ...draft,
      title: `  ${"x".repeat(250)}  `,
      description: "   ",
      submitLabel: "  ",
      successMessage: "  Saved  ",
      fields: [
        { propertyId: "title", label: "  " },
        { propertyId: "title", label: "Duplicate" },
        { propertyId: "status", label: " State ", required: false, hidden: false },
      ],
    });
    expect(next.title).toHaveLength(200);
    expect(next.description).toBeUndefined();
    expect(next.submitLabel).toBeUndefined();
    expect(next.successMessage).toBe("Saved");
    expect(next.fields).toEqual([
      { propertyId: "title", label: "Value" },
      { propertyId: "status", label: "State" },
    ]);
  });
});

describe("publicQuestionAvailability", () => {
  const fields = [
    { propertyId: "title", label: "Title", type: "TEXT" },
    { propertyId: "people", label: "People", type: "PEOPLE" },
    { propertyId: "files", label: "Files", type: "FILES" },
    { propertyId: "note", label: "Note", type: "TEXT", hidden: true },
    { propertyId: "gone", label: "Gone", type: "TEXT" },
  ];
  const props = [
    ...properties,
    { id: "people", name: "People", type: "PEOPLE" },
    { id: "files", name: "Files", type: "FILES" },
  ];

  it("counts visible questions a public link must hide", () => {
    expect(publicQuestionAvailability(fields, props)).toEqual({
      unsupported: 2,
      hasPublic: true,
    });
  });

  it("does not count hidden or stale questions", () => {
    const hiddenOnly = fields.map((field) => ({ ...field, hidden: true }));
    expect(publicQuestionAvailability(hiddenOnly, props)).toEqual({
      unsupported: 0,
      hasPublic: false,
    });
  });

  it("reports no usable question when only pickers remain", () => {
    expect(
      publicQuestionAvailability(
        [
          { propertyId: "people", label: "People", type: "PEOPLE" },
          { propertyId: "files", label: "Files", type: "FILES" },
        ],
        props,
      ),
    ).toEqual({ unsupported: 2, hasPublic: false });
  });
});

describe("formDraftIssues", () => {
  it("accepts a normal draft", () => {
    expect(formDraftIssues(createFormDraft(properties, {}, defaults), properties)).toEqual([]);
  });

  it("reports an empty title, hidden-only form and hidden required field", () => {
    const draft = createFormDraft(properties, {}, defaults);
    expect(
      formDraftIssues({ ...draft, title: "  " }, properties),
    ).toContain("Form title is required.");
    expect(
      formDraftIssues(
        {
          ...draft,
          fields: draft.fields.map((field) => ({ ...field, hidden: true })),
        },
        properties,
      ),
    ).toContain("A form must show at least one question.");
    expect(
      formDraftIssues(
        {
          ...draft,
          fields: draft.fields.map((field) => ({
            ...field,
            hidden: field.propertyId === "title",
            required: field.propertyId === "title",
          })),
        },
        properties,
      ),
    ).toContain("Required property cannot be hidden: title");
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBMIT_LABEL,
  answersToPropertyValues,
  buildFormSchema,
  resolveFormMeta,
  validateSubmission,
  type FormField,
} from "@/lib/form-view";

/* Fixtures mirror the property shape the database views store: a generic
   `{ id, name, type, required?, config? }` record. Computed/system types
   (CREATED_TIME, FORMULA, BUTTON, …) cannot be answered on a form, so the
   default schema must skip them. */

type TestProperty = {
  id: string;
  name: string;
  type: string;
  required?: boolean;
  config?: Record<string, unknown>;
};

const title: TestProperty = {
  id: "title",
  name: "Title",
  type: "TEXT",
  required: true,
  config: { primary: true },
};
const status: TestProperty = {
  id: "status",
  name: "Status",
  type: "SELECT",
  required: true,
  config: { options: [{ id: "todo" }, { id: "done" }] },
};
const tags: TestProperty = {
  id: "tags",
  name: "Tags",
  type: "MULTI_SELECT",
  config: { options: [{ id: "web" }, { id: "api" }] },
};
const estimate: TestProperty = {
  id: "estimate",
  name: "Estimate",
  type: "NUMBER",
  config: { min: 0, max: 100 },
};
const created: TestProperty = { id: "created", name: "Created", type: "CREATED_TIME" };
const formula: TestProperty = {
  id: "formula",
  name: "Calc",
  type: "FORMULA",
  config: { expression: "1 + 1" },
};
const button: TestProperty = { id: "button", name: "Go", type: "BUTTON" };

const props: TestProperty[] = [title, status, tags, estimate, created, formula, button];

const ids = (fields: FormField[]): string[] => fields.map((field) => field.propertyId);
const byId = (fields: FormField[], id: string): FormField =>
  fields.find((field) => field.propertyId === id) as FormField;

describe("buildFormSchema — selection and order", () => {
  it("defaults to every non-computed property in schema order", () => {
    expect(ids(buildFormSchema(props, {}))).toEqual(["title", "status", "tags", "estimate"]);
    expect(ids(buildFormSchema(props, null))).toEqual(["title", "status", "tags", "estimate"]);
  });

  it("carries labels, types, the primary flag and the property's own required flag", () => {
    const fields = buildFormSchema(props, {});
    expect(byId(fields, "title").label).toBe("Title");
    expect(byId(fields, "title").type).toBe("TEXT");
    expect(byId(fields, "title").required).toBe(true);
    expect(byId(fields, "title").primary).toBe(true);
    expect(byId(fields, "tags").required).toBe(false);
  });

  it("selects and orders fields from a non-empty fieldIds list", () => {
    expect(ids(buildFormSchema(props, { fieldIds: ["estimate", "title"] }))).toEqual([
      "estimate",
      "title",
    ]);
    expect(
      ids(buildFormSchema(props, { fieldIds: ["title", "ghost", "created", "title"] })),
    ).toEqual(["title"]);
  });

  it("applies order as a priority, appending the remaining selection", () => {
    expect(
      ids(
        buildFormSchema(props, {
          fieldIds: ["title", "status", "tags", "estimate"],
          order: ["tags", "status"],
        }),
      ),
    ).toEqual(["tags", "status", "title", "estimate"]);
  });

  it("tolerates junk properties and configs", () => {
    expect(buildFormSchema(null, null)).toEqual([]);
    expect(buildFormSchema([null, 42, {}, title], {})).toHaveLength(1);
  });
});

describe("buildFormSchema — required toggles", () => {
  it("force-requires optional properties listed in a required array", () => {
    const fields = buildFormSchema(props, { required: ["tags"] });
    expect(byId(fields, "tags").required).toBe(true);
    expect(byId(fields, "estimate").required).toBe(false);
  });

  it("toggles required on and off via a required record", () => {
    const fields = buildFormSchema(props, { required: { status: false, estimate: true } });
    expect(byId(fields, "status").required).toBe(false);
    expect(byId(fields, "estimate").required).toBe(true);
  });
});

describe("resolveFormMeta", () => {
  it("defaults the description and submit label", () => {
    expect(resolveFormMeta({})).toEqual({
      description: "",
      submitLabel: DEFAULT_SUBMIT_LABEL,
    });
  });

  it("reads configured description and submit label", () => {
    expect(resolveFormMeta({ description: "Tell us", submitLabel: "Send" })).toEqual({
      description: "Tell us",
      submitLabel: "Send",
    });
    expect(resolveFormMeta({ submitLabel: "   " }).submitLabel).toBe(DEFAULT_SUBMIT_LABEL);
  });
});

describe("validateSubmission", () => {
  const fields = buildFormSchema(props, {});

  it("accepts a complete, well-typed submission", () => {
    expect(
      validateSubmission(fields, {
        title: { text: "Hello" },
        status: { optionId: "todo" },
        tags: { optionIds: ["web"] },
        estimate: { number: 5 },
      }),
    ).toEqual({ ok: true });
  });

  it("reports missing required answers with REQUIRED and the field label", () => {
    const result = validateSubmission(fields, { title: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.propertyId)).toEqual(["title", "status"]);
      expect(result.issues[0].errors[0].code).toBe("REQUIRED");
      expect(result.issues[0].label).toBe("Title");
    }
  });

  it("applies the property's type constraints to present values", () => {
    const result = validateSubmission(fields, {
      title: { text: "Hi" },
      status: { optionId: "todo" },
      estimate: { number: 999 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].propertyId).toBe("estimate");
      expect(result.issues[0].errors[0].code).toBe("MAX");
    }
  });

  it("treats relaxed required toggles as valid when blank", () => {
    const relaxed = buildFormSchema(props, { required: { title: false, status: false } });
    expect(validateSubmission(relaxed, {})).toEqual({ ok: true });
  });

  it("accepts array-shaped answers and an empty schema", () => {
    expect(
      validateSubmission(fields, [
        { propertyId: "title", value: { text: "Hi" } },
        { propertyId: "status", value: { optionId: "todo" } },
      ]),
    ).toEqual({ ok: true });
    expect(validateSubmission([], {})).toEqual({ ok: true });
    expect(validateSubmission(null, null)).toEqual({ ok: true });
  });
});

describe("answersToPropertyValues", () => {
  const fields = buildFormSchema(props, {});

  it("maps answers to stored { propertyId, value } cells in field order", () => {
    expect(
      answersToPropertyValues(fields, { status: { optionId: "done" }, title: { text: "Hi" } }),
    ).toEqual([
      { propertyId: "title", value: { text: "Hi" } },
      { propertyId: "status", value: { optionId: "done" } },
    ]);
  });

  it("omits unanswered fields and ignores unknown answer keys", () => {
    expect(answersToPropertyValues(fields, { title: { text: "Hi" }, ghost: "nope" })).toEqual([
      { propertyId: "title", value: { text: "Hi" } },
    ]);
  });

  it("passes through raw values, including an empty string and zero", () => {
    expect(answersToPropertyValues(fields, { estimate: 0 })).toEqual([
      { propertyId: "estimate", value: 0 },
    ]);
    expect(answersToPropertyValues(fields, { title: "" })).toEqual([
      { propertyId: "title", value: "" },
    ]);
  });

  it("accepts array-shaped answers and empty schemas", () => {
    expect(
      answersToPropertyValues(fields, [
        { propertyId: "tags", value: { optionIds: ["api"] } },
      ]),
    ).toEqual([{ propertyId: "tags", value: { optionIds: ["api"] } }]);
    expect(answersToPropertyValues([], { title: "x" })).toEqual([]);
  });
});

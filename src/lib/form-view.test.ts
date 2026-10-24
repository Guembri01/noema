import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBMIT_LABEL,
  DEFAULT_SUCCESS_MESSAGE,
  FORM_TITLE_MAX_LENGTH,
  answersToPropertyValues,
  buildFormSchema,
  defaultAnswers,
  describeForm,
  fieldOrder,
  isPublicFormType,
  parseFormSchema,
  publicFormFields,
  resolveFormMeta,
  toRowValues,
  toggleAccepting,
  validateFormSchema,
  validateSubmission,
  type FormField,
  type FormSchema,
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

describe("public form fields", () => {
  it("keeps scalar questions that need no session", () => {
    for (const type of [
      "TEXT",
      "NUMBER",
      "SELECT",
      "MULTI_SELECT",
      "STATUS",
      "DATE",
      "CHECKBOX",
      "URL",
      "EMAIL",
      "PHONE",
      "PLACE",
    ]) {
      expect(isPublicFormType(type)).toBe(true);
    }
  });

  it("drops pickers, uploads and computed types", () => {
    for (const type of [
      "PEOPLE",
      "FILES",
      "VERIFICATION",
      "RELATION",
      "FORMULA",
      "UNIQUE_ID",
      "BUTTON",
    ]) {
      expect(isPublicFormType(type)).toBe(false);
    }
  });

  it("filters the field list without mutating the stored order", () => {
    const fields: FormField[] = [
      { propertyId: "title", label: "Title", type: "TEXT" },
      { propertyId: "people", label: "People", type: "PEOPLE" },
      { propertyId: "files", label: "Files", type: "FILES" },
      { propertyId: "status", label: "Status", type: "STATUS" },
    ];

    expect(publicFormFields(fields).map((field) => field.propertyId)).toEqual([
      "title",
      "status",
    ]);
    expect(fields.map((field) => field.propertyId)).toEqual([
      "title",
      "people",
      "files",
      "status",
    ]);
  });
});

describe("buildFormSchema - selection and order", () => {
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

/* ---------------------------------------------------------------------------
   Parsed form schema engine (R89.29): parse → lint → validate → map
   --------------------------------------------------------------------------- */

/** Build a single-question stored schema; `overrides` tweak the form settings. */
function one(field: FormField, overrides: Partial<FormSchema> = {}): FormSchema {
  return {
    id: "form-1",
    databaseId: "db-1",
    title: "Form",
    accepting: true,
    fields: [field],
    ...overrides,
  };
}

describe("parseFormSchema [R89.29]", () => {
  it("returns an empty, accepting schema for junk input", () => {
    const empty = { id: "", databaseId: "", title: "", fields: [], accepting: true };
    expect(parseFormSchema(null)).toEqual(empty);
    expect(parseFormSchema(42)).toEqual(empty);
    expect(parseFormSchema("nope")).toEqual(empty);
    expect(parseFormSchema([])).toEqual(empty);
  });

  it("reads the scalar settings", () => {
    const schema = parseFormSchema({
      id: "form-1",
      databaseId: "db-1",
      title: "Contact us",
      description: "Say hi",
      submitLabel: "Send",
      successMessage: "Thanks!",
    });
    expect(schema).toMatchObject({
      id: "form-1",
      databaseId: "db-1",
      title: "Contact us",
      description: "Say hi",
      submitLabel: "Send",
      successMessage: "Thanks!",
      accepting: true,
    });
  });

  it("honours accepting:false and coerces anything else to accepting", () => {
    expect(parseFormSchema({ accepting: false }).accepting).toBe(false);
    expect(parseFormSchema({ accepting: "no" }).accepting).toBe(true);
  });

  it("normalizes fields, dropping malformed entries and empty property ids", () => {
    const schema = parseFormSchema({
      fields: [
        { propertyId: "a", label: "A" },
        null,
        42,
        { label: "no id" },
        { propertyId: "", label: "empty" },
        { propertyId: "b" },
      ],
    });
    expect(schema.fields.map((field) => field.propertyId)).toEqual(["a", "b"]);
    expect(schema.fields[1].label).toBe("Value");
  });

  it("preserves field flags and resolved property metadata", () => {
    const [field] = parseFormSchema({
      fields: [
        {
          propertyId: "a",
          label: "A",
          required: true,
          help: "Help",
          hidden: true,
          default: { text: "hi" },
          type: "TEXT",
          primary: true,
          config: { maxLength: 5 },
        },
      ],
    }).fields;
    expect(field).toMatchObject({
      propertyId: "a",
      label: "A",
      required: true,
      help: "Help",
      hidden: true,
      type: "TEXT",
      primary: true,
      config: { maxLength: 5 },
    });
    expect(field.default).toEqual({ text: "hi" });
  });

  it("is idempotent", () => {
    const raw = {
      id: "f",
      databaseId: "d",
      title: "T",
      accepting: false,
      fields: [{ propertyId: "a", label: "A", default: ["x"] }],
    };
    const once = parseFormSchema(raw);
    expect(parseFormSchema(once)).toEqual(once);
  });

  it("keeps duplicate field ids so schema validation can report them", () => {
    const schema = parseFormSchema({
      fields: [
        { propertyId: "a", label: "A" },
        { propertyId: "a", label: "A2" },
      ],
    });
    expect(schema.fields).toHaveLength(2);
  });
});

describe("validateFormSchema [R89.29]", () => {
  it("accepts a publishable schema", () => {
    expect(
      validateFormSchema(one({ propertyId: "title", label: "Title" }), {
        properties: ["title"],
      }),
    ).toEqual({ ok: true });
  });

  it("requires a non-empty title", () => {
    const result = validateFormSchema(
      one({ propertyId: "title", label: "Title" }, { title: "   " }),
      { properties: ["title"] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("TITLE_LENGTH");
  });

  it("rejects an over-long title but accepts the maximum length", () => {
    const long = validateFormSchema(
      one({ propertyId: "title", label: "Title" }, { title: "x".repeat(FORM_TITLE_MAX_LENGTH + 1) }),
      { properties: ["title"] },
    );
    expect(long.ok).toBe(false);
    const max = validateFormSchema(
      one({ propertyId: "title", label: "Title" }, { title: "x".repeat(FORM_TITLE_MAX_LENGTH) }),
      { properties: ["title"] },
    );
    expect(max.ok).toBe(true);
  });

  it("flags questions pointing at unknown properties", () => {
    const result = validateFormSchema(one({ propertyId: "ghost", label: "Ghost" }), {
      properties: ["title"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { code: "UNKNOWN_PROPERTY", propertyId: "ghost", message: "Unknown property: ghost" },
      ]);
    }
  });

  it("flags a property asked twice", () => {
    const schema: FormSchema = {
      ...one({ propertyId: "title", label: "T" }),
      fields: [
        { propertyId: "title", label: "T" },
        { propertyId: "title", label: "Again" },
      ],
    };
    const result = validateFormSchema(schema, { properties: ["title"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "DUPLICATE_PROPERTY")).toBe(true);
    }
  });

  it("flags a required-but-hidden question", () => {
    const schema: FormSchema = {
      ...one({ propertyId: "title", label: "Title", required: true, hidden: true }),
      fields: [
        { propertyId: "title", label: "Title", required: true, hidden: true },
        { propertyId: "name", label: "Name" },
      ],
    };
    const result = validateFormSchema(schema, { properties: ["title", "name"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          code: "REQUIRED_HIDDEN",
          propertyId: "title",
          message: "Required property cannot be hidden: title",
        },
      ]);
    }
  });

  it("flags a form with no visible questions", () => {
    const hidden = validateFormSchema(
      one({ propertyId: "title", label: "T", hidden: true }),
      { properties: ["title"] },
    );
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.errors.some((e) => e.code === "NO_VISIBLE_FIELDS")).toBe(true);

    const empty = validateFormSchema(
      one({ propertyId: "title", label: "T" }, { fields: [] }),
      { properties: ["title"] },
    );
    expect(empty.ok).toBe(false);
  });

  it("accepts string and {id} property refs", () => {
    const schema: FormSchema = {
      ...one({ propertyId: "title", label: "T" }),
      fields: [
        { propertyId: "title", label: "T" },
        { propertyId: "status", label: "S" },
      ],
    };
    expect(
      validateFormSchema(schema, { properties: ["title", { id: "status" }, { id: "estimate" }] }),
    ).toEqual({ ok: true });
  });
});

describe("validateSubmission — parsed schema [R89.29]", () => {
  it("accepts a complete, well-typed submission", () => {
    const schema: FormSchema = {
      id: "f",
      databaseId: "db",
      title: "T",
      accepting: true,
      fields: [
        { propertyId: "title", label: "Title", required: true, type: "TEXT" },
        { propertyId: "estimate", label: "Estimate", type: "NUMBER", config: { min: 0, max: 100 } },
        { propertyId: "status", label: "Status", type: "SELECT", config: { options: [{ id: "todo" }] } },
      ],
    };
    expect(
      validateSubmission(schema, {
        title: { text: "Hello" },
        estimate: { number: 5 },
        status: { optionId: "todo" },
      }),
    ).toEqual({ ok: true });
  });

  it("reports missing required answers with the REQUIRED code", () => {
    const result = validateSubmission(
      one({ propertyId: "title", label: "Title", required: true, type: "TEXT" }),
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ propertyId: "title", code: "REQUIRED" }]);
      expect(result.issues[0].label).toBe("Title");
    }
  });

  it("never requires a hidden question", () => {
    expect(
      validateSubmission(
        one({ propertyId: "title", label: "Title", required: true, hidden: true }),
        {},
      ),
    ).toEqual({ ok: true });
  });

  it("enforces NUMBER bounds", () => {
    const result = validateSubmission(
      one({
        propertyId: "estimate",
        label: "Estimate",
        type: "NUMBER",
        config: { min: 0, max: 100 },
      }),
      { estimate: { number: 999 } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toEqual({ propertyId: "estimate", code: "MAX" });
  });

  it("enforces TEXT pattern and length constraints", () => {
    const pattern = validateSubmission(
      one({ propertyId: "code", label: "Code", type: "TEXT", config: { pattern: "^\\d+$" } }),
      { code: { text: "abc" } },
    );
    expect(pattern.ok).toBe(false);
    if (!pattern.ok) expect(pattern.errors[0].code).toBe("PATTERN");

    const length = validateSubmission(
      one({ propertyId: "name", label: "Name", type: "TEXT", config: { maxLength: 3 } }),
      { name: { text: "abcd" } },
    );
    expect(length.ok).toBe(false);
    if (!length.ok) expect(length.errors[0].code).toBe("MAX_LENGTH");
  });

  it("enforces SELECT and MULTI_SELECT options", () => {
    const single = validateSubmission(
      one({
        propertyId: "status",
        label: "Status",
        type: "SELECT",
        config: { options: [{ id: "todo" }] },
      }),
      { status: { optionId: "nope" } },
    );
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.errors[0].code).toBe("SELECT_OPTION");

    const multi = validateSubmission(
      one({
        propertyId: "tags",
        label: "Tags",
        type: "MULTI_SELECT",
        config: { options: [{ id: "web" }] },
      }),
      { tags: { optionIds: ["web", "api"] } },
    );
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.errors[0].code).toBe("SELECT_OPTION");
  });

  it("enforces DATE ranges", () => {
    const result = validateSubmission(
      one({ propertyId: "when", label: "When", type: "DATE" }),
      { when: { start: "2026-02-01", end: "2026-01-01" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("DATE_RANGE");
  });

  it("treats an unchecked box as a present answer", () => {
    expect(
      validateSubmission(
        one({ propertyId: "done", label: "Done", type: "CHECKBOX", required: true }),
        { done: { checked: false } },
      ),
    ).toEqual({ ok: true });
  });

  it("ignores answer keys not present in the schema", () => {
    expect(
      validateSubmission(one({ propertyId: "title", label: "Title" }), { ghost: "nope" }),
    ).toEqual({ ok: true });
  });

  it("accepts array-shaped answers and an empty schema", () => {
    expect(
      validateSubmission(one({ propertyId: "title", label: "Title", required: true }), [
        { propertyId: "title", value: { text: "Hi" } },
      ]),
    ).toEqual({ ok: true });
    expect(validateSubmission(one({ propertyId: "title", label: "T" }, { fields: [] }), {})).toEqual(
      { ok: true },
    );
  });
});

describe("defaultAnswers [R89.29]", () => {
  it("pre-fills every visible field that declares a default", () => {
    const schema: FormSchema = {
      ...one({ propertyId: "status", label: "Status", default: "todo" }),
      fields: [
        { propertyId: "status", label: "Status", default: "todo" },
        { propertyId: "title", label: "Title" },
      ],
    };
    expect(defaultAnswers(schema)).toEqual({ status: "todo" });
  });

  it("skips fields without a default and hidden fields", () => {
    const schema: FormSchema = {
      ...one({ propertyId: "a", label: "A" }),
      fields: [
        { propertyId: "a", label: "A" },
        { propertyId: "b", label: "B", hidden: true, default: 1 },
      ],
    };
    expect(defaultAnswers(schema)).toEqual({});
  });

  it("deep-clones container defaults so the schema is never mutated", () => {
    const schema = one({ propertyId: "tags", label: "Tags", default: ["web"] });
    const first = defaultAnswers(schema);
    expect(first).toEqual({ tags: ["web"] });
    (first.tags as string[]).push("api");
    expect(defaultAnswers(schema)).toEqual({ tags: ["web"] });
  });
});

describe("toRowValues [R89.29]", () => {
  it("maps answers to { propertyId, value } cells in field order", () => {
    const schema: FormSchema = {
      ...one({ propertyId: "title", label: "Title" }),
      fields: [
        { propertyId: "title", label: "Title" },
        { propertyId: "estimate", label: "Estimate", type: "NUMBER" },
      ],
    };
    expect(
      toRowValues(schema, { estimate: { number: 3 }, title: { text: "Hi" } }),
    ).toEqual([
      { propertyId: "title", value: { text: "Hi" } },
      { propertyId: "estimate", value: { number: 3 } },
    ]);
  });

  it("falls back to a field default when the answer is absent", () => {
    const schema = one({ propertyId: "status", label: "Status", default: "todo" });
    expect(toRowValues(schema, {})).toEqual([{ propertyId: "status", value: "todo" }]);
  });

  it("skips unanswered fields without defaults and ignores unknown keys", () => {
    const schema: FormSchema = {
      ...one({ propertyId: "title", label: "Title" }),
      fields: [
        { propertyId: "title", label: "Title" },
        { propertyId: "notes", label: "Notes" },
      ],
    };
    expect(toRowValues(schema, { title: { text: "Hi" }, ghost: "x" })).toEqual([
      { propertyId: "title", value: { text: "Hi" } },
    ]);
  });

  it("never writes a hidden field", () => {
    const schema = one({ propertyId: "secret", label: "Secret", hidden: true, default: 1 });
    expect(toRowValues(schema, { secret: 2 })).toEqual([]);
  });
});

describe("describeForm [R89.29]", () => {
  it("fills in default copy, accept state and question count", () => {
    const schema: FormSchema = {
      ...one({ propertyId: "title", label: "Title" }),
      fields: [
        { propertyId: "title", label: "Title" },
        { propertyId: "hidden", label: "H", hidden: true },
      ],
    };
    expect(describeForm(schema)).toEqual({
      title: "Form",
      description: "",
      submitLabel: DEFAULT_SUBMIT_LABEL,
      successMessage: DEFAULT_SUCCESS_MESSAGE,
      accepting: true,
      questionCount: 1,
    });
  });

  it("reads configured copy and trims the submit label", () => {
    const schema = one(
      { propertyId: "title", label: "Title" },
      {
        title: "Contact us",
        description: "Say hi",
        submitLabel: "  Send  ",
        successMessage: "Thanks!",
        accepting: false,
      },
    );
    expect(describeForm(schema)).toEqual({
      title: "Contact us",
      description: "Say hi",
      submitLabel: "Send",
      successMessage: "Thanks!",
      accepting: false,
      questionCount: 1,
    });
  });

  it("falls back when a configured label is blank", () => {
    const schema = one(
      { propertyId: "title", label: "Title" },
      { submitLabel: "   ", successMessage: "  " },
    );
    const description = describeForm(schema);
    expect(description.submitLabel).toBe(DEFAULT_SUBMIT_LABEL);
    expect(description.successMessage).toBe(DEFAULT_SUCCESS_MESSAGE);
  });
});

describe("toggleAccepting [R89.29]", () => {
  it("sets the accept switch in both directions", () => {
    const open = one({ propertyId: "title", label: "Title" });
    const closed = toggleAccepting(open, false);
    expect(closed.accepting).toBe(false);
    expect(toggleAccepting(closed, true).accepting).toBe(true);
  });

  it("returns a new object and never mutates the input", () => {
    const open = one({ propertyId: "title", label: "Title" });
    const closed = toggleAccepting(open, false);
    expect(closed).not.toBe(open);
    expect(open.accepting).toBe(true);
    expect(closed.fields).toBe(open.fields);
  });
});

describe("fieldOrder [R89.29]", () => {
  const ordered: FormSchema = {
    ...one({ propertyId: "a", label: "A" }),
    fields: [
      { propertyId: "a", label: "A" },
      { propertyId: "b", label: "B" },
      { propertyId: "c", label: "C" },
    ],
  };

  it("returns a copy in stored order when no order is given", () => {
    const result = fieldOrder(ordered);
    expect(result.map((field) => field.propertyId)).toEqual(["a", "b", "c"]);
    expect(result).not.toBe(ordered.fields);
  });

  it("moves the listed ids to the front, keeping the rest stable", () => {
    expect(fieldOrder(ordered, ["c", "a"]).map((field) => field.propertyId)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("ignores unknown and duplicate ids in the order", () => {
    expect(fieldOrder(ordered, ["b", "ghost", "b"]).map((field) => field.propertyId)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

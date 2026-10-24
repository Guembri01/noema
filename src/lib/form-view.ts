/**
 * Form view: question resolution + submission validation + value mapping
 * (docs/MISSING_FEATURES.md §3 row "Form view"; spec R89.29).
 *
 * A form is a database view whose `config.form` lists which properties become
 * questions and in what order. This module is the pure model behind both the
 * builder and the respondent form:
 *
 * - `buildFormSchema` turns database properties + a form config
 *   (`{ fieldIds, required, order, description, submitLabel }`) into an ordered
 *   list of answerable fields, skipping computed/system types and tolerating
 *   stale ids.
 * - `validateSubmission` checks a set of answers against those fields using the
 *   exact same rules a cell write uses (it calls `validateCell` read-only), so
 *   the form can never accept a value the rest of the app would reject.
 * - `answersToPropertyValues` maps raw answers to the `{ propertyId, value }`
 *   cells the app stores, ignoring unknown fields.
 *
 * No DB, no routes, no React: a server action can re-validate a submission with
 * the same functions the client used, and the row builder can consume the
 * mapped cells directly. Stored config and properties round-trip as untrusted
 * JSON, so everything is checked at runtime and nothing throws.
 */

import { validateCell, type CellError, type CellErrorCode } from "@/lib/cell-validation";

/**
 * Property types that are derived or system-managed and therefore cannot be
 * answered on a form: formulas, relations, rollups, audit timestamps/actors,
 * generated ids and buttons. They are skipped from the default question list.
 */
const COMPUTED_PROPERTY_TYPES: ReadonlySet<string> = new Set([
  "FORMULA",
  "RELATION",
  "ROLLUP",
  "CREATED_TIME",
  "CREATED_BY",
  "LAST_EDITED_TIME",
  "LAST_EDITED_BY",
  "UNIQUE_ID",
  "BUTTON",
  "AI_AUTOFILL",
]);

/**
 * Whether a property can be a form question. The server re-checks this on
 * submission so a hand-crafted `config.form` cannot write a computed cell
 * (formula, rollup, generated id, audit timestamp/actor, button or AI output).
 */
export function isAnswerablePropertyType(type: unknown): boolean {
  return typeof type === "string" && !COMPUTED_PROPERTY_TYPES.has(type);
}

/**
 * Types an anonymous respondent cannot answer: the picker/editor needs a
 * signed-in session (workspace members, the authenticated upload API, the
 * verification actor) or would leak directory data to the public link. A public
 * form drops these questions; internal forms keep them.
 */
const PUBLIC_FORM_UNSAFE_TYPES: ReadonlySet<string> = new Set([
  "PEOPLE",
  "FILES",
  "VERIFICATION",
]);

/** Whether a property type can be answered through a public form link. */
export function isPublicFormType(type: unknown): boolean {
  return isAnswerablePropertyType(type) && !PUBLIC_FORM_UNSAFE_TYPES.has(type as string);
}

/**
 * Drop questions a public respondent cannot answer. `resolveFormPlan` and
 * `submitPublicFormAction` both call this so the rendered fields and the fields
 * the server accepts always agree.
 */
export function publicFormFields(
  fields: readonly FormField[],
): FormField[] {
  return fields.filter((field) => isPublicFormType(field.type));
}

/** Default submit button label when the config does not provide one. */
export const DEFAULT_SUBMIT_LABEL = "Submit";

/** Stored form configuration; every value is untrusted JSON. */
export type FormConfig = {
  /** Property ids to show, in order. Empty/absent means every non-computed property. */
  fieldIds?: string[];
  /** Required overrides: an id list (force required) or an id → boolean toggle map. */
  required?: string[] | Record<string, boolean>;
  /** Display-order override; listed ids lead, the rest keep their current order. */
  order?: string[];
  /** Intro copy rendered above the questions. */
  description?: string;
  /** Submit button label. */
  submitLabel?: string;
};

/**
 * One form question.
 *
 * The parsed-schema fields (R89.29) only require `propertyId` and `label` and
 * carry the builder knobs (`required`/`help`/`hidden`/`default`). The resolved
 * builder/renderer path additionally fills the property metadata (`type`,
 * `primary`, `config`) so the same object can drive the live cell editors;
 * those extras stay optional so a hand-parsed schema is still a valid field.
 */
export type FormField = {
  propertyId: string;
  label: string;
  /** Whether the respondent must answer. Defaults to the property's own flag. */
  required?: boolean;
  /** Optional helper text shown under the question. */
  help?: string;
  /** Hidden questions are excluded from the respondent form (and its order). */
  hidden?: boolean;
  /** Pre-filled answer for a fresh respondent, in the property's stored shape. */
  default?: unknown;
  /** Resolved property type (`TEXT`, `NUMBER`, …) used by the cell editors. */
  type?: string;
  /** Resolved primary-property flag. */
  primary?: boolean;
  /** Resolved property config the editors read (`min`/`max`/`options`/…). */
  config?: Record<string, unknown>;
};

/** One failing field of a submission. */
export type FormIssue = {
  propertyId: string;
  label: string;
  errors: CellError[];
};

/** `ok: true` when every answered field passes; otherwise the failing fields. */
export type FormValidation =
  | { ok: true }
  | { ok: false; issues: FormIssue[] };

/** The display-only metadata of a form. */
export type FormMeta = {
  description: string;
  submitLabel: string;
};

/** What this module reads from a property; every field is untrusted. */
type FormProperty = {
  id: string;
  name: string;
  type: string;
  required: boolean;
  primary: boolean;
  config: Record<string, unknown>;
};

/** Coerce an untrusted property, returning `null` for anything not an object. */
function asProperty(input: unknown): FormProperty | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const name = raw.name;
  const type = raw.type;
  const config = raw.config;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof name === "string" && name.trim() !== "" ? name : "Value",
    type: typeof type === "string" ? type : "",
    required: raw.required === true,
    primary:
      !!config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      (config as Record<string, unknown>).primary === true,
    config:
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {},
  };
}

/** Read a form config, defaulting every key when the input is not an object. */
function asConfig(input: unknown): Record<keyof FormConfig, unknown> {
  const empty = {
    fieldIds: undefined,
    required: undefined,
    order: undefined,
    description: undefined,
    submitLabel: undefined,
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) return empty;
  const raw = input as Record<string, unknown>;
  return {
    fieldIds: raw.fieldIds,
    required: raw.required,
    order: raw.order,
    description: raw.description,
    submitLabel: raw.submitLabel,
  };
}

/** Keep only the string entries of a value that should be a string array. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Stable reorder: ids in `priority` first (in that order), the rest after. */
function applyOrder(fields: FormProperty[], priority: string[]): FormProperty[] {
  const rank = new Map<string, number>();
  priority.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => {
      const rankA = rank.get(a.field.id);
      const rankB = rank.get(b.field.id);
      if (rankA === undefined && rankB === undefined) return a.index - b.index;
      if (rankA === undefined) return 1;
      if (rankB === undefined) return -1;
      return rankA - rankB || a.index - b.index;
    })
    .map((entry) => entry.field);
}

/** Build a required-resolver from the config's array/record toggle shapes. */
function requiredResolver(raw: unknown): (property: FormProperty) => boolean {
  if (Array.isArray(raw)) {
    const forced = new Set(raw.filter((id): id is string => typeof id === "string"));
    return (property) => forced.has(property.id) || property.required;
  }
  if (raw && typeof raw === "object") {
    const toggles = raw as Record<string, unknown>;
    return (property) => {
      const flag = toggles[property.id];
      return typeof flag === "boolean" ? flag : property.required;
    };
  }
  return (property) => property.required;
}

/**
 * Resolve the ordered questions of a form.
 *
 * Questions default to every non-computed property in schema order; a
 * non-empty `fieldIds` narrows and orders them (unknown, computed and duplicate
 * ids are dropped). `order` is then applied as a priority so a dragged list can
 * be persisted without rewriting `fieldIds`. `required` may be an id list
 * (force-require on top of each property's own flag) or an id → boolean map
 * (an explicit toggle that can also *clear* a required property). Never throws;
 * junk input yields an empty form.
 */
export function buildFormSchema(props: unknown, config: unknown): FormField[] {
  try {
    const list = Array.isArray(props) ? props : [];
    const normalized: FormProperty[] = [];
    const byId = new Map<string, FormProperty>();
    for (const candidate of list) {
      const property = asProperty(candidate);
      if (!property || property.id === "" || COMPUTED_PROPERTY_TYPES.has(property.type)) {
        continue;
      }
      if (byId.has(property.id)) continue; // first definition wins
      byId.set(property.id, property);
      normalized.push(property);
    }

    const cfg = asConfig(config);
    let selected: FormProperty[];
    const requested = asStringArray(cfg.fieldIds);
    if (requested.length > 0) {
      const seen = new Set<string>();
      selected = [];
      for (const id of requested) {
        if (seen.has(id)) continue;
        seen.add(id);
        const property = byId.get(id);
        if (property) selected.push(property);
      }
    } else {
      selected = normalized;
    }

    const ordered = applyOrder(selected, asStringArray(cfg.order));
    const required = requiredResolver(cfg.required);
    return ordered.map((property) => ({
      propertyId: property.id,
      label: property.name,
      type: property.type,
      required: required(property),
      primary: property.primary,
      config: property.config,
    }));
  } catch {
    return [];
  }
}

/** Resolve the intro description and submit label, with defaults. */
export function resolveFormMeta(config: unknown): FormMeta {
  const cfg = asConfig(config);
  const description = typeof cfg.description === "string" ? cfg.description : "";
  const label = typeof cfg.submitLabel === "string" ? cfg.submitLabel.trim() : "";
  return { description, submitLabel: label === "" ? DEFAULT_SUBMIT_LABEL : label };
}

/** Coerce an untrusted resolved field, returning `null` when unusable. */
function asField(input: unknown): FormField | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const propertyId = raw.propertyId;
  if (typeof propertyId !== "string" || propertyId === "") return null;
  const label = raw.label;
  const config = raw.config;
  return {
    propertyId,
    label: typeof label === "string" && label.trim() !== "" ? label : "Value",
    type: typeof raw.type === "string" ? raw.type : "",
    required: raw.required === true,
    primary: raw.primary === true,
    config:
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {},
  };
}

/** Read answers from a `{ propertyId: value }` map or a `{ propertyId, value }[]` list. */
function normalizeAnswers(answers: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!answers || typeof answers !== "object") return map;
  if (Array.isArray(answers)) {
    for (const entry of answers) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.propertyId === "string") map.set(item.propertyId, item.value);
    }
    return map;
  }
  for (const [propertyId, value] of Object.entries(answers as Record<string, unknown>)) {
    map.set(propertyId, value);
  }
  return map;
}

/**
 * Validate a submission against resolved fields (the builder's `FormField[]`).
 * Each answer is checked with `validateCell` under the field's toggled
 * `required` flag, so type constraints (min/max, length, pattern, options, date
 * range) match a real cell write. Returns one issue per failing field in field
 * order; never throws.
 */
function validateResolvedFields(fields: unknown, answers: unknown): FormIssue[] {
  const issues: FormIssue[] = [];
  try {
    const answerMap = normalizeAnswers(answers);
    const list = Array.isArray(fields) ? fields : [];
    for (const candidate of list) {
      const field = asField(candidate);
      if (!field) continue;
      const result = validateCell(
        {
          id: field.propertyId,
          name: field.label,
          type: field.type,
          required: field.required,
          config: field.config,
        },
        answerMap.get(field.propertyId),
      );
      if (!result.ok) {
        issues.push({
          propertyId: field.propertyId,
          label: field.label,
          errors: result.errors,
        });
      }
    }
  } catch {
    // Fail open: an exotic field list must never break the caller.
    return [];
  }
  return issues;
}

/** Flatten resolved issues to the compact `{ propertyId, code }` shape. */
function issuesToErrors(issues: FormIssue[]): SubmissionError[] {
  const errors: SubmissionError[] = [];
  for (const issue of issues) {
    for (const error of issue.errors) {
      errors.push({ propertyId: issue.propertyId, code: error.code });
    }
  }
  return errors;
}

/**
 * Validate a submission.
 *
 * Accepts either a parsed {@link FormSchema} (the form-view engine; returns
 * `errors`) or a resolved `FormField[]` (the live builder/respondent renderer;
 * returns rich `issues`). Both are backed by `validateCell`, so the form can
 * never accept a value a real cell write would reject. Returns `ok:true` for a
 * valid submission; otherwise both the compact `errors` list and the detailed
 * `issues`. Never throws.
 */
export function validateSubmission(input: unknown, answers: unknown): FormSubmission {
  try {
    if (isFormSchemaInput(input)) {
      const issues = validateSchemaFields(parseFormSchema(input), answers);
      const errors = issuesToErrors(issues);
      return errors.length > 0 ? { ok: false, errors, issues } : { ok: true };
    }
    const issues = validateResolvedFields(input, answers);
    const errors = issuesToErrors(issues);
    return errors.length > 0 ? { ok: false, errors, issues } : { ok: true };
  } catch {
    // Fail open, matching cell-validation: an exotic answer is not an error.
    return { ok: true };
  }
}

/**
 * Map answers to the `{ propertyId, value }` cells the app stores, in field
 * order. Only fields with a defined answer are emitted (an unanswered optional
 * question writes nothing); answer keys not present in the schema are ignored.
 */
export function answersToPropertyValues(
  fields: unknown,
  answers: unknown,
): { propertyId: string; value: unknown }[] {
  const out: { propertyId: string; value: unknown }[] = [];
  try {
    const answerMap = normalizeAnswers(answers);
    const list = Array.isArray(fields) ? fields : [];
    for (const candidate of list) {
      const field = asField(candidate);
      if (!field || !answerMap.has(field.propertyId)) continue;
      out.push({ propertyId: field.propertyId, value: answerMap.get(field.propertyId) });
    }
  } catch {
    // Return whatever was collected before the malformed input.
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Parsed form schema engine (R89.29)
   ---------------------------------------------------------------------------

   `buildFormSchema` above derives an ordered question list from *live*
   database properties. The engine below models the *stored* form: a JSON-safe
   {@link FormSchema} round-tripped through `DatabaseView.config.form`. It is
   parsed (`parseFormSchema`), linted against the database's properties
   (`validateFormSchema`), used to pre-fill (`defaultAnswers`) and validate
   (`validateSubmission`) a submission, mapped to row cells (`toRowValues`),
   described for the builder/closed state (`describeForm`), paused/resumed
   (`toggleAccepting`) and reordered (`fieldOrder`). Everything is pure and
   never throws: stored config is untrusted JSON.
*/

/** Default success copy shown after a submission when none is configured. */
export const DEFAULT_SUCCESS_MESSAGE = "Your response has been recorded.";

/** Longest accepted form title (builder constraint, R89.29). */
export const FORM_TITLE_MAX_LENGTH = 200;

/** A known database property: a bare id or a Prisma-shaped `{ id }` record. */
export type FormPropertyRef = string | { id: string };

/** The JSON-safe stored form: title, ordered questions and settings. */
export type FormSchema = {
  /** The form/view identifier. */
  id: string;
  /** The database the submission creates rows in (re-authorization target). */
  databaseId: string;
  /** Respondent-facing title (builder shows it at the top). */
  title: string;
  /** Optional intro copy under the title. */
  description?: string;
  /** Ordered questions. */
  fields: FormField[];
  /** `false` ⇒ the polite closed-state page (R89.29). Defaults to `true`. */
  accepting: boolean;
  /** Submit button label; defaults to `DEFAULT_SUBMIT_LABEL`. */
  submitLabel?: string;
  /** Copy shown after a successful submit; defaults to `DEFAULT_SUCCESS_MESSAGE`. */
  successMessage?: string;
};

/** Machine-readable reason a stored schema was rejected. */
export type FormSchemaErrorCode =
  /** Missing or over-long title. */
  | "TITLE_LENGTH"
  /** A question points at a property the database does not have. */
  | "UNKNOWN_PROPERTY"
  /** The same property is asked twice. */
  | "DUPLICATE_PROPERTY"
  /** A required question is hidden (impossible to answer). */
  | "REQUIRED_HIDDEN"
  /** Every question is hidden (or there are none). */
  | "NO_VISIBLE_FIELDS";

/** One schema-level problem. */
export type FormSchemaError = {
  code: FormSchemaErrorCode;
  message: string;
  /** Offending property id, when the error is about one question. */
  propertyId?: string;
};

/** `ok:true` when the schema is publishable; otherwise the failures. */
export type FormSchemaValidation = { ok: true } | { ok: false; errors: FormSchemaError[] };

/** One failing answer, reduced to its property id and machine code. */
export type SubmissionError = { propertyId: string; code: CellErrorCode };

/**
 * A submission outcome: valid, or the compact `errors` list plus the detailed
 * `issues` (so both the schema engine and the live renderer read one result).
 */
export type FormSubmission =
  | { ok: true }
  | { ok: false; errors: SubmissionError[]; issues: FormIssue[] };

/** Everything the respondent UI needs to render a form's chrome. */
export type FormDescription = {
  title: string;
  description: string;
  submitLabel: string;
  successMessage: string;
  accepting: boolean;
  /** Number of visible (answerable) questions. */
  questionCount: number;
};

/** JSON-safe structural clone so defaults never share a mutable reference. */
function cloneDefault<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneDefault(entry)) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneDefault(entry);
    }
    return out as T;
  }
  return value;
}

/** Coerce one untrusted schema field; returns `null` when it has no property. */
function asSchemaField(input: unknown): FormField | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const propertyId = raw.propertyId;
  if (typeof propertyId !== "string" || propertyId.trim() === "") return null;
  const label = raw.label;
  const field: FormField = {
    propertyId,
    label: typeof label === "string" && label.trim() !== "" ? label : "Value",
  };
  if (raw.required === true) field.required = true;
  else if (raw.required === false) field.required = false;
  if (typeof raw.help === "string") field.help = raw.help;
  if (raw.hidden === true) field.hidden = true;
  if (raw.default !== undefined) field.default = cloneDefault(raw.default);
  if (typeof raw.type === "string" && raw.type !== "") field.type = raw.type;
  if (raw.primary === true) field.primary = true;
  if (raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)) {
    field.config = raw.config as Record<string, unknown>;
  }
  return field;
}

/**
 * Normalize untrusted JSON (a `DatabaseView.config.form` blob) into a
 * {@link FormSchema}. Missing scalars fall back to `""`/`true`, malformed fields
 * are dropped, and duplicate/unknown property ids are preserved so
 * `validateFormSchema` can report them. Idempotent and never throws.
 */
export function parseFormSchema(raw: unknown): FormSchema {
  const schema: FormSchema = {
    id: "",
    databaseId: "",
    title: "",
    fields: [],
    accepting: true,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return schema;
  const record = raw as Record<string, unknown>;
  if (typeof record.id === "string") schema.id = record.id;
  if (typeof record.databaseId === "string") schema.databaseId = record.databaseId;
  if (typeof record.title === "string") schema.title = record.title;
  if (typeof record.description === "string") schema.description = record.description;
  if (typeof record.submitLabel === "string") schema.submitLabel = record.submitLabel;
  if (typeof record.successMessage === "string") schema.successMessage = record.successMessage;
  schema.accepting = record.accepting !== false;
  if (Array.isArray(record.fields)) {
    for (const entry of record.fields) {
      const field = asSchemaField(entry);
      if (field) schema.fields.push(field);
    }
  }
  return schema;
}

/** The answerable questions, in order (hidden fields excluded). */
function visibleFields(schema: FormSchema): FormField[] {
  return schema.fields.filter((field) => field.hidden !== true);
}

/**
 * Lint a stored schema against the database's properties: missing/over-long
 * title, questions pointing at unknown or duplicated properties, required-but-
 * hidden questions, and a form with nothing to answer. Returns every problem
 * (never throws) so the builder can surface them together.
 */
export function validateFormSchema(
  schema: FormSchema,
  options: { properties: readonly FormPropertyRef[] },
): FormSchemaValidation {
  const errors: FormSchemaError[] = [];
  const title = typeof schema.title === "string" ? schema.title.trim() : "";
  if (title === "") {
    errors.push({ code: "TITLE_LENGTH", message: "Form title is required." });
  } else if (title.length > FORM_TITLE_MAX_LENGTH) {
    errors.push({
      code: "TITLE_LENGTH",
      message: `Form title must be at most ${FORM_TITLE_MAX_LENGTH} characters.`,
    });
  }

  const known = new Set<string>();
  for (const property of options.properties) {
    const id = typeof property === "string" ? property : property.id;
    if (typeof id === "string" && id !== "") known.add(id);
  }

  const seen = new Set<string>();
  let visible = 0;
  for (const field of schema.fields) {
    if (field.hidden !== true) visible += 1;
    if (!known.has(field.propertyId)) {
      errors.push({
        code: "UNKNOWN_PROPERTY",
        propertyId: field.propertyId,
        message: `Unknown property: ${field.propertyId}`,
      });
    } else if (seen.has(field.propertyId)) {
      errors.push({
        code: "DUPLICATE_PROPERTY",
        propertyId: field.propertyId,
        message: `Duplicate property: ${field.propertyId}`,
      });
    }
    seen.add(field.propertyId);
    if (field.required === true && field.hidden === true) {
      errors.push({
        code: "REQUIRED_HIDDEN",
        propertyId: field.propertyId,
        message: `Required property cannot be hidden: ${field.propertyId}`,
      });
    }
  }

  if (visible === 0) {
    errors.push({
      code: "NO_VISIBLE_FIELDS",
      message: "A form must show at least one question.",
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Whether the input looks like a stored `FormSchema` (has a `fields` array). */
function isFormSchemaInput(input: unknown): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Array.isArray((input as Record<string, unknown>).fields)
  );
}

/** Validate a parsed schema's answers with the shared cell rules. */
function validateSchemaFields(schema: FormSchema, answers: unknown): FormIssue[] {
  const issues: FormIssue[] = [];
  const answerMap = normalizeAnswers(answers);
  for (const field of visibleFields(schema)) {
    const result = validateCell(
      {
        id: field.propertyId,
        name: field.label,
        type: typeof field.type === "string" ? field.type : "",
        required: field.required === true,
        config: field.config ?? {},
      },
      answerMap.get(field.propertyId),
    );
    if (!result.ok) {
      issues.push({ propertyId: field.propertyId, label: field.label, errors: result.errors });
    }
  }
  return issues;
}

/**
 * The pre-filled answers for a fresh respondent: each visible field's `default`,
 * deep-cloned so a caller cannot mutate the stored schema. Fields without a
 * default are omitted. Never throws.
 */
export function defaultAnswers(schema: FormSchema): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  try {
    for (const field of visibleFields(schema)) {
      if (field.default !== undefined) answers[field.propertyId] = cloneDefault(field.default);
    }
  } catch {
    // Return whatever was collected before a malformed default.
  }
  return answers;
}

/**
 * Map answers to the `{ propertyId, value }` cells a new row stores, in field
 * order. A field's `default` fills in when its answer is absent; questions with
 * neither are skipped, and answer keys not in the schema are ignored. Hidden
 * fields are never written. Never throws.
 */
export function toRowValues(
  schema: FormSchema,
  answers: unknown,
): { propertyId: string; value: unknown }[] {
  const out: { propertyId: string; value: unknown }[] = [];
  try {
    const answerMap = normalizeAnswers(answers);
    for (const field of visibleFields(schema)) {
      if (answerMap.has(field.propertyId)) {
        out.push({ propertyId: field.propertyId, value: answerMap.get(field.propertyId) });
      } else if (field.default !== undefined) {
        out.push({ propertyId: field.propertyId, value: cloneDefault(field.default) });
      }
    }
  } catch {
    // Return whatever was collected before the malformed input.
  }
  return out;
}

/** Display metadata for a form: filled-in copy, accept state, question count. */
export function describeForm(schema: FormSchema): FormDescription {
  const submitLabel =
    typeof schema.submitLabel === "string" && schema.submitLabel.trim() !== ""
      ? schema.submitLabel.trim()
      : DEFAULT_SUBMIT_LABEL;
  const successMessage =
    typeof schema.successMessage === "string" && schema.successMessage.trim() !== ""
      ? schema.successMessage.trim()
      : DEFAULT_SUCCESS_MESSAGE;
  return {
    title: typeof schema.title === "string" ? schema.title : "",
    description: typeof schema.description === "string" ? schema.description : "",
    submitLabel,
    successMessage,
    accepting: schema.accepting === true,
    questionCount: visibleFields(schema).length,
  };
}

/** Return a copy of `schema` with `accepting` set to `on` (never mutates). */
export function toggleAccepting(schema: FormSchema, on: boolean): FormSchema {
  return { ...schema, accepting: on === true };
}

/**
 * The questions in their effective order. Without `order` the stored order is
 * returned; with it, the listed property ids lead (in that order) and the
 * remaining questions keep their relative order — a stable drag-reorder helper.
 * A copy is always returned, so callers can assign it back to `schema.fields`.
 */
export function fieldOrder(schema: FormSchema, order?: readonly string[]): FormField[] {
  const next = schema.fields.slice();
  const priority = Array.isArray(order) ? order : [];
  const rank = new Map<string, number>();
  priority.forEach((id, index) => {
    if (typeof id === "string" && !rank.has(id)) rank.set(id, index);
  });
  if (rank.size === 0) return next;
  next.sort((a, b) => {
    const rankA = rank.get(a.propertyId);
    const rankB = rank.get(b.propertyId);
    if (rankA === undefined && rankB === undefined) return 0;
    if (rankA === undefined) return 1;
    if (rankB === undefined) return -1;
    return rankA - rankB;
  });
  return next;
}

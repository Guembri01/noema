/**
 * Form-view builder helpers.
 *
 * `DatabaseView.config.form` is untrusted JSON that can be either a legacy
 * `FormConfig` (`fieldIds`/`required`/`order`) or a full `FormSchema`. The
 * builder needs one editable schema that:
 *
 * - lists every answerable property (so a legacy form can grow),
 * - keeps the stored order and per-question settings,
 * - and marks properties outside a stored selection as hidden rather than
 *   silently dropping them.
 *
 * Everything here is pure so the toolbar can stay a thin presentational layer
 * and the round-trip rules are testable without a DOM.
 */

import {
  FORM_TITLE_MAX_LENGTH,
  buildFormSchema,
  isPublicFormType,
  parseFormSchema,
  validateFormSchema,
  type FormField,
  type FormSchema,
} from "./form-view";

export const FORM_DESCRIPTION_MAX_LENGTH = 500;
export const FORM_SUBMIT_LABEL_MAX_LENGTH = 40;
export const FORM_SUCCESS_MESSAGE_MAX_LENGTH = 200;

export type FormBuilderDefaults = {
  /** The database view id; stored as the form identity. */
  id: string;
  /** The database page id; the re-authorization target for a submission. */
  databaseId: string;
  /** Fallback title when nothing has been saved yet (usually the view name). */
  title?: string;
};

/** One property shape the builder needs; structural to stay decoupled. */
type BuilderProperty = {
  id: string;
  name: string;
  type?: string;
  config?: unknown;
  required?: boolean;
};

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function legacySelection(config: unknown): string[] {
  const record = asRecord(config);
  const fieldIds = record?.fieldIds;
  return Array.isArray(fieldIds)
    ? fieldIds.filter((id): id is string => typeof id === "string")
    : [];
}

/**
 * Build the builder's editable draft from the live schema plus the stored form
 * config. The result intentionally includes hidden fields: the builder shows a
 * checkbox per property instead of only the questions already selected.
 */
export function createFormDraft(
  properties: unknown,
  config: unknown,
  defaults: FormBuilderDefaults,
): FormSchema {
  const parsed = parseFormSchema(config);
  const allFields = buildFormSchema(properties, {});
  const allById = new Map(allFields.map((field) => [field.propertyId, field]));
  const legacyIds = legacySelection(config);
  const legacyById = new Map(
    buildFormSchema(properties, config).map((field) => [field.propertyId, field]),
  );
  const savedById = new Map(parsed.fields.map((field) => [field.propertyId, field]));

  let leadIds: string[];
  let visibleIds: Set<string>;
  if (parsed.fields.length > 0) {
    leadIds = parsed.fields.map((field) => field.propertyId);
    visibleIds = new Set(leadIds);
  } else if (legacyIds.length > 0) {
    leadIds = legacyIds.filter((id) => allById.has(id));
    visibleIds = new Set(leadIds);
  } else {
    leadIds = allFields.map((field) => field.propertyId);
    visibleIds = new Set(leadIds);
  }

  const seen = new Set<string>();
  const orderedIds = [...leadIds, ...allFields.map((field) => field.propertyId)].filter(
    (id) => {
      if (seen.has(id) || !allById.has(id)) return false;
      seen.add(id);
      return true;
    },
  );

  const fields: FormField[] = orderedIds.map((id) => {
    const base = allById.get(id) as FormField;
    const saved = savedById.get(id);
    const legacy = legacyById.get(id);
    const field: FormField = {
      ...base,
      hidden: saved ? saved.hidden === true : !visibleIds.has(id),
    };
    if (saved) {
      if (saved.label.trim() !== "") field.label = saved.label;
      if (saved.required !== undefined) field.required = saved.required;
      if (saved.help !== undefined) field.help = saved.help;
      if (saved.default !== undefined) field.default = saved.default;
    } else if (legacy?.required !== undefined) {
      field.required = legacy.required;
    }
    return field;
  });

  return {
    id: parsed.id || defaults.id,
    databaseId: parsed.databaseId || defaults.databaseId,
    title: parsed.title || defaults.title || "Form",
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    fields,
    accepting: parsed.accepting,
    ...(parsed.submitLabel !== undefined ? { submitLabel: parsed.submitLabel } : {}),
    ...(parsed.successMessage !== undefined ? { successMessage: parsed.successMessage } : {}),
  };
}

/** Include or exclude a question without losing its order or settings. */
export function setFormFieldIncluded(
  schema: FormSchema,
  propertyId: string,
  included: boolean,
): FormSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) =>
      field.propertyId === propertyId
        ? // A hidden required question is impossible to answer; clearing the
          // flag when it leaves the form keeps the draft publishable.
          { ...field, hidden: !included, ...(included ? {} : { required: false }) }
        : field,
    ),
  };
}

/** Toggle a question's required flag. */
export function setFormFieldRequired(
  schema: FormSchema,
  propertyId: string,
  required: boolean,
): FormSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) =>
      field.propertyId === propertyId ? { ...field, required } : field,
    ),
  };
}

/** Edit the respondent-facing label; blank labels fall back to the property name. */
export function setFormFieldLabel(
  schema: FormSchema,
  propertyId: string,
  label: string,
): FormSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) =>
      field.propertyId === propertyId ? { ...field, label } : field,
    ),
  };
}

/** Move a question by one slot, clamping at the ends and preserving all fields. */
export function moveFormField(
  schema: FormSchema,
  propertyId: string,
  delta: number,
): FormSchema {
  const index = schema.fields.findIndex((field) => field.propertyId === propertyId);
  if (index === -1 || delta === 0) return schema;
  const target = Math.min(schema.fields.length - 1, Math.max(0, index + delta));
  if (target === index) return schema;
  const fields = schema.fields.slice();
  const [moved] = fields.splice(index, 1);
  fields.splice(target, 0, moved);
  return { ...schema, fields };
}

/** Update the display-only form settings, leaving questions untouched. */
export function updateFormSettings(
  schema: FormSchema,
  patch: Partial<
    Pick<
      FormSchema,
      "title" | "description" | "submitLabel" | "successMessage" | "accepting"
    >
  >,
): FormSchema {
  return {
    ...schema,
    ...patch,
  };
}

/**
 * Canonicalise a draft on save: trim and bound every string, drop duplicate or
 * blank questions, and omit empty optional copy so the stored config stays
 * small and `describeForm` falls back to its own defaults.
 */
export function finalizeFormSchema(schema: FormSchema): FormSchema {
  const seen = new Set<string>();
  const fields: FormField[] = [];
  for (const field of schema.fields) {
    if (!field.propertyId || seen.has(field.propertyId)) continue;
    seen.add(field.propertyId);
    const label = field.label.trim().slice(0, FORM_TITLE_MAX_LENGTH);
    const next: FormField = {
      ...field,
      label: label === "" ? "Value" : label,
    };
    if (next.required !== true) delete next.required;
    if (next.hidden !== true) delete next.hidden;
    if (next.help !== undefined && next.help.trim() === "") delete next.help;
    fields.push(next);
  }

  const title = schema.title.trim().slice(0, FORM_TITLE_MAX_LENGTH);
  const description = schema.description?.trim().slice(0, FORM_DESCRIPTION_MAX_LENGTH);
  const submitLabel = schema.submitLabel?.trim().slice(0, FORM_SUBMIT_LABEL_MAX_LENGTH);
  const successMessage = schema.successMessage
    ?.trim()
    .slice(0, FORM_SUCCESS_MESSAGE_MAX_LENGTH);

  return {
    id: schema.id,
    databaseId: schema.databaseId,
    title,
    ...(description ? { description } : {}),
    fields,
    accepting: schema.accepting === true,
    ...(submitLabel ? { submitLabel } : {}),
    ...(successMessage ? { successMessage } : {}),
  };
}

/**
 * What a public link can actually ask: visible questions whose picker does not
 * need a signed-in user, plus the visible questions it has to hide. The builder
 * uses this to warn before publishing and to refuse a link with no usable
 * question; `submitPublicFormAction` applies the same filter server-side.
 */
export function publicQuestionAvailability(
  fields: readonly FormField[],
  properties: readonly BuilderProperty[],
): { unsupported: number; hasPublic: boolean } {
  const byId = new Map(properties.map((property) => [property.id, property]));
  let unsupported = 0;
  let hasPublic = false;
  for (const field of fields) {
    if (field.hidden === true) continue;
    const property = byId.get(field.propertyId);
    if (!property) continue;
    if (isPublicFormType(property.type)) hasPublic = true;
    else unsupported += 1;
  }
  return { unsupported, hasPublic };
}

/**
 * Whether a draft can be saved: the form engine's schema lint plus the
 * builder-only requirement that the title has content.
 */
export function formDraftIssues(
  schema: FormSchema,
  properties: readonly BuilderProperty[],
): string[] {
  const validation = validateFormSchema(schema, { properties });
  return validation.ok ? [] : validation.errors.map((error) => error.message);
}

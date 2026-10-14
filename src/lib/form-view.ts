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

import { validateCell, type CellError } from "@/lib/cell-validation";

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

/** One resolved form question. `config` is the property config the editors use. */
export type FormField = {
  propertyId: string;
  label: string;
  type: string;
  required: boolean;
  primary: boolean;
  config: Record<string, unknown>;
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
 * Validate a submission against resolved fields. Each answer is checked with
 * `validateCell` under the field's toggled `required` flag, so type constraints
 * (min/max, length, pattern, options, date range) match a real cell write.
 * Returns one issue per failing field in field order; never throws.
 */
export function validateSubmission(fields: unknown, answers: unknown): FormValidation {
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
    // Fail open, matching cell-validation: an exotic answer is not an error.
    return { ok: true };
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
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

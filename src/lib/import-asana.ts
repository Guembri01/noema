import type { PropertyType } from "@prisma/client";
import type { DBProperty, DBRow } from "@/components/database/database-types";

/**
 * Pure Asana JSON export → Noema database shape parser (spec
 * `import-export.md` §12 "Import Asana").
 *
 * Output deliberately reuses the app's own model (`DBProperty` / `DBRow`) and
 * the stored property-value shapes documented in
 * `src/server/actions/database.ts` (`{ text }`, `{ number }`, `{ optionId }`,
 * `{ optionIds }`, `{ start }`, `{ checked }`, `{ names }`) so the import route
 * can persist the result without any translation. No I/O, no throwing on
 * malformed input.
 *
 * The accepted input mirrors the Asana API objects an export is built from:
 * a project (`name`, `sections`, `custom_fields`) with a `tasks` array, where
 * each task carries `memberships[].section` and typed `custom_fields`. A bare
 * `tasks` array and the `{ data: … }` API envelope are accepted too, and every
 * unknown/absent field degrades instead of crashing.
 */

export type AsanaImportMeta = {
  /** Project title (falls back to "Asana project"). */
  projectName: string;
  /** Rows produced (one per well-formed task). */
  tasks: number;
  /** STATUS options derived from sections. */
  sections: number;
  /** Custom-field columns emitted. */
  customFields: number;
  /** Task entries that were not objects at all. */
  skippedMalformedTasks: number;
  /** Custom-field values present but not representable in Noema. */
  skippedCustomFieldValues: number;
  /** Custom-field types with no Noema equivalent, deduped, first-seen order. */
  unmappedCustomFieldTypes: string[];
};

export type AsanaImportResult = {
  properties: DBProperty[];
  rows: DBRow[];
  meta: AsanaImportMeta;
};

/**
 * Asana custom-field type → Prisma `PropertyType`.
 *
 * `enum` becomes a single select and `multi_enum` a multi-select. Types
 * deliberately absent (`custom_id`, `reference`, and anything future) map to
 * `null` so the caller can report the loss instead of inventing a column.
 */
export const ASANA_CUSTOM_FIELD_TYPE_MAP = {
  text: "TEXT",
  number: "NUMBER",
  enum: "SELECT",
  multi_enum: "MULTI_SELECT",
  date: "DATE",
  people: "PEOPLE",
  formula: "FORMULA",
} as const satisfies Readonly<Record<string, PropertyType>>;

/** Noema option/tint palette (see `COLOR_CHOICES`). */
const OPTION_COLORS = ["gray", "blue", "green", "yellow", "orange", "purple", "pink", "red"];
const NOEMA_COLORS: ReadonlySet<string> = new Set(OPTION_COLORS.concat("brown"));

/** Asana colour names that need folding onto Noema's palette. */
const ASANA_COLOR_ALIASES: Readonly<Record<string, string>> = {
  "light-warm-gray": "gray",
  "light-gray": "gray",
  "dark-gray": "gray",
  aqua: "blue",
  teal: "green",
  turquoise: "blue",
};

/** Deterministic property ids; the import route may re-key them on insert. */
const PROPERTY_IDS = {
  name: "name",
  section: "section",
  assignee: "assignee",
  due: "due",
  completed: "completed",
  tags: "tags",
  notes: "notes",
  url: "url",
} as const;

type RawRecord = Record<string, unknown>;
type SelectOption = { id: string; name: string; color: string };

function asObject(value: unknown): RawRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asArrayOrNull(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Lower-case, trimmed custom-field type key; folds `multi_select` onto `multi_enum`. */
function normalizeFieldTypeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return key === "multi_select" ? "multi_enum" : key;
}

/**
 * Map an Asana custom-field type to a Noema `PropertyType`, or `null` when
 * there is no equivalent. Case- and padding-insensitive; any non-string input
 * maps to `null`.
 */
export function mapAsanaCustomFieldType(type: unknown): PropertyType | null {
  const key = normalizeFieldTypeKey(type);
  if (!key) return null;
  const map: Readonly<Record<string, PropertyType>> = ASANA_CUSTOM_FIELD_TYPE_MAP;
  return map[key] ?? null;
}

/**
 * Map an Asana colour value to a Noema palette name, or `null` for anything
 * unrecognised. `light-` / `dark-` prefixes are stripped and the derived name
 * is checked first; a small alias table then folds the remaining names.
 */
export function mapAsanaColor(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const base = lower.replace(/^(light|dark)-/, "");
  if (NOEMA_COLORS.has(base)) return base;
  if (NOEMA_COLORS.has(lower)) return lower;
  return ASANA_COLOR_ALIASES[lower] ?? null;
}

function cycleColor(index: number): string {
  return OPTION_COLORS[index % OPTION_COLORS.length];
}

/** Ordered, deduped option table for a select/multi-select/status column. */
function createOptionStore() {
  const options = new Map<string, SelectOption>();
  return {
    ensure(id: string, name: string | null, color: string | null): SelectOption {
      const existing = options.get(id);
      if (existing) return existing;
      const option: SelectOption = {
        id,
        name: name ?? `Option ${options.size + 1}`,
        color: color ?? cycleColor(options.size),
      };
      options.set(id, option);
      return option;
    },
    get(id: string): SelectOption | undefined {
      return options.get(id);
    },
    list(): SelectOption[] {
      return [...options.values()];
    },
  };
}

type RawFieldEntry = RawRecord;

type OptionStore = ReturnType<typeof createOptionStore>;

/** A resolved custom-field column (declared by the export or inferred from a task). */
type CustomFieldInfo = {
  key: string;
  name: string;
  type: string | null;
  options: OptionStore;
};

/** Stable per-field key: the Asana `gid`, else a name-scoped fallback. */
function fieldKey(gid: unknown, name: string | null): string | null {
  const id = nonEmptyString(gid);
  if (id) return id;
  return name ? `name:${name}` : null;
}

function optionIdOf(raw: unknown, fallbackName: string | null): string | null {
  const option = asObject(raw);
  if (!option) return null;
  return nonEmptyString(option.gid) ?? (fallbackName ? `name:${fallbackName}` : null);
}

/** Register an option from a raw Asana object (`{ gid, name, color }`). */
function ensureRawOption(store: OptionStore, raw: unknown): string | null {
  const record = asObject(raw);
  if (!record) return null;
  const name = nonEmptyString(record.name);
  const id = optionIdOf(record, name);
  if (!id) return null;
  store.ensure(id, name, mapAsanaColor(record.color));
  return id;
}

/**
 * Collect the declared custom-field definitions from `custom_fields` and
 * `custom_field_settings[].custom_field`, keyed in declaration order.
 */
function collectCustomFields(source: RawRecord): Map<string, CustomFieldInfo> {
  const fields = new Map<string, CustomFieldInfo>();

  const add = (raw: unknown): void => {
    const def = asObject(raw);
    if (!def) return;
    const name = nonEmptyString(def.name);
    const key = fieldKey(def.gid, name);
    if (!key || fields.has(key)) return;
    const options = createOptionStore();
    for (const option of asArray(def.enum_options)) ensureRawOption(options, option);
    fields.set(key, {
      key,
      name: name ?? `Field ${fields.size + 1}`,
      type: normalizeFieldTypeKey(def.representation_type ?? def.resource_subtype ?? def.type),
      options,
    });
  };

  asArray(source.custom_fields).forEach(add);
  for (const entry of asArray(source.custom_field_settings)) {
    add(asObject(entry)?.custom_field);
  }

  return fields;
}

/** Resolve (or infer) the column a task's custom-field entry belongs to. */
function resolveField(
  fields: Map<string, CustomFieldInfo>,
  byName: Map<string, string>,
  entry: RawFieldEntry,
): CustomFieldInfo {
  const name = nonEmptyString(entry.name);
  const gid = nonEmptyString(entry.gid);
  const declaredByGid = gid ? fields.get(gid) : undefined;
  if (declaredByGid) return declaredByGid;
  const declaredByName = name ? byName.get(name) : undefined;
  if (declaredByName) {
    const info = fields.get(declaredByName);
    if (info) return info;
  }

  const key = fieldKey(gid, name) ?? `field-${fields.size + 1}`;
  const info: CustomFieldInfo = {
    key,
    name: name ?? `Field ${fields.size + 1}`,
    type: normalizeFieldTypeKey(entry.representation_type ?? entry.resource_subtype ?? entry.type),
    options: createOptionStore(),
  };
  fields.set(key, info);
  if (name) byName.set(name, key);
  return info;
}

function hasFieldValue(entry: RawFieldEntry): boolean {
  return (
    entry.enum_value != null ||
    entry.multi_enum_values != null ||
    entry.number_value != null ||
    entry.text_value != null ||
    entry.date_value != null ||
    entry.people_value != null ||
    entry.display_value != null
  );
}

/** Noema cell value for a mapped custom-field entry, or `null` when unrepresentable. */
function extractFieldValue(type: PropertyType, entry: RawFieldEntry, info: CustomFieldInfo): unknown {
  switch (type) {
    case "TEXT":
    case "URL":
    case "EMAIL":
    case "PHONE": {
      const text = nonEmptyString(entry.text_value) ?? nonEmptyString(entry.display_value);
      return text ? { text } : null;
    }
    case "NUMBER": {
      const number = asFiniteNumber(entry.number_value);
      return number === null ? null : { number };
    }
    case "SELECT":
    case "STATUS": {
      const id = ensureRawOption(info.options, entry.enum_value);
      return id ? { optionId: id } : null;
    }
    case "MULTI_SELECT": {
      const optionIds: string[] = [];
      for (const raw of asArray(entry.multi_enum_values)) {
        const id = ensureRawOption(info.options, raw);
        if (id && !optionIds.includes(id)) optionIds.push(id);
      }
      return optionIds.length ? { optionIds } : null;
    }
    case "DATE": {
      const value = asObject(entry.date_value);
      const start = nonEmptyString(value?.date_time) ?? nonEmptyString(value?.date);
      return start ? { start } : null;
    }
    case "PEOPLE": {
      const names: string[] = [];
      for (const raw of asArray(entry.people_value)) {
        const name = nonEmptyString(asObject(raw)?.name);
        if (name && !names.includes(name)) names.push(name);
      }
      return names.length ? { names } : null;
    }
    default:
      // FORMULA and other computed/read-only values are never stored on a row.
      return null;
  }
}

/** Section id referenced by a task, from `memberships[].section` then `assignee_section`. */
function taskSection(task: RawRecord): { id: string | null; name: string | null } {
  for (const entry of asArray(task.memberships)) {
    const section = asObject(asObject(entry)?.section);
    if (!section) continue;
    const name = nonEmptyString(section.name);
    const id = optionIdOf(section, name);
    if (id) return { id, name };
  }
  const assigneeSection = asObject(task.assignee_section);
  if (assigneeSection) {
    const name = nonEmptyString(assigneeSection.name);
    const id = optionIdOf(assigneeSection, name);
    if (id) return { id, name };
  }
  return { id: null, name: null };
}

function emptyMeta(projectName: string): AsanaImportMeta {
  return {
    projectName,
    tasks: 0,
    sections: 0,
    customFields: 0,
    skippedMalformedTasks: 0,
    skippedCustomFieldValues: 0,
    unmappedCustomFieldTypes: [],
  };
}

/**
 * Parse an Asana JSON export into Noema's database shape.
 *
 * Fail-safe: any input without tasks, sections or custom fields yields an empty
 * result instead of throwing; malformed tasks are skipped and counted; section,
 * tag and enum-option order are preserved.
 */
export function parseAsanaExport(json: unknown): AsanaImportResult {
  const root = asObject(json);
  const dataObject = root ? asObject(root.data) : null;
  const source = dataObject ?? root;
  const bareTaskArray = asArrayOrNull(json);

  if (!source && !bareTaskArray) return { properties: [], rows: [], meta: emptyMeta("") };

  const container: RawRecord = source ?? {};
  const tasksSource = bareTaskArray ?? asArray(container.tasks);
  const sectionsSource = asArray(container.sections);
  const customFieldDefs = collectCustomFields(container);

  const projectName =
    nonEmptyString(container.name) ??
    nonEmptyString(asObject(container.project)?.name) ??
    nonEmptyString(root?.name) ??
    nonEmptyString(asObject(root?.project)?.name) ??
    "Asana project";

  const hasData =
    tasksSource.length > 0 || sectionsSource.length > 0 || customFieldDefs.size > 0;
  if (!hasData) return { properties: [], rows: [], meta: emptyMeta(projectName) };

  const meta = emptyMeta(projectName);

  // Sections → STATUS options, in export order.
  const sectionStore = createOptionStore();
  for (const entry of sectionsSource) {
    const section = asObject(entry);
    if (!section) continue;
    const name = nonEmptyString(section.name);
    const id = optionIdOf(section, name);
    if (id) sectionStore.ensure(id, name, null);
  }

  const tagStore = createOptionStore();
  const fields = customFieldDefs;
  const fieldsByName = new Map<string, string>();
  for (const info of fields.values()) fieldsByName.set(info.name, info.key);

  const unmappedTypes: string[] = [];
  const unmappedSeen = new Set<string>();
  const rows: DBRow[] = [];

  tasksSource.forEach((entry, index) => {
    const task = asObject(entry);
    if (!task) {
      meta.skippedMalformedTasks += 1;
      return;
    }

    const title = nonEmptyString(task.name) ?? "Untitled task";
    const propertyValues: DBRow["propertyValues"] = [
      { propertyId: PROPERTY_IDS.name, value: { text: title } },
    ];

    const section = taskSection(task);
    if (section.id) {
      sectionStore.ensure(section.id, section.name, null);
      propertyValues.push({ propertyId: PROPERTY_IDS.section, value: { optionId: section.id } });
    }

    for (const raw of asArray(task.custom_fields)) {
      const field = asObject(raw);
      if (!field) {
        meta.skippedCustomFieldValues += 1;
        continue;
      }
      const info = resolveField(fields, fieldsByName, field);
      const type = mapAsanaCustomFieldType(info.type);
      if (!type) {
        if (info.type && !unmappedSeen.has(info.type)) {
          unmappedSeen.add(info.type);
          unmappedTypes.push(info.type);
        }
        if (hasFieldValue(field)) meta.skippedCustomFieldValues += 1;
        continue;
      }
      if (type === "FORMULA") continue; // computed, never stored
      const value = extractFieldValue(type, field, info);
      if (value === null) {
        if (hasFieldValue(field)) meta.skippedCustomFieldValues += 1;
        continue;
      }
      propertyValues.push({ propertyId: info.key, value });
    }

    const assignee = nonEmptyString(asObject(task.assignee)?.name);
    if (assignee) {
      propertyValues.push({ propertyId: PROPERTY_IDS.assignee, value: { names: [assignee] } });
    }

    const due = nonEmptyString(task.due_on) ?? nonEmptyString(task.due_at);
    if (due) propertyValues.push({ propertyId: PROPERTY_IDS.due, value: { start: due } });

    if (typeof task.completed === "boolean") {
      propertyValues.push({ propertyId: PROPERTY_IDS.completed, value: { checked: task.completed } });
    }

    const tagIds: string[] = [];
    for (const raw of asArray(task.tags)) {
      const id = ensureRawOption(tagStore, raw);
      if (id && !tagIds.includes(id)) tagIds.push(id);
    }
    if (tagIds.length > 0) {
      propertyValues.push({ propertyId: PROPERTY_IDS.tags, value: { optionIds: tagIds } });
    }

    const notes = nonEmptyString(task.notes);
    if (notes) propertyValues.push({ propertyId: PROPERTY_IDS.notes, value: { text: notes } });

    const url = nonEmptyString(task.permalink_url);
    if (url) propertyValues.push({ propertyId: PROPERTY_IDS.url, value: { text: url } });

    rows.push({
      id: nonEmptyString(task.gid) ?? `task-${index + 1}`,
      title,
      icon: null,
      propertyValues,
    });
  });

  const customProperties: DBProperty[] = [];
  for (const info of fields.values()) {
    const type = mapAsanaCustomFieldType(info.type);
    if (!type) continue;
    customProperties.push({
      id: info.key,
      name: info.name,
      type,
      config:
        type === "SELECT" || type === "MULTI_SELECT"
          ? { options: info.options.list() }
          : null,
    });
  }

  const properties: DBProperty[] = [
    { id: PROPERTY_IDS.name, name: "Name", type: "TEXT", config: { primary: true } },
    {
      id: PROPERTY_IDS.section,
      name: "Section",
      type: "STATUS",
      config: { options: sectionStore.list() },
    },
    ...customProperties,
  ];
  properties.push(
    { id: PROPERTY_IDS.assignee, name: "Assignee", type: "PEOPLE", config: null },
    { id: PROPERTY_IDS.due, name: "Due", type: "DATE", config: null },
    { id: PROPERTY_IDS.completed, name: "Completed", type: "CHECKBOX", config: null },
    {
      id: PROPERTY_IDS.tags,
      name: "Tags",
      type: "MULTI_SELECT",
      config: { options: tagStore.list() },
    },
    { id: PROPERTY_IDS.notes, name: "Notes", type: "TEXT", config: null },
    { id: PROPERTY_IDS.url, name: "URL", type: "URL", config: null },
  );

  meta.tasks = rows.length;
  meta.sections = sectionStore.list().length;
  meta.customFields = customProperties.length;
  meta.unmappedCustomFieldTypes = unmappedTypes;

  return { properties, rows, meta };
}

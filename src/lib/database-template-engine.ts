import type { TemplateRecurrence } from "@/lib/recurrence";

/**
 * Database row-template engine (docs/specs/templates.md §3 model, §6 contracts).
 *
 * Pure, side-effect-free helpers that back the "Database templates", "Default
 * template", "Recurring templates", "Template button", "Template duplication"
 * and "Template locking" matrix rows. Nothing here touches Prisma, auth or the
 * network: callers (server actions / cron) own persistence and permissions, so
 * every predicate below is unit-testable and deterministic.
 *
 * A {@link RowTemplate} is the client-facing projection of the `Template`
 * model: property-id-keyed values plus the display/lifecycle flags the gallery
 * and database Templates menu need. `instantiateRow` is the "apply" step —
 * always a copy — so a locked reference template still produces rows (R31.6)
 * while mutation helpers (`assertMutable`, `setDefaultTemplate` guarded by the
 * caller) refuse edits and the invariant helpers keep at most one default
 * (R31.13).
 */

/** A database row template, as consumed by the UI and materializers. */
export type RowTemplate = {
  id: string;
  databaseId: string;
  name: string;
  /** Property-id → value snapshot taken when the row was saved as a template. */
  values: Record<string, unknown>;
  /** At most one template per database is the default (R31.13). */
  isDefault?: boolean;
  /** Ordering within the database, ascending (defaults to `0`). */
  position?: number;
  /** Locked templates refuse edits but still instantiate (R31.6). */
  locked?: boolean;
  /** Optional recurrence schedule; `null`/absent means "manual only". */
  recurrence?: TemplateRecurrence | null;
  /** ISO-8601 timestamp of capture. */
  createdAt: string;
};

/** The row a template materializes into — a fresh copy, never the template. */
export type RowPayload = {
  databaseId: string;
  templateId: string;
  values: Record<string, unknown>;
  createdAt: string;
  createdById: string;
};

export type InstantiateOptions = {
  /** Instantiation time; becomes the row's `createdAt` (determinism anchor). */
  now: Date;
  /** Acting user; becomes the row's `createdById`. */
  actorId: string;
  /** Explicit values applied last, overriding the template snapshot. */
  overrides?: Record<string, unknown>;
};

/** Structured validation issue (never a thrown error — callers decide). */
export type TemplateIssue = {
  code: string;
  message: string;
  /** Offending property id for `unknown_property`, when applicable. */
  path?: string;
};

/** Property ids as bare strings or `{ id }` records (Prisma-shaped). */
export type TemplatePropertyRef = string | { id: string };

export type ValidateOptions = {
  /** Known property ids of the owning database. */
  properties: readonly TemplatePropertyRef[];
};

export type DuplicateOptions = {
  newId: string;
  /** Display name; defaults to `${source.name} copy`. */
  name?: string;
};

/** JSON-safe structural clone: arrays, dates and plain objects are copied. */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneValue(entry);
    }
    return out as T;
  }
  return value;
}

function cloneRecord(values: Record<string, unknown>): Record<string, unknown> {
  return cloneValue(values);
}

/**
 * Materialize a template into a new row payload (R31.10).
 *
 * The template's `values` are deep-copied, `createdAt`/`createdById` are
 * auto-filled from `now`/`actorId`, and explicit `overrides` are applied **last**
 * so user-entered values win over the snapshot. Locked templates instantiate
 * here just like any other — applying is the point of a reference template
 * (R31.6); mutating template *metadata* is what `assertMutable` guards.
 */
export function instantiateRow(
  template: RowTemplate,
  options: InstantiateOptions,
): RowPayload {
  const { now, actorId, overrides } = options;
  const values = cloneRecord(template.values);
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      values[key] = cloneValue(value);
    }
  }
  return {
    databaseId: template.databaseId,
    templateId: template.id,
    values,
    createdAt: now.toISOString(),
    createdById: actorId,
  };
}

/**
 * Make `id` the single default template (R31.13): every other entry's
 * `isDefault` is cleared, so "at most one default" holds by construction.
 * Returns a new array; the input is never mutated. Unknown ids throw.
 */
export function setDefaultTemplate(
  templates: readonly RowTemplate[],
  id: string,
): RowTemplate[] {
  if (!templates.some((entry) => entry.id === id)) {
    throw new Error(`Template not found: ${id}`);
  }
  return templates.map((entry) => ({ ...entry, isDefault: entry.id === id }));
}

/** The current default template, or `undefined` when none is flagged (R31.13). */
export function resolveDefaultTemplate(
  templates: readonly RowTemplate[],
): RowTemplate | undefined {
  return templates.find((entry) => entry.isDefault === true);
}

/**
 * Deep-copy a template into a new, independent one (R31.8): fresh `values`,
 * the requested id/name, and `isDefault`/`locked` reset so a duplicate is never
 * a second default or an accidental lock.
 */
export function duplicateTemplate(
  template: RowTemplate,
  options: DuplicateOptions,
): RowTemplate {
  const { newId, name } = options;
  if (!newId) {
    throw new Error("duplicateTemplate requires a new template id.");
  }
  return {
    ...template,
    id: newId,
    name: name ?? `${template.name} copy`,
    values: cloneRecord(template.values),
    isDefault: false,
    locked: false,
  };
}

/**
 * Validate a template against its database (R31.15): required fields, values
 * that point at unknown property ids, and the locked-template immutability
 * guard. Returns issues instead of throwing so callers can surface them
 * together; an unlocked, fully-known template yields `[]`.
 */
export function validateTemplate(
  template: RowTemplate,
  options: ValidateOptions,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  if (!template.name || !template.name.trim()) {
    issues.push({ code: "name_required", message: "Template name is required." });
  }
  if (!template.databaseId) {
    issues.push({ code: "database_required", message: "Template database is required." });
  }
  const known = new Set(
    options.properties.map((property) => (typeof property === "string" ? property : property.id)),
  );
  for (const propertyId of Object.keys(template.values)) {
    if (!known.has(propertyId)) {
      issues.push({
        code: "unknown_property",
        message: `Unknown property: ${propertyId}`,
        path: propertyId,
      });
    }
  }
  if (template.locked) {
    issues.push({ code: "locked", message: "Template is locked." });
  }
  return issues;
}

/**
 * Refuse mutation of a locked template (R31.6) with the spec's exact message.
 * No-op for unlocked templates; callers run this before update/delete/rename.
 */
export function assertMutable(template: RowTemplate): void {
  if (template.locked) {
    throw new Error("Template is locked.");
  }
}

/**
 * Move `id` to `index` and rewrite every `position` to the resulting array
 * order (0-based, ascending). `index` is clamped to `[0, length - 1]`;
 * unknown ids throw; the input array and its entries are left untouched.
 */
export function reorderTemplates(
  templates: readonly RowTemplate[],
  id: string,
  index: number,
): RowTemplate[] {
  const from = templates.findIndex((entry) => entry.id === id);
  if (from === -1) {
    throw new Error(`Template not found: ${id}`);
  }
  const next = templates.slice();
  const [moved] = next.splice(from, 1);
  const target = Math.max(0, Math.min(next.length, Math.floor(index)));
  next.splice(target, 0, moved);
  return next.map((entry, position) => ({ ...entry, position }));
}

/**
 * One-line human description for the picker/menu preview (R31.15):
 * `"Weekly report (default, locked, repeats daily, 3 fields)"`. Flag order is
 * stable (default → locked → recurrence → value count) and the count is
 * singularized, so the string is snapshottable in UI tests.
 */
export function describeTemplate(template: RowTemplate): string {
  const base = template.name && template.name.trim() ? template.name : "Untitled template";
  const tags: string[] = [];
  if (template.isDefault) tags.push("default");
  if (template.locked) tags.push("locked");
  if (template.recurrence) tags.push(`repeats ${template.recurrence}`);
  const count = Object.keys(template.values).length;
  if (count > 0) tags.push(`${count} ${count === 1 ? "field" : "fields"}`);
  return tags.length > 0 ? `${base} (${tags.join(", ")})` : base;
}

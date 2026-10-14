import { nextOccurrences, type RecurrenceRule } from "./recurrence";

/**
 * Pure planner for database row templates (docs/specs/templates.md
 * R31.13/R31.20, docs/specs/database-deep.md R89.16/R89.17).
 *
 * The server actions own IO, authz and Prisma; this module owns the decisions
 * they share: merging a saved template's property defaults + body with a row's
 * overrides (`applyTemplate`), picking a database's default template
 * (`resolveDefaultTemplate`), and expanding a recurrence rule into the next N
 * fire times (`buildRecurringSchedule`, a thin validation layer over
 * `recurrence.ts`'s `nextOccurrences`). Everything here is deterministic given
 * its arguments — no `Date.now()`, no globals, no mutation of inputs — so it
 * unit-tests in the node vitest environment.
 */

/** Opaque JSON block tree stored on a template or row body. */
export type TemplateBlock = unknown;

/** A saved row template: the pure projection of `model Template`. */
export interface DatabaseTemplate {
  id: string;
  name: string;
  icon?: string | null;
  /** Default cell values keyed by property id. */
  propertyDefaults?: Record<string, unknown> | null;
  /** Default body blocks copied into a new row. */
  content?: readonly TemplateBlock[] | null;
  /** R31.13 — the database's default template flag (at most one per database). */
  isDefault?: boolean;
}

/** Row-specific values layered on top of a template. */
export interface TemplateOverrides {
  /** Row cell values; win over the template defaults per property id. */
  propertyValues?: Record<string, unknown> | null;
  /** Row body; when present (even `[]`) replaces the template's body. */
  content?: readonly TemplateBlock[] | null;
}

/** The materialized result of applying a template. */
export interface AppliedTemplate {
  templateId: string;
  name: string;
  icon: string | null;
  /** Property cells in a deterministic (id-sorted) order. */
  values: { propertyId: string; value: unknown }[];
  /** Body blocks for the new row (a fresh copy, never the template's array). */
  content: TemplateBlock[];
}

/** Deep copy of a JSON-shaped value; falls back to the original reference when
 * the value is not cloneable, so a hostile stored value can never throw here. */
function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** `Object.entries` for a possibly-absent/malformed record (arrays rejected). */
function entriesOf(record: Record<string, unknown> | null | undefined): [string, unknown][] {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.entries(record);
}

/**
 * Merge a template's defaults with row overrides into the cells + body a new
 * row starts with.
 *
 * - Overrides win per property id; override-only ids are kept, template ids the
 *   row does not restate are kept as defaults (a `undefined` override means
 *   "not provided" and keeps the default; `null` is an explicit stored value).
 * - When `validPropertyIds` is given, defaults *and* overrides for ids outside
 *   it (deleted/stale properties, R31.5) are dropped; ids the template says
 *   nothing about are never invented, so missing properties simply stay empty.
 * - Output is id-sorted and deep-copied, which makes application idempotent
 *   (re-applying the result is a no-op) and leaves the template untouched.
 */
export function applyTemplate(
  template: DatabaseTemplate,
  overrides: TemplateOverrides = {},
  validPropertyIds?: Iterable<string>,
): AppliedTemplate {
  const allowed = validPropertyIds ? new Set(validPropertyIds) : null;
  const merged = new Map<string, unknown>();

  for (const [propertyId, value] of entriesOf(template.propertyDefaults)) {
    if (value !== undefined) merged.set(propertyId, value);
  }
  for (const [propertyId, value] of entriesOf(overrides.propertyValues)) {
    if (value !== undefined) merged.set(propertyId, value);
  }

  const values = [...merged]
    .filter(([propertyId]) => !allowed || allowed.has(propertyId))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([propertyId, value]) => ({ propertyId, value: cloneJson(value) }));

  const blocks =
    overrides.content === undefined ? template.content ?? [] : overrides.content ?? [];

  return {
    templateId: template.id,
    name: template.name,
    icon: template.icon ?? null,
    values,
    content: cloneJson([...blocks]),
  };
}

/** The persisted default-template selector for a database. */
export interface DefaultTemplateConfig {
  /** Stored default template id; wins whenever it still resolves. */
  defaultTemplateId?: string | null;
}

/**
 * R31.13 — pick the database's default row template.
 *
 * The configured `defaultTemplateId` wins when it names a live template;
 * otherwise the first template flagged `isDefault` is used, so a stale id (a
 * deleted default) silently degrades to "no default" only when nothing is
 * flagged. An empty database or unconfigured config yields `null` — the
 * caller then creates a blank row, exactly as before defaults existed.
 */
export function resolveDefaultTemplate(
  templates: readonly DatabaseTemplate[],
  config: DefaultTemplateConfig | null = {},
): DatabaseTemplate | null {
  if (!templates || templates.length === 0) return null;
  const id = config?.defaultTemplateId;
  if (typeof id === "string" && id.length > 0) {
    const explicit = templates.find((template) => template.id === id);
    if (explicit) return explicit;
  }
  return templates.find((template) => template.isDefault === true) ?? null;
}

/** Preview window for `buildRecurringSchedule` when no count is given. */
export const DEFAULT_SCHEDULE_COUNT = 5;

/**
 * R31.20 / R89.17 — the next `count` fire times for a recurrence rule, strictly
 * after `from`, ascending.
 *
 * Deliberately a thin guard over `recurrence.ts`'s `nextOccurrences` (the one
 * evaluator, so the cron driver, the UI chip and this preview can never
 * disagree): it only normalizes a non-positive/fractional count and refuses an
 * invalid `from` (an Invalid Date would otherwise poison every occurrence).
 */
export function buildRecurringSchedule(
  rule: RecurrenceRule,
  from: Date,
  count: number = DEFAULT_SCHEDULE_COUNT,
): Date[] {
  if (!Number.isFinite(from.getTime())) return [];
  if (!Number.isFinite(count) || count <= 0) return [];
  return nextOccurrences(rule, from, Math.floor(count));
}

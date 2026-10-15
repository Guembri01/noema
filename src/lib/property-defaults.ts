/**
 * Pure property default values — the concrete cell a brand-new row starts with.
 *
 * A database property may carry a configured default in its `config` (or none at
 * all). This module resolves that default into the exact JSON shape the app
 * stores on `PropertyValue.value` — the same mapping documented at the top of
 * `src/server/actions/database.ts`:
 *
 *   TEXT | URL | EMAIL | PHONE -> { text: string }
 *   NUMBER                     -> { number: number }
 *   CHECKBOX                   -> { checked: boolean }
 *   DATE                       -> { start: string }
 *   SELECT | STATUS            -> { optionId: string }
 *   MULTI_SELECT               -> { optionIds: string[] }
 *   PEOPLE                     -> { names: string[] }
 *   FILES                      -> { files: { name; url; mimeType? }[] }
 *
 * Design rules:
 *
 * - **An empty cell is `null`.** A fresh row does not store a value for a
 *   text/number/date/select property until the user edits it (an empty
 *   `{ text: "" }` is normalised away to `null`, matching the "empty means
 *   missing" rule in `cell-validation.ts`). Container types, however, have a
 *   real empty shape (`{ checked: false }`, `{ optionIds: [] }`, …) because an
 *   (un)checked box or an empty option set is itself a stored value.
 * - **Computed types never default.** FORMULA, ROLLUP, relations, audit
 *   timestamps/actors, unique ids, buttons and AI autofill are derived by the
 *   server (the derived set mirrors `COMPUTED_PROPERTY_TYPES` in
 *   `form-view.ts`), so they always resolve to `null` — even if a default is
 *   configured.
 * - **Fail-safe by contract.** Stored config round-trips as untrusted JSON, so
 *   every field is checked at runtime and nothing here throws: a malformed
 *   config, an unknown option or an unreadable value simply falls back to the
 *   type's empty shape.
 *
 * No DB, no routes, no React — a server action creating a row and a client
 * preview can import this directly and agree on the starting cells.
 */

/** A configured default value; the shape is validated per property type. */
export type PropertyDefaultConfig = {
  /**
   * Optional default, interpreted by the property type: a string for
   * TEXT|URL|EMAIL|PHONE (trimmed) and DATE, a finite number (or numeric
   * string) for NUMBER, a boolean for CHECKBOX, an option id/name for
   * SELECT|STATUS, an array of ids/names for MULTI_SELECT and an array of
   * strings for PEOPLE. Anything else falls back to the empty shape.
   */
  default?: unknown;
  /** SELECT/STATUS/MULTI_SELECT options a default may be resolved against. */
  options?: readonly { id?: unknown; name?: unknown }[];
};

/** A stored cell value, in one of the app's `PropertyValue.value` shapes. */
export type StoredPropertyValue =
  | { text: string }
  | { number: number }
  | { checked: boolean }
  | { start: string }
  | { optionId: string }
  | { optionIds: string[] }
  | { names: string[] }
  | { files: { name: string; url: string; mimeType?: string }[] };

/** One initialized cell, ready to become a `PropertyValue` row. */
export type RowDefaultValue = { propertyId: string; value: StoredPropertyValue };

/**
 * Property types that are derived or system-managed and therefore can never
 * hold a user default. Mirrors `COMPUTED_PROPERTY_TYPES` in `./form-view`.
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

function normalizeType(type: unknown): string {
  return typeof type === "string" ? type.trim().toUpperCase() : "";
}

/** Read config as a plain record, tolerating null/arrays/scalars. */
function asConfig(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

/** The id/name index of a property's configured options. */
type OptionIndex = { ids: Set<string>; byName: Map<string, string> };

function readOptions(options: unknown): OptionIndex {
  const ids = new Set<string>();
  const byName = new Map<string, string>();
  if (Array.isArray(options)) {
    for (const option of options) {
      if (!option || typeof option !== "object") continue;
      const record = option as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      if (id === "") continue;
      ids.add(id);
      const name = typeof record.name === "string" ? record.name.trim().toLowerCase() : "";
      if (name !== "" && !byName.has(name)) byName.set(name, id);
    }
  }
  return { ids, byName };
}

/**
 * Resolve one raw default to an option id: an exact id wins, then a name
 * (case-insensitively). With no configured options the literal string is kept
 * as-is, so a default can still survive a config that has not loaded its map.
 */
function resolveOptionId(value: unknown, options: OptionIndex): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (options.ids.size === 0) return trimmed;
  if (options.ids.has(trimmed)) return trimmed;
  return options.byName.get(trimmed.toLowerCase()) ?? null;
}

/** Resolve an array of raw defaults to unique option ids, in input order. */
function resolveOptionIds(value: unknown, options: OptionIndex): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const id = resolveOptionId(entry, options);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Keep only the non-empty, trimmed string entries of a raw names default. */
function toStringNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name !== "") out.push(name);
  }
  return out;
}

/**
 * Whether `type` is a derived/system-managed property type (case-insensitive).
 * Computed properties are filled by the server and never take a stored default.
 */
export function isComputedType(type: unknown): boolean {
  const normalized = normalizeType(type);
  return normalized !== "" && COMPUTED_PROPERTY_TYPES.has(normalized);
}

/**
 * The stored cell value a fresh row starts with for `type`, or `null` when the
 * property has no stored default (empty text/number/date/select cells and every
 * computed type).
 *
 * A `config.default` supplies a concrete value (validated per type); when it is
 * absent or unreadable the type's empty shape is returned. Unknown property
 * types resolve to `null`. Never throws.
 */
export function defaultValueFor(type: unknown, config?: unknown): StoredPropertyValue | null {
  try {
    const normalized = normalizeType(type);
    if (normalized === "" || COMPUTED_PROPERTY_TYPES.has(normalized)) return null;

    const cfg = asConfig(config);
    const configured = cfg.default;

    switch (normalized) {
      case "CHECKBOX":
        return { checked: configured === true };
      case "MULTI_SELECT":
        return { optionIds: resolveOptionIds(configured, readOptions(cfg.options)) };
      case "SELECT":
      case "STATUS": {
        const optionId = resolveOptionId(configured, readOptions(cfg.options));
        return optionId === null ? null : { optionId };
      }
      case "DATE": {
        const start = typeof configured === "string" ? configured.trim() : "";
        return start === "" ? null : { start };
      }
      case "NUMBER": {
        const number = toFiniteNumber(configured);
        return number === null ? null : { number };
      }
      case "PEOPLE":
        return { names: toStringNames(configured) };
      case "FILES":
        return { files: [] };
      case "TEXT":
      case "URL":
      case "EMAIL":
      case "PHONE": {
        const text = typeof configured === "string" ? configured.trim() : "";
        return text === "" ? null : { text };
      }
      default:
        // PLACE, and any other type with no stored default shape.
        return null;
    }
  } catch {
    // Fail safe: an exotic config must never break row creation.
    return null;
  }
}

/**
 * Every cell a new row should start with, in schema order.
 *
 * Properties without a stored default (and computed types) are omitted, so a
 * row simply has no value there. Malformed entries and a missing/duplicate id
 * are skipped (the first definition wins), and each returned container is
 * freshly allocated so callers can never share a mutable array. Never throws.
 */
export function initializeRowValues(props: unknown): RowDefaultValue[] {
  const out: RowDefaultValue[] = [];
  try {
    if (!Array.isArray(props)) return out;
    const seen = new Set<string>();
    for (const candidate of props) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const record = candidate as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      const value = defaultValueFor(record.type, record.config);
      if (value !== null) out.push({ propertyId: id, value });
    }
  } catch {
    // Return whatever was collected before the malformed input.
  }
  return out;
}

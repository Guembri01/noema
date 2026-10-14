/**
 * Duplicate database: the pure planning half of "copy a database with
 * structure" (docs/MISSING_FEATURES.md §3 row "Duplicate database";
 * docs/specs/database-deep.md R89.22).
 *
 * R89.22's action copies the database page, its `Property` rows, its
 * `DatabaseView`s and optionally its rows in one transaction. That action needs
 * to know, before it touches Prisma, exactly which ids have to be rewritten —
 * every copied row gets a **fresh** id and every reference that pointed inside
 * the copied set has to follow it, while references to *external* targets
 * (other databases, rows in another database) are left untouched
 * ("relation configs pointing at other databases are left intact").
 *
 * This module is that planning step, entirely in memory: no DB, no routes, no
 * React. Given a structural snapshot `{ properties, views, rows }` it returns a
 * deep clone with:
 *
 * - fresh ids for every property, view, row and select option, in a stable
 *   order (properties, then each property's options, then views, then rows);
 * - remapped intra-references — option ids in configs and cell values, property
 *   ids in view/property configs and cell values, and relation targets that
 *   point at a copied row;
 * - everything else (names, order, external targets, colours, formats) byte for
 *   byte identical, and the input never mutated.
 *
 * `validateCopy` is the safety net: it checks a finished copy for duplicate ids,
 * ids reused from the original, and references that dangle (a reference that was
 * internal before and is no longer resolvable after).
 */

/** A select/status/etc. option carrying a stable id. Extra fields are kept. */
export type CopyOption = {
  id: string;
  name?: string;
  color?: string;
  [key: string]: unknown;
};

/** A property definition, reduced to what a structural copy needs. */
export type CopyProperty = {
  id: string;
  name: string;
  /** Property type, e.g. `"select"`, `"relation"`, `"title"`. */
  type: string;
  /** Arbitrary property config; option lists may live here or in `options`. */
  config?: Record<string, unknown> | null;
  /** Option list (the shape `PropertyOption[]` is stored in). */
  options?: CopyOption[];
  [key: string]: unknown;
};

/** A saved view, reduced to its id and config. */
export type CopyView = {
  id: string;
  config?: Record<string, unknown> | null;
  [key: string]: unknown;
};

/** One `propertyId → value` cell. */
export type CopyPropertyValue = { propertyId: string; value: unknown };

/** A database row, reduced to its id and cells. */
export type CopyRow = {
  id: string;
  propertyValues: CopyPropertyValue[];
  [key: string]: unknown;
};

/** The structural snapshot a copy operates on. */
export type DatabaseStructure = {
  properties: CopyProperty[];
  views: CopyView[];
  rows: CopyRow[];
};

/** Allocates one fresh id per call. */
export type IdFactory = () => string;

/** The id remap `remapReferences` applies: a `Map` or a plain lookup object. */
export type IdMap = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

/** Outcome of `validateCopy`; `errors` is empty exactly when `ok` is true. */
export type CopyValidation = { ok: boolean; errors: string[] };

let defaultCounter = 0;

/**
 * Default id factory: fresh, collision-resistant ids. Randomised so two copies
 * in the same process never share an id, and prefixed so a generated id is
 * recognisable as copy output. Callers that need determinism pass their own
 * `IdFactory`.
 */
export function defaultIdFactory(): string {
  defaultCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `copy_${defaultCounter.toString(36)}_${random}`;
}

/** Property types whose cell values reference option ids. */
const OPTION_TYPES = new Set(["select", "status", "multi_select", "multi-select"]);

/** Property types whose cell values reference row ids. */
const RELATION_TYPES = new Set(["relation"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function toArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/** Every option list attached to a property, wherever it lives. */
function optionsOf(property: CopyProperty | null | undefined): CopyOption[] {
  if (!property || typeof property !== "object") return [];
  const out: CopyOption[] = [];
  const push = (list: unknown) => {
    for (const item of toArray(list as CopyOption[] | undefined)) {
      if (item && typeof item === "object") out.push(item);
    }
  };
  push(property.options);
  const config = property.config;
  if (config && typeof config === "object") push((config as { options?: unknown }).options);
  return out;
}

function lookupId(idMap: IdMap, key: string): string | undefined {
  const get = (idMap as { get?: unknown }).get;
  if (typeof get === "function") return (idMap as ReadonlyMap<string, string>).get(key);
  return Object.prototype.hasOwnProperty.call(idMap, key)
    ? (idMap as Readonly<Record<string, string>>)[key]
    : undefined;
}

/**
 * Deep-clone `value`, replacing every **string** that is a key of `idMap` with
 * its mapped id. Object keys are never rewritten — only values — and arrays,
 * nested objects, primitives, `null` and non-matching strings pass through
 * unchanged. The input is not mutated.
 *
 * This is deliberately id-exact, not pattern based: a string is replaced only
 * when it equals an id in the map, so an external relation target (or any other
 * id the caller did not register) survives.
 */
export function remapReferences<T>(value: T, idMap: IdMap): T {
  return remapValue(value, idMap) as T;
}

function remapValue(value: unknown, idMap: IdMap): unknown {
  if (typeof value === "string") return lookupId(idMap, value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapValue(item, idMap));
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) clone[key] = remapValue(entry, idMap);
    return clone;
  }
  return value;
}

/** Build the merged old→new id map in a deterministic order. */
function buildIdMap(structure: DatabaseStructure, idFactory: IdFactory): Map<string, string> {
  const map = new Map<string, string>();
  const register = (id: unknown) => {
    if (isNonEmptyString(id)) map.set(id, idFactory());
  };
  for (const property of structure.properties) {
    register(property?.id);
    for (const option of optionsOf(property)) register(option?.id);
  }
  for (const view of structure.views) register(view?.id);
  for (const row of structure.rows) register(row?.id);
  return map;
}

/** Assign a fresh id to a cloned entity that arrived without one. */
function ensureId<T extends { id?: unknown }>(value: T, idFactory: IdFactory): T {
  if (!isNonEmptyString(value?.id)) (value as { id: string }).id = idFactory();
  return value;
}

/**
 * Deep-clone a database structure with fresh ids and remapped intra-references.
 *
 * Ids are allocated in a stable order (each property, then its options, then
 * views, then rows), so a supplied `idFactory` can be deterministic in tests.
 * References that do not resolve inside the snapshot — other databases' ids,
 * rows from a different database, plain text — are copied verbatim.
 */
export function duplicateDatabase(
  input: DatabaseStructure,
  idFactory: IdFactory = defaultIdFactory,
): DatabaseStructure {
  const structure: DatabaseStructure = {
    properties: toArray(input?.properties),
    views: toArray(input?.views),
    rows: toArray(input?.rows),
  };
  const idMap = buildIdMap(structure, idFactory);

  return {
    properties: structure.properties.map((property) =>
      ensureId(remapReferences(property, idMap), idFactory),
    ),
    views: structure.views.map((view) => ensureId(remapReferences(view, idMap), idFactory)),
    rows: structure.rows.map((row) => ensureId(remapReferences(row, idMap), idFactory)),
  };
}

/** All ids declared by a structure, with duplicate counts when requested. */
function declaredIds(structure: DatabaseStructure | null | undefined, errors?: string[]): Set<string> {
  const counts = new Map<string, number>();
  const add = (id: unknown) => {
    if (isNonEmptyString(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const property of toArray(structure?.properties)) {
    add(property?.id);
    for (const option of optionsOf(property)) add(option?.id);
  }
  for (const view of toArray(structure?.views)) add(view?.id);
  for (const row of toArray(structure?.rows)) add(row?.id);
  if (errors) {
    for (const [id, count] of counts) if (count > 1) errors.push(`duplicate id: ${id}`);
  }
  return new Set(counts.keys());
}

/** Every string in `value`, so stale references can be found anywhere. */
function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
}

/** Property ids referenced from rows and configs (`propertyId`, group/sort/filter, ...). */
function referencedPropertyIds(structure: DatabaseStructure): string[] {
  const refs: string[] = [];
  const addId = (value: unknown) => {
    if (isNonEmptyString(value)) refs.push(value);
  };
  const addList = (value: unknown) => {
    for (const item of toArray(value as unknown[] | undefined)) addId(item);
  };
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (key === "propertyId" || key === "groupByPropertyId") addId(entry);
        else if (key === "visiblePropertyIds" || key === "propertyIds") addList(entry);
        visit(entry);
      }
    }
  };
  for (const row of structure.rows) {
    for (const cell of toArray(row?.propertyValues)) addId(cell?.propertyId);
  }
  for (const view of structure.views) visit(view?.config);
  for (const property of structure.properties) visit(property?.config);
  return refs;
}

/** Option ids referenced by a cell value (string, array of strings/objects, object). */
function valueRefs(value: unknown): string[] {
  const out: string[] = [];
  const addId = (entry: unknown) => {
    if (isNonEmptyString(entry)) out.push(entry);
  };
  if (isNonEmptyString(value)) addId(value);
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (isNonEmptyString(item)) addId(item);
      else if (item && typeof item === "object") addId((item as { id?: unknown }).id);
    }
  } else if (value && typeof value === "object") {
    addId((value as { id?: unknown }).id);
  }
  return out;
}

/**
 * Check that `copy` is a faithful duplicate of `original`: no duplicate ids, no
 * id carried over from the original, and no reference left dangling.
 *
 * A reference is dangling when it was **internal** to the original (an id that
 * existed there) but no longer resolves inside the copy. External targets —
 * another database's id, a row in a different database — are intentionally
 * preserved and are not reported. Errors are human-readable and path-free;
 * `ok` is true exactly when the list is empty.
 */
export function validateCopy(
  original: DatabaseStructure,
  copy: DatabaseStructure,
): CopyValidation {
  const errors: string[] = [];

  const originalIds = declaredIds(original);
  const copyIds = declaredIds(copy, errors);

  for (const id of copyIds) {
    if (originalIds.has(id)) errors.push(`id reused from original: ${id}`);
  }

  // Any original id still present anywhere in the copy is an un-remapped
  // reference (a copied id itself is fresh, so it never triggers this).
  const copyStrings = new Set<string>();
  collectStrings(copy, copyStrings);
  for (const id of originalIds) {
    if (copyStrings.has(id)) errors.push(`stale reference to original id: ${id}`);
  }

  const copyPropertyIds = new Set(
    toArray(copy?.properties)
      .map((property) => property?.id)
      .filter(isNonEmptyString),
  );
  for (const propertyId of referencedPropertyIds(copy)) {
    if (!copyPropertyIds.has(propertyId)) errors.push(`dangling property reference: ${propertyId}`);
  }

  const originalOptionIds = new Set<string>();
  for (const property of toArray(original?.properties)) {
    for (const option of optionsOf(property)) {
      if (isNonEmptyString(option?.id)) originalOptionIds.add(option.id);
    }
  }
  const copyOptionIds = new Set<string>();
  for (const property of toArray(copy?.properties)) {
    for (const option of optionsOf(property)) {
      if (isNonEmptyString(option?.id)) copyOptionIds.add(option.id);
    }
  }
  const originalRowIds = new Set(
    toArray(original?.rows)
      .map((row) => row?.id)
      .filter(isNonEmptyString),
  );
  const copyRowIds = new Set(
    toArray(copy?.rows)
      .map((row) => row?.id)
      .filter(isNonEmptyString),
  );

  const propertyTypes = new Map<string, string>();
  for (const property of toArray(copy?.properties)) {
    if (isNonEmptyString(property?.id)) propertyTypes.set(property.id, String(property.type ?? ""));
  }

  for (const row of toArray(copy?.rows)) {
    for (const cell of toArray(row?.propertyValues)) {
      if (!isNonEmptyString(cell?.propertyId)) continue;
      const type = propertyTypes.get(cell.propertyId)?.toLowerCase() ?? "";
      const refs = valueRefs(cell.value);
      if (OPTION_TYPES.has(type)) {
        for (const ref of refs) {
          if (originalOptionIds.has(ref) && !copyOptionIds.has(ref)) {
            errors.push(`dangling option reference: ${ref}`);
          }
        }
      }
      if (RELATION_TYPES.has(type)) {
        for (const ref of refs) {
          if (originalRowIds.has(ref) && !copyRowIds.has(ref)) {
            errors.push(`dangling relation reference: ${ref}`);
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

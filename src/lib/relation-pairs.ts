/**
 * Relation pairs & rollup engine — the pure brain behind two-way relations and
 * the rollup property. Backs docs/specs/relations-rollups.md §4 rows
 * ("Relation property", single, multi, "Two-way relation", "Rollup property",
 * "Rollup functions").
 *
 * Everything here is pure and dependency-free so pairing metadata, atomic
 * two-sided link maintenance, reciprocity invariants, the rollup function
 * catalogue, aggregation math and config validation can be unit-tested without
 * a database, a browser or React. No existing relation/rollup engine is
 * touched: this module owns its own vocabulary and state shape and is strictly
 * additive.
 *
 * Vocabulary / semantics:
 *
 * - A **pair** is two `RELATION` property descriptors — one on each database —
 *   whose configs cross-reference each other (`inversePropertyId`,
 *   `targetDatabaseId`, `pairId`). `createRelationPair` derives the pairing and
 *   a deterministic, order-independent `pairId`.
 * - `cardinality: "one"` mirrors the spec's single relation (`multi: false`);
 *   `"many"` is a multi relation (`multi: true`, the default).
 * - A **state** is the *whole* relation world a caller can see: the registered
 *   pairs, the rows (with their per-property values) and the stored link lists
 *   keyed `propertyId -> rowId -> targetIds`. Every mutation returns a new
 *   state; inputs are never mutated.
 * - `linkRows` maintains **both sides atomically**. It infers the side from the
 *   `fromId` row's database, enforces single-cardinality by *replacing* the
 *   prior link (on the source side *and*, if a target row was already linked to
 *   another source, on the inverse side), de-duplicates ids, refuses
 *   self-links and reports the reciprocal writes it made as `inverseLinks`.
 * - `symmetricPairs` returns the edges that are stored in **both** directions,
 *   which is the reciprocity invariant the write path must uphold.
 * - Rollups aggregate a target property over the rows a relation links to.
 *   This module's `ROLLUP_FUNCTIONS` is the canonical named set the rollup
 *   config validates against (count / sum / average / min / max / median /
 *   join / unique / checked / percentEmpty); the persisted spec config is
 *   `{ relationPropertyId, targetPropertyId, fn, separator? }`.
 */

/** Whether a relation holds at most one link (`"one"`) or many (`"many"`). */
export type Cardinality = "one" | "many";

/** One end of a pair: the property and the database that owns it. */
export type RelationPairSide = {
  databaseId: string;
  propertyId: string;
};

/** The config a `RELATION` property carries once it is paired. */
export type RelationPropertyConfig = {
  /** The database the paired property points at (the other side's database). */
  targetDatabaseId: string;
  /** Mirror of the pair cardinality: `true` for `"many"`, `false` for `"one"`. */
  multi: boolean;
  /** The counterpart property id (reciprocal metadata). */
  inversePropertyId: string;
  /** Shared id of the pair both sides belong to. */
  pairId: string;
};

/** A `RELATION` property descriptor, as a paired config produces it. */
export type RelationPropertyDescriptor = {
  id: string;
  databaseId: string;
  type: "RELATION";
  config: RelationPropertyConfig;
};

/** Two cross-referencing relation properties. */
export type RelationPair = {
  id: string;
  cardinality: Cardinality;
  a: RelationPropertyDescriptor;
  b: RelationPropertyDescriptor;
};

/** Input for `createRelationPair`. `cardinality` defaults to `"many"`. */
export type PairSpec = {
  a: RelationPairSide;
  b: RelationPairSide;
  cardinality?: Cardinality;
};

/** A row as the engine sees it; `values` holds its per-target-property values. */
export type RelationRow = {
  id: string;
  databaseId: string;
  values?: Record<string, unknown>;
};

/** The complete relation world a mutation or rollup reads from. */
export type RelationState = {
  pairs: Record<string, RelationPair>;
  rows: Record<string, RelationRow>;
  links: Record<string, Record<string, string[]>>;
};

/** Optional seed for `createRelationState`. */
export type RelationStateInput = {
  pairs?: readonly RelationPair[];
  rows?: readonly RelationRow[];
  links?: Record<string, Record<string, readonly string[]>>;
};

/** A reciprocal write `linkRows`/`unlinkRows` performed on the far side. */
export type InverseLink = {
  propertyId: string;
  rowId: string;
  targetIds: string[];
};

/** Result of a link/unlink mutation: the new state plus the far-side writes. */
export type LinkResult = {
  state: RelationState;
  inverseLinks: InverseLink[];
};

/** Input for `linkRows`. */
export type LinkMutation = {
  fromId: string;
  toIds: readonly string[];
  pairId: string;
};

/** Input for `unlinkRows`; omitting `toIds` unlinks everything from `fromId`. */
export type UnlinkMutation = {
  fromId: string;
  toIds?: readonly string[];
  pairId: string;
};

/** One mutually-linked edge of a pair. */
export type SymmetricLink = {
  aRowId: string;
  bRowId: string;
  aPropertyId: string;
  bPropertyId: string;
};

/** A problem `validateRelationPair` can report. */
export type RelationPairIssueCode =
  | "PAIR_NOT_IN_STATE"
  | "PAIR_ID_MISMATCH"
  | "INVERSE_NOT_RECIPROCAL"
  | "TARGET_DATABASE_MISMATCH"
  | "CARDINALITY_MISMATCH"
  | "ASYMMETRIC_LINK";

/** One problem with a relation pair. */
export type RelationPairIssue = {
  code: RelationPairIssueCode;
  message: string;
};

/** The rollup functions the engine knows. */
export type RollupFn =
  | "count"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "median"
  | "join"
  | "unique"
  | "checked"
  | "percentEmpty";

/** A labelled entry in the rollup function catalogue. */
export type RollupFunctionOption = {
  id: RollupFn;
  label: string;
};

/** The canonical rollup function catalogue, in menu order. */
export const ROLLUP_FUNCTIONS: readonly RollupFunctionOption[] = [
  { id: "count", label: "Count" },
  { id: "sum", label: "Sum" },
  { id: "average", label: "Average" },
  { id: "min", label: "Min" },
  { id: "max", label: "Max" },
  { id: "median", label: "Median" },
  { id: "join", label: "Join" },
  { id: "unique", label: "Unique" },
  { id: "checked", label: "Checked" },
  { id: "percentEmpty", label: "Percent empty" },
];

const ROLLUP_FN_IDS: ReadonlySet<string> = new Set(ROLLUP_FUNCTIONS.map((fn) => fn.id));

/** The persisted rollup configuration. */
export type RollupConfig = {
  relationPropertyId: string;
  targetPropertyId: string;
  fn: RollupFn;
  /** Only meaningful for `fn: "join"`; always present, defaulting to `", "`. */
  separator: string;
};

/** What `computeRollup` found. */
export type RollupResultType = "number" | "string" | "boolean" | "null";

/** A rollup computation result. */
export type RollupResult = {
  /** The aggregated value, or `null` when there was nothing to aggregate. */
  value: number | string | boolean | null;
  /** The natural type of the aggregate. */
  type: RollupResultType;
  /** `true` when the relation linked to no rows at all. */
  empty: boolean;
};

/** Non-empty, de-duplicated string ids in first-seen order. */
function cleanIds(ids: readonly string[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** A trimmed, non-empty string id, or `""`. */
function toId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRollupFn(value: unknown): value is RollupFn {
  return typeof value === "string" && ROLLUP_FN_IDS.has(value);
}

/** A deterministic, order-independent id for a pair of property ends. */
function pairIdOf(a: RelationPairSide, b: RelationPairSide): string {
  const ends = [`${a.databaseId}#${a.propertyId}`, `${b.databaseId}#${b.propertyId}`].sort();
  return `rp_${ends[0]}__${ends[1]}`;
}

function requireSide(side: RelationPairSide): RelationPairSide {
  const databaseId = toId(side?.databaseId);
  const propertyId = toId(side?.propertyId);
  if (databaseId === "" || propertyId === "") {
    throw new Error("A relation pair needs a database id and a property id on both sides.");
  }
  return { databaseId, propertyId };
}

/**
 * Build the two cross-referencing `RELATION` descriptors of a pair:
 * `a.config.inversePropertyId === b.id`, `b.config.targetDatabaseId ===
 * a.databaseId`, both sharing a deterministic `pairId`, and `multi` mirroring
 * `cardinality` (default `"many"`). A property cannot be paired with itself.
 */
export function createRelationPair(spec: PairSpec): RelationPair {
  const a = requireSide(spec.a);
  const b = requireSide(spec.b);
  if (a.databaseId === b.databaseId && a.propertyId === b.propertyId) {
    throw new Error("A relation property cannot be paired with itself.");
  }
  const cardinality: Cardinality = spec.cardinality === "one" ? "one" : "many";
  const multi = cardinality === "many";
  const id = pairIdOf(a, b);
  const describe = (self: RelationPairSide, other: RelationPairSide): RelationPropertyDescriptor => ({
    id: self.propertyId,
    databaseId: self.databaseId,
    type: "RELATION",
    config: {
      targetDatabaseId: other.databaseId,
      multi,
      inversePropertyId: other.propertyId,
      pairId: id,
    },
  });
  return { id, cardinality, a: describe(a, b), b: describe(b, a) };
}

/** Build a state from seed lists; links are cloned and de-duplicated. */
export function createRelationState(input: RelationStateInput = {}): RelationState {
  const pairs: Record<string, RelationPair> = {};
  for (const pair of input.pairs ?? []) {
    if (pair && typeof pair.id === "string" && pair.id !== "") pairs[pair.id] = pair;
  }
  const rows: Record<string, RelationRow> = {};
  for (const row of input.rows ?? []) {
    if (row && typeof row.id === "string" && row.id !== "") rows[row.id] = row;
  }
  const links: Record<string, Record<string, string[]>> = {};
  for (const [propertyId, byRow] of Object.entries(input.links ?? {})) {
    const rowCopy: Record<string, string[]> = {};
    for (const [rowId, ids] of Object.entries(byRow)) {
      const clean = cleanIds(ids);
      if (clean.length > 0) rowCopy[rowId] = clean;
    }
    links[propertyId] = rowCopy;
  }
  return { pairs, rows, links };
}

function cloneLinks(state: RelationState): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [propertyId, byRow] of Object.entries(state.links)) {
    const rowCopy: Record<string, string[]> = {};
    for (const [rowId, ids] of Object.entries(byRow)) rowCopy[rowId] = [...ids];
    out[propertyId] = rowCopy;
  }
  return out;
}

function readLinks(
  links: Record<string, Record<string, string[]>>,
  propertyId: string,
  rowId: string,
): string[] {
  return links[propertyId]?.[rowId] ?? [];
}

function setLinks(
  links: Record<string, Record<string, string[]>>,
  propertyId: string,
  rowId: string,
  ids: string[],
): void {
  if (ids.length === 0) {
    removeLink(links, propertyId, rowId);
    return;
  }
  links[propertyId] = links[propertyId] ?? {};
  links[propertyId][rowId] = ids;
}

function removeLink(
  links: Record<string, Record<string, string[]>>,
  propertyId: string,
  rowId: string,
): void {
  const byRow = links[propertyId];
  if (!byRow || !(rowId in byRow)) return;
  delete byRow[rowId];
  if (Object.keys(byRow).length === 0) delete links[propertyId];
}

/**
 * Which side of the pair a row belongs to. Rows are matched by their database;
 * an unknown row (or an ambiguous self-relation) defaults to side `a`, unless
 * only side `b` already stores a link for it.
 */
function sideOf(state: RelationState, pair: RelationPair, rowId: string): "a" | "b" {
  const row = state.rows[rowId];
  if (row) {
    if (row.databaseId === pair.a.databaseId) return "a";
    if (row.databaseId === pair.b.databaseId) return "b";
    throw new Error("The row does not belong to either side of this relation pair.");
  }
  if (pair.a.databaseId === pair.b.databaseId) {
    const onB = readLinks(state.links, pair.b.id, rowId).length > 0;
    const onA = readLinks(state.links, pair.a.id, rowId).length > 0;
    if (onB && !onA) return "b";
  }
  return "a";
}

/**
 * Link `fromId` to `toIds` on both sides of `pairId`, atomically. Multi pairs
 * append and de-duplicate; single pairs replace the prior link (removing a
 * target row's previous source link too). Self-links, ids from the wrong
 * database and unknown pairs are ignored. Never mutates `state`; returns the
 * new state and the reciprocal writes made on the far side.
 */
export function linkRows(state: RelationState, mutation: LinkMutation): LinkResult {
  const pair = state.pairs[mutation.pairId];
  if (!pair) return { state, inverseLinks: [] };

  const side = sideOf(state, pair, mutation.fromId);
  const fromProperty = side === "a" ? pair.a.id : pair.b.id;
  const toProperty = side === "a" ? pair.b.id : pair.a.id;
  const toDatabase = side === "a" ? pair.b.databaseId : pair.a.databaseId;

  const links = cloneLinks(state);
  const current = cleanIds(readLinks(links, fromProperty, mutation.fromId));

  const requested = cleanIds(mutation.toIds).filter((id) => {
    if (id === mutation.fromId) return false;
    const row = state.rows[id];
    return !row || row.databaseId === toDatabase;
  });

  const targetIds =
    pair.cardinality === "one"
      ? requested.slice(0, 1)
      : cleanIds([...current, ...requested]);

  const inverseLinks: InverseLink[] = [];

  if (pair.cardinality === "one") {
    // A target row may already point at a different source; drop that pairing.
    for (const id of targetIds) {
      const otherSources = cleanIds(readLinks(links, toProperty, id)).filter(
        (source) => source !== mutation.fromId,
      );
      for (const otherSource of otherSources) {
        setLinks(
          links,
          fromProperty,
          otherSource,
          cleanIds(readLinks(links, fromProperty, otherSource)).filter((target) => target !== id),
        );
      }
      setLinks(
        links,
        toProperty,
        id,
        cleanIds(readLinks(links, toProperty, id)).filter((source) => source === mutation.fromId),
      );
    }
  }

  for (const removed of current.filter((id) => !targetIds.includes(id))) {
    const remaining = cleanIds(readLinks(links, toProperty, removed)).filter(
      (source) => source !== mutation.fromId,
    );
    setLinks(links, toProperty, removed, remaining);
  }

  setLinks(links, fromProperty, mutation.fromId, targetIds);

  for (const id of targetIds) {
    const list = cleanIds([...readLinks(links, toProperty, id), mutation.fromId]);
    setLinks(links, toProperty, id, list);
    inverseLinks.push({ propertyId: toProperty, rowId: id, targetIds: list });
  }
  for (const removed of current.filter((id) => !targetIds.includes(id))) {
    inverseLinks.push({
      propertyId: toProperty,
      rowId: removed,
      targetIds: readLinks(links, toProperty, removed),
    });
  }

  return { state: { ...state, links }, inverseLinks };
}

/**
 * Remove links from `fromId` on both sides of `pairId`. With `toIds` omitted
 * (or empty), every link from `fromId` is removed. Never mutates `state`;
 * returns the new state and the far-side writes.
 */
export function unlinkRows(state: RelationState, mutation: UnlinkMutation): LinkResult {
  const pair = state.pairs[mutation.pairId];
  if (!pair) return { state, inverseLinks: [] };

  const side = sideOf(state, pair, mutation.fromId);
  const fromProperty = side === "a" ? pair.a.id : pair.b.id;
  const toProperty = side === "a" ? pair.b.id : pair.a.id;

  const links = cloneLinks(state);
  const current = cleanIds(readLinks(links, fromProperty, mutation.fromId));
  const requested =
    mutation.toIds === undefined ? current : cleanIds(mutation.toIds).filter((id) => current.includes(id));
  const targets = current.filter((id) => requested.includes(id));

  for (const id of targets) {
    setLinks(
      links,
      toProperty,
      id,
      cleanIds(readLinks(links, toProperty, id)).filter((source) => source !== mutation.fromId),
    );
  }
  setLinks(
    links,
    fromProperty,
    mutation.fromId,
    current.filter((id) => !targets.includes(id)),
  );

  const inverseLinks = targets.map((id) => ({
    propertyId: toProperty,
    rowId: id,
    targetIds: readLinks(links, toProperty, id),
  }));

  return { state: { ...state, links }, inverseLinks };
}

/**
 * The edges of `pairId` that are stored in both directions, de-duplicated,
 * ordered by side-a row then side-b row. Asymmetry makes an edge disappear from
 * this list — the invariant `linkRows` preserves.
 */
export function symmetricPairs(state: RelationState, pairId: string): SymmetricLink[] {
  const pair = state.pairs[pairId];
  if (!pair) return [];
  const seen = new Set<string>();
  const out: SymmetricLink[] = [];
  for (const [aRowId, ids] of Object.entries(state.links[pair.a.id] ?? {})) {
    for (const bRowId of cleanIds(ids)) {
      if (!cleanIds(state.links[pair.b.id]?.[bRowId]).includes(aRowId)) continue;
      const key = `${aRowId}\u0000${bRowId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        aRowId,
        bRowId,
        aPropertyId: pair.a.id,
        bPropertyId: pair.b.id,
      });
    }
  }
  out.sort((left, right) =>
    left.aRowId === right.aRowId
      ? left.bRowId.localeCompare(right.bRowId)
      : left.aRowId.localeCompare(right.aRowId),
  );
  return out;
}

/**
 * Validate a rollup config against the canonical `ROLLUP_FUNCTIONS` catalogue.
 * Ids are trimmed and must be non-empty; `fn` must be a known function;
 * `separator` defaults to `", "`. Throws a descriptive error on invalid input.
 */
export function setRollupConfig(input: {
  relationPropertyId?: unknown;
  targetPropertyId?: unknown;
  fn?: unknown;
  separator?: unknown;
}): RollupConfig {
  const relationPropertyId = toId(input.relationPropertyId);
  if (relationPropertyId === "") {
    throw new Error("A rollup needs a relation property.");
  }
  const targetPropertyId = toId(input.targetPropertyId);
  if (targetPropertyId === "") {
    throw new Error("A rollup needs a target property.");
  }
  if (!isRollupFn(input.fn)) {
    throw new Error(`Unknown rollup function: ${String(input.fn)}`);
  }
  const separator = typeof input.separator === "string" ? input.separator : ", ";
  return { relationPropertyId, targetPropertyId, fn: input.fn, separator };
}

/**
 * A one-line, human-readable description of a rollup, e.g.
 * `"Average of score via a-rel"`. A join additionally names its separator.
 */
export function describeRollup(config: RollupConfig): string {
  const label = ROLLUP_FUNCTIONS.find((fn) => fn.id === config.fn)?.label ?? config.fn;
  const base = `${label} of ${config.targetPropertyId} via ${config.relationPropertyId}`;
  return config.fn === "join"
    ? `${base} (separated by ${JSON.stringify(config.separator)})`
    : base;
}

/**
 * Aggregate the target property over the rows `rowId` links to through the
 * rollup's relation. Empty/blank cells are skipped for numeric and text
 * aggregates (a boolean `false` counts as present); `count` counts linked rows,
 * and `percentEmpty` reports the blank share of the linked cells. `empty`
 * reports that the relation linked to no rows at all.
 */
export function computeRollup(
  state: RelationState,
  rowId: string,
  config: RollupConfig,
): RollupResult {
  const linked = cleanIds(readLinks(state.links, config.relationPropertyId, rowId));
  const raw = linked.map((id) => state.rows[id]?.values?.[config.targetPropertyId]);
  const present = raw.filter((value) => !isBlank(value));
  const empty = linked.length === 0;

  switch (config.fn) {
    case "count":
      return { value: linked.length, type: "number", empty };
    case "percentEmpty": {
      const total = raw.length;
      const value = total === 0 ? 0 : Math.round(((total - present.length) / total) * 100);
      return { value, type: "number", empty };
    }
    case "unique":
      return { value: new Set(present.map((value) => String(value))).size, type: "number", empty };
    case "checked":
      return { value: present.filter((value) => value === true).length, type: "number", empty };
    case "join":
      return {
        value: present.length > 0 ? present.map((value) => String(value)).join(config.separator) : null,
        type: "string",
        empty,
      };
    default: {
      const numbers = present
        .map((value) => toNumber(value))
        .filter((value): value is number => value !== null);
      if (numbers.length === 0) return { value: null, type: "number", empty };
      const sum = numbers.reduce((total, value) => total + value, 0);
      switch (config.fn) {
        case "sum":
          return { value: sum, type: "number", empty };
        case "average":
          return { value: sum / numbers.length, type: "number", empty };
        case "min":
          return { value: Math.min(...numbers), type: "number", empty };
        case "max":
          return { value: Math.max(...numbers), type: "number", empty };
        case "median": {
          const sorted = [...numbers].sort((left, right) => left - right);
          const mid = Math.floor(sorted.length / 2);
          const value =
            sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
          return { value, type: "number", empty };
        }
        default:
          return { value: null, type: "null", empty };
      }
    }
  }
}

/**
 * Check a pair's reciprocal metadata and the symmetry of its stored links.
 * Returns one issue per distinct problem (never duplicates); an empty array
 * means the pair is well-formed and its links are mutually consistent.
 */
export function validateRelationPair(state: RelationState, pair: RelationPair): RelationPairIssue[] {
  const issues = new Map<RelationPairIssueCode, string>();
  const add = (code: RelationPairIssueCode, message: string) => {
    if (!issues.has(code)) issues.set(code, message);
  };

  if (!state.pairs[pair.id]) {
    add("PAIR_NOT_IN_STATE", "The pair is not registered in the relation state.");
  }
  if (pair.a.config.pairId !== pair.id || pair.b.config.pairId !== pair.id) {
    add("PAIR_ID_MISMATCH", "Both descriptors must carry the pair's own id.");
  }
  if (
    pair.a.config.inversePropertyId !== pair.b.id ||
    pair.b.config.inversePropertyId !== pair.a.id
  ) {
    add("INVERSE_NOT_RECIPROCAL", "The inverse property ids do not cross-reference.");
  }
  if (
    pair.a.config.targetDatabaseId !== pair.b.databaseId ||
    pair.b.config.targetDatabaseId !== pair.a.databaseId
  ) {
    add("TARGET_DATABASE_MISMATCH", "Each side must target the other side's database.");
  }
  const wantsMany = pair.cardinality === "many";
  if (pair.a.config.multi !== wantsMany || pair.b.config.multi !== wantsMany) {
    add("CARDINALITY_MISMATCH", "The multi flags must mirror the pair cardinality.");
  }

  const aLinks = state.links[pair.a.id] ?? {};
  const bLinks = state.links[pair.b.id] ?? {};
  let asymmetric = false;

  for (const [aRowId, ids] of Object.entries(aLinks)) {
    const clean = cleanIds(ids);
    if (pair.cardinality === "one" && clean.length > 1) {
      add("CARDINALITY_MISMATCH", "A single relation may hold at most one link.");
    }
    for (const bRowId of clean) {
      if (!cleanIds(bLinks[bRowId]).includes(aRowId)) asymmetric = true;
    }
  }
  for (const [bRowId, ids] of Object.entries(bLinks)) {
    const clean = cleanIds(ids);
    if (pair.cardinality === "one" && clean.length > 1) {
      add("CARDINALITY_MISMATCH", "A single relation may hold at most one link.");
    }
    for (const aRowId of clean) {
      if (!cleanIds(aLinks[aRowId]).includes(bRowId)) asymmetric = true;
    }
  }
  if (asymmetric) {
    add("ASYMMETRIC_LINK", "Some links are not stored on both sides of the pair.");
  }

  return [...issues.entries()].map(([code, message]) => ({ code, message }));
}

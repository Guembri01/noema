/**
 * Relation configuration and value helpers.
 *
 * A `RELATION` property stores its shape in `Property.config` as
 *
 *   { targetDatabaseId: string | null, multi: boolean, inversePropertyId: string | null }
 *
 * and its cells as `{ pageIds: string[] }`. Both arrive from the client or from
 * older stored JSON, so every read normalises them here before the server acts
 * on them. The helpers are pure and dependency-free; the database-facing
 * actions in `src/server/actions/database.ts` own authorization and I/O.
 */

export type RelationConfig = {
  /** The database this relation points at, or `null` when unconfigured. */
  targetDatabaseId: string | null;
  /** `false` means "at most one linked row"; old configs default to `true`. */
  multi: boolean;
  /** The reciprocal property on the target database, or `null` for one-way. */
  inversePropertyId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id === "" ? null : id;
}

/**
 * Coerce an untrusted relation config into the canonical shape.
 *
 * - Missing/blank ids become `null`.
 * - `multi` defaults to `true` (the behaviour of every pre-R21 config); only a
 *   literal `false` disables multi-select.
 * - A JSON string is parsed, so a legacy serialized config normalises too.
 *
 * Idempotent and never throws.
 */
export function normalizeRelationConfig(raw: unknown): RelationConfig {
  let source: unknown = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = null;
    }
  }
  const record = isRecord(source) ? source : {};
  return {
    targetDatabaseId: idOrNull(record.targetDatabaseId),
    multi: record.multi !== false,
    inversePropertyId: idOrNull(record.inversePropertyId),
  };
}

/**
 * The stored cell shape as a clean id list.
 *
 * Returns `null` when `raw` is not a `{ pageIds: [...] }` object at all, so a
 * caller can refuse a malformed value instead of silently treating it as empty.
 * Blank and non-string entries are dropped, ids are de-duplicated in first-seen
 * order, and a single-cardinality relation is clamped to its first id.
 */
export function normalizeRelationPageIds(
  raw: unknown,
  multi: boolean,
): string[] | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.pageIds)) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw.pageIds) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (!multi) break;
  }
  return ids;
}

/** Keep only ids that a validated target query still resolves. */
export function pruneRelationIds(
  ids: readonly string[],
  valid: ReadonlySet<string>,
): string[] {
  return ids.filter((id) => valid.has(id));
}

/**
 * The next value of the reciprocal cell when `sourceRowId` is added to or
 * removed from one target row.
 *
 * The result is always a clean, de-duplicated list. A single-cardinality
 * reciprocal replaces its previous source instead of accumulating; removing a
 * source is a no-op when it was not there.
 */
export function nextInversePageIds(
  current: unknown,
  sourceRowId: string,
  action: "add" | "remove",
  multi: boolean,
): string[] {
  const parsed = normalizeRelationPageIds(current, true) ?? [];
  if (action === "remove") return parsed.filter((id) => id !== sourceRowId);
  if (!multi) return [sourceRowId];
  return parsed.includes(sourceRowId) ? parsed : [...parsed, sourceRowId];
}

/**
 * Group source links by target row for a two-way backfill.
 *
 * `existing` is the reciprocal cell map already stored on the target database
 * (usually empty when the pair is created). Incoming links are merged after it,
 * de-duplicated, and clamped when the reciprocal side is single.
 */
export function buildInverseBackfill(input: {
  links: readonly { sourceRowId: string; targetRowId: string }[];
  existing?: Readonly<Record<string, readonly string[]>>;
  multi: boolean;
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [targetRowId, sourceIds] of Object.entries(input.existing ?? {})) {
    const ids = normalizeRelationPageIds({ pageIds: [...sourceIds] }, input.multi) ?? [];
    if (ids.length > 0) out[targetRowId] = ids;
  }
  for (const link of input.links) {
    const current = out[link.targetRowId] ?? [];
    const next = nextInversePageIds(
      { pageIds: current },
      link.sourceRowId,
      "add",
      input.multi,
    );
    out[link.targetRowId] = next;
  }
  return out;
}

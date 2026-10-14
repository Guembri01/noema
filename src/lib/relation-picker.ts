/**
 * Relation picker — the pure brain behind the relation cell's searchable page
 * picker (docs/specs/relations-rollups.md R21.5) and the reciprocal write a
 * two-way relation needs (R21.7/R21.9). Backs FEATURE_MATRIX rows 290-293
 * ("Relation property/single/multi/two-way") and :727.
 *
 * Everything here is pure and dependency-free so the picker's search/exclude
 * rules, the single/multi toggle, the a11y label and the two-way propagation
 * can be unit-tested without a database, a browser or React.
 *
 * Semantics:
 *
 * - `queryRelationCandidates` narrows the target rows the picker offers. It
 *   matches the title case-insensitively, hides ids the row already links to
 *   unless multi-select keeps them visible so they can be unchecked, always
 *   drops the row itself (self-relation), de-duplicates by id and honours a
 *   result cap.
 * - `toggleRelation` applies one pick: multi mode appends, single mode
 *   replaces; a second pick on an existing id removes it. Inputs are never
 *   mutated and blank/duplicate ids are cleaned.
 * - `relationSummary` renders "N related page(s): …" for an aria label,
 *   falling back to the raw id for a dangling link.
 * - `applyTwoWayRelation` returns the pair of member lists both sides of a
 *   two-way relation must store so each lists the other — the exchange is its
 *   own inverse.
 */

/** Whether a relation property is one-way or has a reciprocal counterpart. */
export type RelationType = "one-way" | "two-way";

/** One row of the target database, as the picker renders it. */
export type RelationCandidate = {
  id: string;
  title: string;
  /** Present when the picker is choosing the relation's own type. */
  relationType?: RelationType;
};

/** The picker's current filter state. */
export type RelationPickerQuery = {
  /** Typeahead text; blank or absent means "no filter". */
  query?: string;
  /** Ids the source row already links to. */
  excludeIds?: readonly string[];
  /** Maximum results; a negative or absent value means no cap. */
  limit?: number;
  /** Multi-select keeps already-linked rows visible so they can be unchecked. */
  allowMultiple?: boolean;
  /** The source row's own id, never offered (self-relation). */
  selfId?: string;
};

/** Options for a single pick. */
export type RelationToggle = {
  allowMultiple: boolean;
};

/** The two member lists a two-way relation stores on either side. */
export type TwoWayRelation = {
  sourceIds: string[];
  targetIds: string[];
};

/** Non-empty, de-duplicated ids in first-seen order. */
function cleanIds(ids: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (!Array.isArray(ids)) return out;
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Narrow the picker's candidates. Order is preserved; the first candidate wins
 * a duplicate id. `excludeIds` are hidden when picking a single link, but kept
 * in multi-select mode (rendered as checked) so an existing link stays
 * reachable to unlink; the source row (`selfId`) is dropped in both modes.
 */
export function queryRelationCandidates(
  candidates: readonly RelationCandidate[],
  options: RelationPickerQuery = {},
): RelationCandidate[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const excluded = new Set(cleanIds(options.excludeIds));
  const allowMultiple = options.allowMultiple === true;
  const limit = options.limit;
  const cap =
    typeof limit === "number" && Number.isFinite(limit) && limit >= 0
      ? Math.floor(limit)
      : Number.POSITIVE_INFINITY;

  if (cap <= 0) return [];

  const seen = new Set<string>();
  const out: RelationCandidate[] = [];
  for (const candidate of candidates) {
    if (typeof candidate.id !== "string" || candidate.id.length === 0) continue;
    if (candidate.id === options.selfId) continue;
    if (!allowMultiple && excluded.has(candidate.id)) continue;
    if (seen.has(candidate.id)) continue;
    const title = typeof candidate.title === "string" ? candidate.title : "";
    if (query.length > 0 && !title.toLowerCase().includes(query)) continue;
    seen.add(candidate.id);
    out.push(candidate);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Apply one pick to the current selection. Multi mode appends, single mode
 * replaces; picking an already-selected id removes it. A blank id is a no-op.
 * The returned array is fresh — the input is never mutated — and duplicates or
 * empty entries in the input are cleaned.
 */
export function toggleRelation(
  current: readonly string[],
  id: string,
  options: RelationToggle,
): string[] {
  const clean = cleanIds(current);
  if (typeof id !== "string" || id.length === 0) return clean;
  if (clean.includes(id)) return clean.filter((existing) => existing !== id);
  if (options.allowMultiple) return [...clean, id];
  return [id];
}

/**
 * A human-readable label for the current selection, e.g. `"No related pages"`,
 * `"1 related page: Alpha"`, `"2 related pages: Alpha, Beta"`. An id with no
 * `byId` entry falls back to the id itself, so a dangling link stays visible
 * rather than silently disappearing.
 */
export function relationSummary(
  ids: readonly string[],
  byId: ReadonlyMap<string, { readonly title: string }>,
): string {
  const names = cleanIds(ids).map((id) => {
    const title = byId.get(id)?.title;
    return typeof title === "string" && title.length > 0 ? title : id;
  });
  if (names.length === 0) return "No related pages";
  const noun = names.length === 1 ? "related page" : "related pages";
  return `${names.length} ${noun}: ${names.join(", ")}`;
}

/**
 * The reciprocal write for a two-way relation: the source side stores the
 * target ids and the target side stores the source ids, so each lists the
 * other. Both sides are cleaned and de-duplicated; applying the result twice
 * restores the cleaned inputs. Inputs are never mutated.
 */
export function applyTwoWayRelation(
  sourceIds: readonly string[],
  targetIds: readonly string[],
): TwoWayRelation {
  return { sourceIds: cleanIds(targetIds), targetIds: cleanIds(sourceIds) };
}

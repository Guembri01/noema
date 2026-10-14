/**
 * Block-level Suggestions mode (docs/MISSING_FEATURES.md §7 — "Suggestions
 * mode" / "Accept/reject suggestion", read-only "propose edits for approval").
 *
 * Pure logic: no Prisma, routes, or React. A `Suggestion` is one block-level
 * edit (`insert` / `delete` / `replace`) matched by block id, so the same model
 * can drive the future diff-overlay UI, an accept/reject action, and
 * persistence without dragging any of them in here.
 *
 * The block-level (`not` character-level) granularity mirrors
 * `src/lib/version-history.ts:diffVersions`, which is consulted for the
 * added / removed / changed split; Suggestions additionally keep the concrete
 * `before` / `after` blocks and an insertion anchor so an accept can rebuild the
 * proposed document exactly. `diffVersions` reports ids only (its `changed`
 * also folds in reordering via `moved`), so the tiny id-set diff below is kept
 * local instead of threading snapshot parsing through this model.
 */

/** One page block: a stable `id` plus its (TipTap-ish) type/text content. */
export type Block = { id: string; type?: string; text?: string };

export type SuggestionKind = "insert" | "delete" | "replace";

/**
 * A single proposed block-level edit.
 *
 * - `insert`  — `blockId` is the new block's id, `after` its content, and
 *               `before` (when present) the surviving block it follows. No
 *               `before` means "at the very start of the document".
 * - `delete`  — `blockId` is the removed block's id, `before` its old content.
 * - `replace` — `blockId` is the edited block's id, `before` / `after` the old
 *               and new content.
 *
 * `id` is deterministic (see {@link createSuggestions}) so tests and persisted
 * rows stay stable.
 */
export type Suggestion = {
  id: string;
  blockId: string;
  kind: SuggestionKind;
  before?: Block;
  after?: Block;
  authorId?: string;
};

export type CreateSuggestionsOptions = {
  /** Stamped onto every produced suggestion (R? — collaborative review). */
  authorId?: string;
  /** Override the deterministic `${kind}:${blockId}` id. */
  idFactory?: (kind: SuggestionKind, blockId: string) => string;
};

function sameBlockContent(left: Block, right: Block): boolean {
  return (left.type ?? null) === (right.type ?? null) && (left.text ?? null) === (right.text ?? null);
}

/** First occurrence of each id wins — stable ids are unique, dedupe defensively. */
function indexById(blocks: readonly Block[]): Map<string, number> {
  const index = new Map<string, number>();
  blocks.forEach((block, position) => {
    if (!index.has(block.id)) index.set(block.id, position);
  });
  return index;
}

type Draft = { key: number; order: number; suggestion: Suggestion };

/**
 * Diff two block lists into a minimal, ordered edit list.
 *
 * Matching is by `id`: a proposed id absent from the base is an `insert`, a base
 * id absent from the proposed is a `delete`, and an id present in both whose
 * type/text changed is a `replace`. Unchanged blocks — and pure reorderings,
 * which this kind-set has no way to express — produce no suggestions.
 *
 * The returned list is ordered in document (target) order: inserts/replaces at
 * their proposed position, deletes pinned just before the next surviving block.
 * The order is cosmetic for {@link applySuggestions} (application is id/anchor
 * based) but keeps the list readable for the overlay.
 */
export function createSuggestions(
  baseBlocks: readonly Block[],
  proposedBlocks: readonly Block[],
  options: CreateSuggestionsOptions = {},
): Suggestion[] {
  const makeId =
    options.idFactory ?? ((kind: SuggestionKind, blockId: string) => `${kind}:${blockId}`);
  const authorId = options.authorId;

  const baseIndex = indexById(baseBlocks);
  const proposedIndex = indexById(proposedBlocks);

  const removed = new Set<string>();
  baseIndex.forEach((_, id) => {
    if (!proposedIndex.has(id)) removed.add(id);
  });

  const drafts: Draft[] = [];
  let order = 0;

  // Deletes, in base order, keyed just before the next surviving base block.
  baseIndex.forEach((basePosition, id) => {
    if (!removed.has(id)) return;
    let key = proposedBlocks.length;
    for (const [otherId, otherPosition] of baseIndex) {
      if (otherPosition <= basePosition || removed.has(otherId)) continue;
      const target = proposedIndex.get(otherId);
      if (target !== undefined && target < key) key = target - 0.5;
    }
    const block = baseBlocks[basePosition];
    drafts.push({
      key,
      order: order++,
      suggestion: { id: makeId("delete", id), blockId: id, kind: "delete", before: block },
    });
  });

  // Inserts / replaces, in proposed order; track the nearest surviving anchor.
  let anchorId: string | undefined;
  proposedIndex.forEach((proposedPosition, id) => {
    const block = proposedBlocks[proposedPosition];
    const basePosition = baseIndex.get(id);
    if (basePosition === undefined) {
      drafts.push({
        key: proposedPosition,
        order: order++,
        suggestion: {
          id: makeId("insert", id),
          blockId: id,
          kind: "insert",
          ...(anchorId === undefined ? {} : { before: baseBlocks[baseIndex.get(anchorId)!] }),
          after: block,
        },
      });
      return;
    }
    if (!removed.has(id)) anchorId = id;
    if (!sameBlockContent(baseBlocks[basePosition], block)) {
      drafts.push({
        key: proposedPosition,
        order: order++,
        suggestion: {
          id: makeId("replace", id),
          blockId: id,
          kind: "replace",
          before: baseBlocks[basePosition],
          after: block,
        },
      });
    }
  });

  drafts.sort((left, right) => left.key - right.key || left.order - right.order);
  return drafts.map((draft) => {
    const suggestion = draft.suggestion;
    return authorId === undefined ? suggestion : { ...suggestion, authorId };
  });
}

/**
 * Apply (or reject) a set of suggestions against `blocks`, immutably.
 *
 * `reject` returns a copy of the base untouched. `accept` rebuilds the proposed
 * document: deleted ids are dropped, replaced ids take their `after` block, and
 * inserts are emitted after their `before` anchor (or at the start when absent).
 * Because a delete keeps its anchor slots, accept-all of a list produced by
 * {@link createSuggestions} reconstructs the proposed document exactly.
 */
export function applySuggestions(
  blocks: readonly Block[],
  suggestions: readonly Suggestion[],
  mode: "accept" | "reject",
): Block[] {
  if (mode === "reject") return blocks.slice();

  const deleted = new Set<string>();
  const replaced = new Map<string, Block>();
  const insertsAfterStart: Block[] = [];
  const insertsAfter = new Map<string, Block[]>();
  const consumedAnchors = new Set<string>();

  for (const suggestion of suggestions) {
    if (suggestion.kind === "delete") {
      deleted.add(suggestion.blockId);
    } else if (suggestion.kind === "replace" && suggestion.after) {
      replaced.set(suggestion.blockId, suggestion.after);
    } else if (suggestion.kind === "insert" && suggestion.after) {
      const anchor = suggestion.before?.id;
      if (anchor === undefined) {
        insertsAfterStart.push(suggestion.after);
      } else {
        const bucket = insertsAfter.get(anchor);
        if (bucket) bucket.push(suggestion.after);
        else insertsAfter.set(anchor, [suggestion.after]);
      }
    }
  }

  const result: Block[] = insertsAfterStart.slice();
  for (const block of blocks) {
    if (!deleted.has(block.id)) result.push(replaced.get(block.id) ?? block);
    const anchored = insertsAfter.get(block.id);
    if (anchored) {
      consumedAnchors.add(block.id);
      result.push(...anchored);
    }
  }

  // Defensive: an anchor that never matched (e.g. a hand-built suggestion
  // pointing at another inserted block) still lands, at the end, rather than
  // being silently dropped.
  const leftovers: Block[] = [];
  insertsAfter.forEach((bucket, anchor) => {
    if (!consumedAnchors.has(anchor)) leftovers.push(...bucket);
  });
  return leftovers.length > 0 ? [...result, ...leftovers] : result;
}

/** Apply a single suggestion — a thin wrapper over {@link applySuggestions}. */
export function applyOne(
  blocks: readonly Block[],
  suggestion: Suggestion,
  mode: "accept" | "reject",
): Block[] {
  return applySuggestions(blocks, [suggestion], mode);
}

/**
 * Number of unresolved suggestions. Every entry in a suggestion list is pending
 * until accept/reject removes it, so this is the list length — kept as a helper
 * so the UI badge and the unit harness share one definition.
 */
export function pendingCount(suggestions: readonly Suggestion[]): number {
  return suggestions.length;
}

/** JSON-safe serialization (stable for equal input). */
export function serialize(suggestions: readonly Suggestion[]): string {
  return JSON.stringify(suggestions);
}

function isSuggestion(value: unknown): value is Suggestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.blockId === "string" &&
    (candidate.kind === "insert" || candidate.kind === "delete" || candidate.kind === "replace")
  );
}

/**
 * Decode a serialized suggestion list defensively: unparseable JSON or a
 * non-array payload yields `[]`, and malformed entries are skipped — the
 * overlay degrades instead of throwing.
 */
export function deserialize(json: string): Suggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const result: Suggestion[] = [];
  for (const item of parsed) {
    if (!isSuggestion(item)) continue;
    const suggestion: Suggestion = {
      id: item.id,
      blockId: item.blockId,
      kind: item.kind,
    };
    if (item.before) suggestion.before = item.before;
    if (item.after) suggestion.after = item.after;
    if (item.authorId !== undefined) suggestion.authorId = item.authorId;
    result.push(suggestion);
  }
  return result;
}

/**
 * Suggestions attributed to `authorId`. Passing `undefined`/`null` selects the
 * anonymous bucket, which is how a plain (unattributed) review session is
 * filtered apart from real authors.
 */
export function filterByAuthor(
  suggestions: readonly Suggestion[],
  authorId: string | null | undefined,
): Suggestion[] {
  if (authorId === undefined || authorId === null) {
    return suggestions.filter(
      (suggestion) => suggestion.authorId === undefined || suggestion.authorId === null,
    );
  }
  return suggestions.filter((suggestion) => suggestion.authorId === authorId);
}

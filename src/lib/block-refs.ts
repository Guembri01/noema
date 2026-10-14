/**
 * Synced blocks and block references (docs/MISSING_FEATURES.md §1).
 *
 * A synced block mirrors another block's subtree: the canonical block is the
 * *source* and every place that displays it holds a *reference* — a block
 * carrying `refBlockId` (singular) or `refBlockIds` (array). Everything here
 * is pure: no DB, no React. The tree is the minimal shared shape
 * `{ id, type, children? }`; any extra fields (`text`, `attrs`, …) are
 * preserved untouched because all copying is a generic deep clone.
 *
 * Traversal is depth-first in document order, which makes every result
 * deterministic. Where id order matters (cycle hunting, dangling lists) ids
 * are compared lexicographically.
 */

/** Minimal block tree node; unknown fields are carried through verbatim. */
export type Block = {
  id: string;
  type: string;
  children?: Block[];
  /** Reference to a single source block id. */
  refBlockId?: string;
  /** References to several source block ids. */
  refBlockIds?: string[];
  [key: string]: unknown;
};

/** A flat view of a document: every block and who its parent is. */
export type BlockIndex = {
  /** id → block. First occurrence wins when ids collide. */
  byId: Map<string, Block>;
  /** id → parent id, or `null` for a root block. */
  parentOf: Map<string, string | null>;
};

/** One block's outgoing references, in declaration order and deduped. */
export type ReferenceEntry = {
  blockId: string;
  refBlockIds: string[];
};

/** The result of `copyReference`: a fresh reference node plus its mirrored content. */
export type ReferenceCopy = {
  /** The reference block to insert (`type: "block_ref"`). */
  ref: Block;
  /** An independent clone of the source subtree, or `null` when the source is gone. */
  subtree: Block | null;
};

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Depth-first, document-order walk. */
function walkBlocks(doc: readonly Block[], visit: (block: Block, parentId: string | null) => void): void {
  const visitLevel = (blocks: readonly Block[], parentId: string | null): void => {
    for (const block of blocks) {
      visit(block, parentId);
      if (block.children?.length) visitLevel(block.children, block.id);
    }
  };
  visitLevel(doc, null);
}

/** Generic deep clone that keeps every own field, including `undefined`. */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneValue(item);
    return clone as T;
  }
  return value;
}

/** A deep, independent copy of a block subtree. */
function cloneBlock(block: Block): Block {
  return cloneValue(block);
}

/** The deduped, ordered reference targets declared on a single block. */
function referenceIdsOf(block: Block): string[] {
  const ids: string[] = [];
  const push = (id: unknown): void => {
    if (typeof id !== "string" || id === "" || ids.includes(id)) return;
    ids.push(id);
  };
  push(block.refBlockId);
  if (Array.isArray(block.refBlockIds)) for (const id of block.refBlockIds) push(id);
  return ids;
}

/**
 * Flatten a document into an O(1) lookup of blocks and parents. Blocks are
 * visited depth-first in document order; on an id collision the first block
 * wins so lookups stay deterministic.
 */
export function collectBlocks(doc: readonly Block[]): BlockIndex {
  const index: BlockIndex = { byId: new Map(), parentOf: new Map() };
  walkBlocks(doc, (block, parentId) => {
    if (index.byId.has(block.id)) return;
    index.byId.set(block.id, block);
    index.parentOf.set(block.id, parentId);
  });
  return index;
}

/**
 * Every block that references at least one other block, in document order.
 * Both `refBlockId` and `refBlockIds` are read; a block that declares the same
 * target twice reports it once. Blocks without references are omitted.
 */
export function extractReferences(doc: readonly Block[]): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  walkBlocks(doc, (block) => {
    const refBlockIds = referenceIdsOf(block);
    if (refBlockIds.length > 0) entries.push({ blockId: block.id, refBlockIds });
  });
  return entries;
}

/**
 * A deep clone of the subtree rooted at `blockId`, or `null` when the id is
 * unknown. The clone is fully independent — mutating it never touches the
 * document. To resolve a reference, pass its `refBlockId`.
 */
export function resolveSynced(doc: readonly Block[], blockId: string): Block | null {
  const source = collectBlocks(doc).byId.get(blockId);
  return source ? cloneBlock(source) : null;
}

/**
 * Every concrete reference cycle, as id paths with the start repeated last
 * (`["a", "b", "a"]`; a self reference is `["a", "a"]`).
 *
 * Each elementary cycle is reported once: the search only extends through ids
 * greater than the start id, so a cycle is always emitted from its smallest
 * member. Dangling references cannot form a cycle and are ignored. Cycles are
 * ordered by their smallest id.
 */
export function detectReferenceCycles(doc: readonly Block[]): string[][] {
  const index = collectBlocks(doc);
  const adjacency = new Map<string, string[]>();
  for (const entry of extractReferences(doc)) {
    adjacency.set(
      entry.blockId,
      entry.refBlockIds.filter((id) => index.byId.has(id)).sort(byId),
    );
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();
  for (const start of [...index.byId.keys()].sort(byId)) {
    const path: string[] = [start];
    const onPath = new Set<string>([start]);
    const walkFrom = (node: string): void => {
      for (const next of adjacency.get(node) ?? []) {
        if (next === start) {
          const cycle = [...path, start];
          const key = cycle.join("\u0000");
          if (seen.has(key)) continue;
          seen.add(key);
          cycles.push(cycle);
        } else if (next > start && !onPath.has(next)) {
          path.push(next);
          onPath.add(next);
          walkFrom(next);
          path.pop();
          onPath.delete(next);
        }
      }
    };
    walkFrom(start);
  }
  return cycles;
}

/** Does this block point at `sourceBlockId` through either reference field? */
function referencesSource(block: Block, sourceBlockId: string): boolean {
  return (
    block.refBlockId === sourceBlockId ||
    (Array.isArray(block.refBlockIds) && block.refBlockIds.includes(sourceBlockId))
  );
}

/**
 * Materialise an updated source into every mirror. Each block that references
 * `sourceBlockId` is replaced by its own fresh deep copy of `updatedSubtree`,
 * carrying the updated subtree's ids.
 *
 * Always returns a **new** document — the input is never mutated, and each
 * mirror is independent from the others. When `sourceBlockId` is not present
 * the call is a no-op (still an independent deep clone).
 */
export function replaceSyncedMirrors(
  doc: readonly Block[],
  sourceBlockId: string,
  updatedSubtree: Block,
): Block[] {
  const cloned = doc.map((block) => cloneBlock(block));
  if (!collectBlocks(doc).byId.has(sourceBlockId)) return cloned;

  const replaceIn = (blocks: Block[]): Block[] =>
    blocks.map((block) => {
      if (referencesSource(block, sourceBlockId)) return cloneBlock(updatedSubtree);
      if (block.children?.length) return { ...block, children: replaceIn(block.children) };
      return block;
    });
  return replaceIn(cloned);
}

/**
 * Build the pair used to paste a synced block: a `block_ref` node pointing at
 * `sourceBlockId` plus an independent clone of that block's subtree (`null`
 * when the source no longer exists). The node id is derived deterministically
 * from the source so callers can re-id it when inserting.
 */
export function copyReference(sourceDoc: readonly Block[], sourceBlockId: string): ReferenceCopy {
  const source = collectBlocks(sourceDoc).byId.get(sourceBlockId);
  return {
    ref: { id: `${sourceBlockId}:ref`, type: "block_ref", refBlockId: sourceBlockId },
    subtree: source ? cloneBlock(source) : null,
  };
}

/** Referenced ids that are not present in the document, deduped and sorted. */
export function missingReferences(doc: readonly Block[]): string[] {
  const index = collectBlocks(doc);
  const missing = new Set<string>();
  for (const entry of extractReferences(doc)) {
    for (const id of entry.refBlockIds) {
      if (!index.byId.has(id)) missing.add(id);
    }
  }
  return [...missing].sort(byId);
}

/**
 * Move blocks between pages — the pure engine behind "Drag to another page"
 * and the multi-block selection move (docs/MISSING_FEATURES.md §1; range edges
 * spec'd in docs/specs/editor-deep.md R84.10-R84.11).
 *
 * A page's body is modelled as a shallow document — a page `{ id, blocks }`
 * whose top-level `blocks` may nest sub-blocks under `children` (a list carries
 * its items, a toggle carries its body). Everything here is data in / data out:
 * no DOM, no ProseMirror, no DB, no clock. Inputs are never mutated; every
 * function that changes something returns fresh, fully independent clones.
 *
 * The pieces the drag-and-drop path composes:
 *
 * - {@link extractRange} — take the half-open top-level range `[start, end)`
 *   out of a page, clamps the bounds, never separates a run of sibling list
 *   items from itself, and returns the moved subtree plus the page that is
 *   left behind.
 * - {@link insertBlocks} — splice blocks into a page at a clamped index.
 * - {@link collectBacklinks} — references held by the blocks *left behind*
 *   that point at a moving block (block refs and inline mentions alike).
 * - {@link moveBlocks} — the whole cross-page move, minting fresh ids where a
 *   moving id would collide with the destination and remapping the references
 *   that stay internal to the moving set. Cross-references that the move
 *   strands are returned as warnings.
 * - {@link planBlockMove} / {@link describeMove} — the ordered op list and the
 *   human summary a surface shows in a toast or on a plan row.
 * - {@link isSamePage} / {@link validateMove} — the cheap guards (same page,
 *   out-of-range, empty selection, dropping into your own span).
 *
 * Determinism: ids are only ever minted through an injected {@link IdFactory},
 * so tests pass a sequential factory and get replayable output.
 */

/** Minimal inline node — enough to find `mention` atoms and walk them. */
export type InlineNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: InlineNode[];
  [key: string]: unknown;
};

/** A block (or nested block) in a page body; unknown fields are carried through. */
export type MoveBlock = {
  id: string;
  type: string;
  /** Nested blocks — a list's items, a toggle's body, … */
  children?: MoveBlock[];
  /** Inline content; `mention` atoms carry their target in `attrs.id`. */
  content?: InlineNode[];
  /** Reference to a single block id (synced block / block link). */
  refBlockId?: string;
  /** References to several block ids. */
  refBlockIds?: string[];
  /** Explicit page-link target (the `@`-picker node). */
  pageLinkId?: string;
  /** Link destination; internal `/page/<id>` links count as page links. */
  href?: string;
  [key: string]: unknown;
};

/** A page and its body blocks — the unit a move operates on. */
export type BlockPage = {
  id: string;
  blocks: MoveBlock[];
  [key: string]: unknown;
};

/** Half-open top-level range: selects `[startIndex, endIndex)`. */
export type BlockRange = { startIndex: number; endIndex: number };

/** Result of {@link extractRange}: the moved subtree and the remaining page. */
export type ExtractRangeResult = { moved: MoveBlock[]; remaining: BlockPage };

/** A page reference that {@link isSamePage} can compare: an object with `id` or a bare id. */
export type PageRef = { id?: string } | string | null | undefined;

/** Everything needed to reorder inside a selection. */
export type MoveSelection = {
  /** Top-level indices in the source page; duplicates and out-of-range entries are ignored. */
  indices: readonly number[];
  /** Insertion index in the destination page; clamped into range. */
  targetIndex?: number;
};

/** The source/destination pair of a move. */
export type MovePair = { from: BlockPage; to: BlockPage };

/** Allocates one fresh block id per call. */
export type IdFactory = () => string;

/** Tuning for {@link moveBlocks}. */
export type MoveOptions = {
  /** Fresh-id allocator; defaults to {@link defaultMoveIdFactory}. */
  idFactory?: IdFactory;
};

/**
 * A cross-reference the move leaves dangling.
 * `code: "backlink"` — a block left behind points at a moved block;
 * `code: "reference"` — a moved block points at a block left behind.
 */
export type MoveWarning = {
  code: "backlink" | "reference";
  /** The moved block involved. */
  blockId: string;
  /** The block left behind (the referrer for a backlink, the target for a reference). */
  relatedBlockId: string;
};

/** One incoming reference into a moving block. */
export type BlockBacklink = { blockId: string; sourceBlockId: string };

/** Result of {@link moveBlocks}. */
export type MoveResult = {
  /** Source page with the moved blocks removed. */
  fromDoc: BlockPage;
  /** Destination page with the moved blocks inserted. For a same-page move this equals `fromDoc`. */
  toDoc: BlockPage;
  /** old → new ids, only for blocks whose id had to be re-minted. */
  idMap: Map<string, string>;
  /** Cross-references the move strands, sorted. */
  warnings: MoveWarning[];
};

/** Outcome of {@link validateMove}; `ok` is true exactly when `errors` is empty. */
export type MoveValidation = { ok: boolean; errors: string[] };

/** Input to {@link validateMove}. */
export type ValidateMoveInput = {
  doc: BlockPage;
  indices: readonly number[];
  /** Optional insertion index, checked against the source document's length. */
  targetIndex?: number;
};

/** Input to {@link planBlockMove}. */
export type PlanBlockMoveInput = {
  doc: BlockPage;
  indices: readonly number[];
  targetPageId: string;
  targetIndex?: number;
  /** Human label for the destination, used by {@link describeMove}. */
  targetTitle?: string;
};

/** One ordered step of a move plan. */
export type MoveOp =
  | { op: "remove"; pageId: string; indices: number[]; count: number }
  | { op: "insert"; pageId: string; index: number; count: number };

/** The ordered operations and their caveats for a planned move. */
export type MovePlan = {
  /** Ordered ops (a `remove` then an `insert`), or `[]` when the move is invalid. */
  ops: MoveOp[];
  warnings: MoveWarning[];
  errors: string[];
  count: number;
  targetPageId: string;
  targetIndex: number;
  targetLabel: string;
};

const ITEM_TYPES = new Set(["listItem", "taskItem"]);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

let defaultCounter = 0;

/**
 * Default id factory: fresh, collision-resistant block ids. Randomised so two
 * moves in the same process never share an id; callers that need determinism
 * pass their own {@link IdFactory}.
 */
export function defaultMoveIdFactory(): string {
  defaultCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `block_${defaultCounter.toString(36)}_${random}`;
}

/** Truncate to an integer and clamp into `0..length`; non-finite input floors to 0. */
function clampIndex(value: unknown, length: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(length, n));
}

/** Valid, deduped, ascending top-level indices within `0..length - 1`. */
function normalizeIndices(indices: readonly number[], length: number): number[] {
  const seen = new Set<number>();
  for (const raw of indices) {
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n < 0 || n >= length) continue;
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** `true` when every adjacent pair differs by exactly one. */
function isContiguous(sorted: readonly number[]): boolean {
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}

/** Generic deep clone that keeps every own field, `undefined` included. */
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
function cloneBlock(block: MoveBlock): MoveBlock {
  return cloneValue(block);
}

/**
 * Widen `[start, end)` so a run of sibling list items is never cut in half.
 * A boundary is only extended when the boundary block itself is a list item,
 * so selecting a paragraph between two items does not drag the items along.
 */
function expandSiblingItems(
  blocks: readonly MoveBlock[],
  start: number,
  end: number,
): [number, number] {
  if (start >= end) return [start, end];
  const isItem = (index: number): boolean =>
    index >= 0 && index < blocks.length && ITEM_TYPES.has(blocks[index]?.type);
  let from = start;
  let to = end;
  if (isItem(from)) while (isItem(from - 1)) from -= 1;
  if (isItem(to - 1)) while (isItem(to)) to += 1;
  return [from, to];
}

/** Collect every id in a block forest (including `children`). */
function collectIds(blocks: readonly MoveBlock[] | undefined, out: Set<string>): void {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block && typeof block.id === "string" && block.id !== "") out.add(block.id);
    collectIds(block?.children, out);
  }
}

/** Distinct `attrs.id` values of every `mention` atom in inline content. */
function collectMentionIds(nodes: readonly InlineNode[] | undefined, out: string[]): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node) continue;
    if (node.type === "mention") {
      const id = node.attrs?.id;
      if (typeof id === "string" && id !== "" && !out.includes(id)) out.push(id);
    }
    collectMentionIds(node.content, out);
  }
}

/** Every block id a block points at: `refBlockId`(s) and inline block mentions. */
function referenceIdsOf(block: MoveBlock): string[] {
  const ids: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !ids.includes(value)) ids.push(value);
  };
  push(block.refBlockId);
  if (Array.isArray(block.refBlockIds)) for (const id of block.refBlockIds) push(id);
  const mentions: string[] = [];
  collectMentionIds(block.content, mentions);
  for (const id of mentions) push(id);
  return ids;
}

/**
 * Take the half-open top-level range `[startIndex, endIndex)` out of `doc`.
 *
 * Bounds are truncated and clamped into `0..blocks.length`; a reversed range is
 * empty. A boundary that would split a run of sibling list items is widened to
 * the whole run. `moved` and `remaining` are independent deep clones.
 */
export function extractRange(doc: BlockPage, range: BlockRange): ExtractRangeResult {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const length = blocks.length;
  const start = clampIndex(range?.startIndex, length);
  const rawEnd = clampIndex(range?.endIndex, length);
  const end = rawEnd < start ? start : rawEnd;
  const [from, to] = expandSiblingItems(blocks, start, end);
  const moved = blocks.slice(from, to).map(cloneBlock);
  const remainingBlocks = [...blocks.slice(0, from), ...blocks.slice(to)].map(cloneBlock);
  return { moved, remaining: { ...doc, id: doc?.id, blocks: remainingBlocks } };
}

/**
 * Insert `blocks` into `doc` at `index`, clamped into `0..blocks.length`. The
 * inserted blocks are deep clones; the input page and blocks are untouched.
 */
export function insertBlocks(doc: BlockPage, blocks: readonly MoveBlock[], index: number): BlockPage {
  const existing = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const at = clampIndex(index, existing.length);
  const inserted = (Array.isArray(blocks) ? blocks : []).map(cloneBlock);
  return {
    ...doc,
    id: doc?.id,
    blocks: [...existing.slice(0, at), ...inserted, ...existing.slice(at)],
  };
}

/**
 * Blocks in `doc` — the blocks that will stay behind — that reference at least
 * one block in `blocks` (the moving set). References declared *inside* the
 * moving set are ignored, since they travel with it. Deduped and sorted.
 */
export function collectBacklinks(doc: BlockPage, blocks: readonly MoveBlock[]): BlockBacklink[] {
  const moving = new Set<string>();
  collectIds(blocks, moving);
  const out: BlockBacklink[] = [];
  const seen = new Set<string>();
  const visit = (block: MoveBlock): void => {
    if (moving.has(block.id)) return; // the whole subtree is moving with it
    for (const target of referenceIdsOf(block)) {
      if (!moving.has(target)) continue;
      const key = `${target}\u0000${block.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ blockId: target, sourceBlockId: block.id });
    }
    if (Array.isArray(block.children)) for (const child of block.children) visit(child);
  };
  const roots = Array.isArray(doc?.blocks) ? doc.blocks : [];
  for (const block of roots) visit(block);
  return out.sort((a, b) => cmp(a.blockId, b.blockId) || cmp(a.sourceBlockId, b.sourceBlockId));
}

/** A fresh id not already in `taken`, with a deterministic fallback for degenerate factories. */
function freshId(taken: Set<string>, idFactory: IdFactory): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = idFactory();
    if (typeof id === "string" && id !== "" && !taken.has(id)) return id;
  }
  let n = 1;
  let fallback = `block-move-${n}`;
  while (taken.has(fallback)) {
    n += 1;
    fallback = `block-move-${n}`;
  }
  return fallback;
}

/** Deep-copy a block subtree, re-minting any id that is already taken. */
function reidIfNeeded(
  block: MoveBlock,
  taken: Set<string>,
  idMap: Map<string, string>,
  idFactory: IdFactory,
): MoveBlock {
  const clone = cloneBlock(block);
  if (taken.has(clone.id)) {
    const fresh = freshId(taken, idFactory);
    idMap.set(block.id, fresh);
    clone.id = fresh;
  }
  taken.add(clone.id);
  if (Array.isArray(clone.children)) {
    clone.children = clone.children.map((child) => reidIfNeeded(child, taken, idMap, idFactory));
  }
  return clone;
}

/** Rewrite inline `mention` atom ids in place (the node is an owned clone). */
function remapMentions(nodes: readonly InlineNode[] | undefined, idMap: ReadonlyMap<string, string>): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node) continue;
    const attrs = node.attrs;
    if (attrs && typeof attrs.id === "string" && idMap.has(attrs.id)) {
      attrs.id = idMap.get(attrs.id);
    }
    remapMentions(node.content, idMap);
  }
}

/** Rewrite block references that point at a re-minted id, throughout a clone. */
function remapBlockRefs(block: MoveBlock, idMap: ReadonlyMap<string, string>): void {
  if (typeof block.refBlockId === "string" && idMap.has(block.refBlockId)) {
    block.refBlockId = idMap.get(block.refBlockId);
  }
  if (Array.isArray(block.refBlockIds)) {
    block.refBlockIds = block.refBlockIds.map((id) => idMap.get(id) ?? id);
  }
  remapMentions(block.content, idMap);
  if (Array.isArray(block.children)) for (const child of block.children) remapBlockRefs(child, idMap);
}

/** Cross-references a move strands: incoming backlinks plus outgoing references. */
function collectMoveWarnings(
  from: BlockPage,
  moved: readonly MoveBlock[],
  remaining: readonly MoveBlock[],
): MoveWarning[] {
  const warnings: MoveWarning[] = [];
  for (const link of collectBacklinks(from, moved)) {
    warnings.push({ code: "backlink", blockId: link.blockId, relatedBlockId: link.sourceBlockId });
  }
  const remainingIds = new Set<string>();
  collectIds(remaining, remainingIds);
  const seen = new Set<string>();
  const walk = (blocks: readonly MoveBlock[]): void => {
    for (const block of blocks) {
      for (const target of referenceIdsOf(block)) {
        if (!remainingIds.has(target)) continue;
        const key = `${block.id}\u0000${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push({ code: "reference", blockId: block.id, relatedBlockId: target });
      }
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(moved);
  return warnings.sort(
    (a, b) =>
      cmp(a.code, b.code) || cmp(a.blockId, b.blockId) || cmp(a.relatedBlockId, b.relatedBlockId),
  );
}

/** Remove a selection and re-insert it at the adjusted destination offset. */
function reorderSamePage(
  blocks: readonly MoveBlock[],
  selected: readonly number[],
  targetIndex: number,
): MoveBlock[] {
  const picked = selected.map((index) => blocks[index]);
  const removedBefore = selected.filter((index) => index < targetIndex).length;
  const rest = blocks.filter((_, index) => !selected.includes(index));
  const at = Math.max(0, Math.min(rest.length, targetIndex - removedBefore));
  return [...rest.slice(0, at), ...picked, ...rest.slice(at)];
}

/**
 * Move the selected top-level blocks between two pages (or reorder them within
 * one). Fresh ids are minted only where a moving id would collide with the
 * destination; internal references to a re-minted id are rewritten. Cross-page
 * moves report the references they strand as {@link MoveWarning}s.
 */
export function moveBlocks(
  pair: MovePair,
  selection: MoveSelection,
  options: MoveOptions = {},
): MoveResult {
  const { idFactory = defaultMoveIdFactory } = options;
  const from = pair?.from;
  const to = pair?.to;
  const fromBlocks = Array.isArray(from?.blocks) ? from.blocks : [];
  const toBlocks = Array.isArray(to?.blocks) ? to.blocks : [];
  const selected = normalizeIndices(
    Array.isArray(selection?.indices) ? selection.indices : [],
    fromBlocks.length,
  );
  const targetIndex = clampIndex(selection?.targetIndex, toBlocks.length);

  if (selected.length === 0) {
    return {
      fromDoc: { ...from, id: from?.id, blocks: fromBlocks.map(cloneBlock) },
      toDoc: { ...to, id: to?.id, blocks: toBlocks.map(cloneBlock) },
      idMap: new Map(),
      warnings: [],
    };
  }

  if (isSamePage(from, to)) {
    const reordered = reorderSamePage(fromBlocks, selected, targetIndex);
    return {
      fromDoc: { ...from, id: from?.id, blocks: reordered.map(cloneBlock) },
      toDoc: { ...to, id: to?.id, blocks: reordered.map(cloneBlock) },
      idMap: new Map(),
      warnings: [],
    };
  }

  const movedOriginals = selected.map((index) => fromBlocks[index]);
  const remainingFrom = fromBlocks.filter((_, index) => !selected.includes(index));

  const taken = new Set<string>();
  collectIds(toBlocks, taken);
  const idMap = new Map<string, string>();
  const moved = movedOriginals.map((block) => reidIfNeeded(block, taken, idMap, idFactory));
  for (const block of moved) remapBlockRefs(block, idMap);

  const toDoc = insertBlocks({ ...to, id: to?.id, blocks: toBlocks }, moved, targetIndex);
  const fromDoc = { ...from, id: from?.id, blocks: remainingFrom.map(cloneBlock) };
  const warnings = collectMoveWarnings(
    { id: from?.id ?? "", blocks: fromBlocks },
    movedOriginals,
    remainingFrom,
  );

  return { fromDoc, toDoc, idMap, warnings };
}

/** Whether two page refs name the same page. Nullish or empty ids never match. */
export function isSamePage(from: PageRef, to: PageRef): boolean {
  const a = typeof from === "string" ? from : from?.id;
  const b = typeof to === "string" ? to : to?.id;
  return typeof a === "string" && a !== "" && a === b;
}

/**
 * Check a move against the source document: an empty selection, source indices
 * outside `0..length - 1`, a target index outside `0..length`, and dropping a
 * contiguous selection into its own span are all reported. `ok` is true exactly
 * when `errors` is empty.
 */
export function validateMove(input: ValidateMoveInput): MoveValidation {
  const errors: string[] = [];
  const blocks = Array.isArray(input?.doc?.blocks) ? input.doc.blocks : [];
  const length = blocks.length;
  const indices = Array.isArray(input?.indices) ? input.indices : [];
  const selected = normalizeIndices(indices, length);

  if (selected.length === 0) errors.push("empty selection");

  const outOfRange = new Set<number>();
  for (const raw of indices) {
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n)) continue;
    if (n < 0 || n >= length) outOfRange.add(n);
  }
  for (const n of [...outOfRange].sort((a, b) => a - b)) {
    errors.push(`out-of-range index: ${n}`);
  }

  if (input?.targetIndex !== undefined) {
    const target = Math.trunc(Number(input.targetIndex));
    if (!Number.isFinite(target) || target < 0 || target > length) {
      errors.push(`out-of-range target index: ${target}`);
    }
  }

  if (selected.length > 0 && input?.targetIndex !== undefined && isContiguous(selected)) {
    const target = input.targetIndex;
    const first = selected[0];
    const last = selected[selected.length - 1];
    if (Number.isFinite(target) && target > first && target <= last) {
      errors.push("moving into its own subtree");
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Plan a move without applying it: the ordered ops (a `remove` from the source,
 * then an `insert` into the destination), the count, the cross-reference
 * warnings and any validation errors. The destination's own blocks are unknown
 * here, so its target index is clamped at apply time and only source-geometry
 * errors ("out-of-range target index", "moving into its own subtree") are
 * suppressed for a cross-page destination.
 */
export function planBlockMove(input: PlanBlockMoveInput): MovePlan {
  const doc = input?.doc;
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const indices = Array.isArray(input?.indices) ? input.indices : [];
  const targetPageId = typeof input?.targetPageId === "string" ? input.targetPageId : "";
  const targetTitle = typeof input?.targetTitle === "string" ? input.targetTitle.trim() : "";
  const targetLabel = targetTitle !== "" ? targetTitle : targetPageId;
  const samePage = isSamePage(doc, targetPageId);

  const validation = validateMove({ doc, indices, targetIndex: input?.targetIndex });
  const errors = samePage
    ? [...validation.errors]
    : validation.errors.filter(
        (error) =>
          !error.startsWith("moving into its own subtree") &&
          !error.startsWith("out-of-range target index:"),
      );
  if (!samePage && input?.targetIndex !== undefined) {
    const target = Math.trunc(Number(input.targetIndex));
    if (!Number.isFinite(target) || target < 0) errors.push(`out-of-range target index: ${target}`);
  }

  const index = clampIndex(input?.targetIndex, blocks.length);
  if (errors.length > 0) {
    return { ops: [], warnings: [], errors, count: 0, targetPageId, targetIndex: index, targetLabel };
  }

  const selected = normalizeIndices(indices, blocks.length);
  const count = selected.length;
  const ops: MoveOp[] = [
    { op: "remove", pageId: doc?.id ?? "", indices: selected, count },
    { op: "insert", pageId: targetPageId, index, count },
  ];
  const moved = selected.map((i) => blocks[i]);
  const remaining = blocks.filter((_, i) => !selected.includes(i));
  const warnings = samePage
    ? []
    : collectMoveWarnings({ id: doc?.id ?? "", blocks }, moved, remaining);

  return { ops, warnings, errors: [], count, targetPageId, targetIndex: index, targetLabel };
}

/** Summarise a plan for a toast or status line, e.g. `"Moved 3 blocks to Beta"`. */
export function describeMove(plan: MovePlan): string {
  if (!plan || plan.errors.length > 0 || plan.count <= 0) return "Nothing to move.";
  const noun = plan.count === 1 ? "block" : "blocks";
  return `Moved ${plan.count} ${noun} to ${plan.targetLabel}`;
}

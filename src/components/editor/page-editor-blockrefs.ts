"use client";

/**
 * Block selection/reorder and block-reference projection for the editor.
 *
 * Extracted from ./page-editor; the public import path stays stable through
 * that module's re-export. ProseMirror documents in, ids/plans out; every
 * helper is pure except the two explicit transaction dispatchers.
 */
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import {
  collectBlocks,
  copyReference,
  extractReferences,
  missingReferences,
  resolveSynced,
  type Block as ReferenceBlock,
} from "@/lib/block-refs";
import {
  resolveRange,
  type BlockRange as SelectionRange,
  type MaybeRange,
} from "@/lib/block-selection";
import { moveBlocks, type BlockPage } from "@/lib/block-move";

/* --------------------------------------------------------- block selection/move */

/** The top-level block ids of a document, in document order. */
export function topLevelBlockIds(doc: PMNode): string[] {
  const ids: string[] = [];
  doc.forEach((node) => {
    const id = node.attrs?.id;
    ids.push(typeof id === "string" ? id : "");
  });
  return ids;
}

/** The id of the top-level block containing `pos`, or `null`. */
export function blockIdAt(doc: PMNode, pos: number): string | null {
  let found: string | null = null;
  doc.forEach((node, offset) => {
    if (found !== null) return;
    if (pos >= offset && pos <= offset + node.nodeSize) {
      const id = node.attrs?.id;
      found = typeof id === "string" && id !== "" ? id : null;
    }
  });
  return found;
}

/**
 * Every block id nested inside the top-level block `id`, depth-first. Used to
 * seed the invalid-drop decision: a block may never be dropped into its own
 * subtree, so the editor needs that set before the first `dragover`.
 */
export function descendantBlockIds(doc: PMNode, id: string): string[] {
  const ids: string[] = [];
  const walk = (node: PMNode) => {
    node.forEach((child) => {
      const childId = child.attrs?.id;
      if (typeof childId === "string" && childId !== "") ids.push(childId);
      walk(child);
    });
  };
  doc.forEach((node) => {
    if (node.attrs?.id === id) walk(node);
  });
  return ids;
}

/* ------------------------------------------------- block references (refs) */

/**
 * Lift a ProseMirror node into the shared `Block` shape `src/lib/block-refs.ts`
 * reads, preserving a node's `refBlockId`/`refBlockIds` reference fields.
 */
function pmNodeToReferenceBlock(node: PMNode): ReferenceBlock {
  const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
  const block: ReferenceBlock = { id, type: node.type.name };
  const refBlockId = node.attrs?.refBlockId;
  if (typeof refBlockId === "string" && refBlockId !== "") block.refBlockId = refBlockId;
  const refBlockIds = node.attrs?.refBlockIds;
  if (Array.isArray(refBlockIds)) {
    const ids = refBlockIds.filter((value): value is string => typeof value === "string");
    if (ids.length > 0) block.refBlockIds = ids;
  }
  const children: ReferenceBlock[] = [];
  node.forEach((child) => {
    if (child.isText) return;
    children.push(pmNodeToReferenceBlock(child));
  });
  if (children.length > 0) block.children = children;
  return block;
}

/**
 * The document's block-reference view: the same tree `page-editor` uses for
 * block ids, projected into the `block-refs.ts` engine so its helpers own the
 * reference bookkeeping. Pure — the ProseMirror document is never mutated.
 */
export function pmDocToReferenceBlocks(doc: PMNode): ReferenceBlock[] {
  const blocks: ReferenceBlock[] = [];
  doc.forEach((node) => blocks.push(pmNodeToReferenceBlock(node)));
  return blocks;
}

/** The canonical id → block index for a document (`collectBlocks`). */
export function blockReferenceIndex(doc: PMNode): ReturnType<typeof collectBlocks> {
  return collectBlocks(pmDocToReferenceBlocks(doc));
}

/** Every block that references another block (`extractReferences`). */
export function blockReferenceEntries(doc: PMNode): ReturnType<typeof extractReferences> {
  return extractReferences(pmDocToReferenceBlocks(doc));
}

/** Referenced block ids the document does not contain (`missingReferences`). */
export function brokenBlockReferences(doc: PMNode): string[] {
  return missingReferences(pmDocToReferenceBlocks(doc));
}

/** Resolve a referenced block's subtree (`resolveSynced`). */
export function resolveBlockReference(doc: PMNode, blockId: string) {
  return resolveSynced(pmDocToReferenceBlocks(doc), blockId);
}

/** The paste pair for a synced block reference (`copyReference`). */
export function blockReferenceCopy(doc: PMNode, blockId: string) {
  return copyReference(pmDocToReferenceBlocks(doc), blockId);
}


/**
 * Plan a multi-block drag reorder with `moveBlocks`: given the flat block ids,
 * the selected range and the destination index, return the new id order, or
 * `null` when fewer than two whole blocks are selected (the single-block
 * indent path keeps handling that case).
 */
export function planBlockReorder(
  blockIds: readonly string[],
  range: MaybeRange,
  targetIndex: number,
): string[] | null {
  const selected = resolveRange(blockIds, range);
  if (selected.length < 2) return null;
  const indices = selected.map((id) => blockIds.indexOf(id)).filter((index) => index >= 0);
  if (indices.length < 2) return null;
  const page: BlockPage = {
    id: "page",
    blocks: blockIds.map((id) => ({ id, type: "block" })),
  };
  const result = moveBlocks({ from: page, to: page }, { indices, targetIndex });
  return result.toDoc.blocks.map((block) => block.id);
}

/** Reorder the document's top-level blocks to match `order` in one transaction. */
export function reorderTopLevelBlocks(view: EditorView, order: readonly string[]): void {
  const doc = view.state.doc;
  const byId = new Map<string, PMNode>();
  doc.forEach((node) => {
    const id = node.attrs?.id;
    if (typeof id === "string") byId.set(id, node);
  });
  const nodes = order
    .map((id) => byId.get(id))
    .filter((node): node is PMNode => node !== undefined);
  if (nodes.length !== doc.childCount) return;
  view.dispatch(
    view.state.tr.replaceWith(0, doc.content.size, Fragment.fromArray(nodes)),
  );
}

/** Delete every top-level block whose id is in `ids` as one transaction. */
export function deleteBlocksByIds(view: EditorView, ids: readonly string[]): void {
  const doc = view.state.doc;
  const targets = new Set(ids);
  let from = -1;
  let to = -1;
  doc.forEach((node, offset) => {
    const id = node.attrs?.id;
    if (typeof id === "string" && targets.has(id)) {
      if (from === -1) from = offset;
      to = offset + node.nodeSize;
    }
  });
  if (from === -1 || to === -1) return;
  const tr = view.state.tr;
  // A document is `block+`: replacing the whole body with one empty paragraph
  // keeps the schema valid when the range was the entire page.
  if (from === 0 && to === doc.content.size) {
    tr.replaceWith(0, doc.content.size, view.state.schema.nodes.paragraph.create());
  } else {
    tr.delete(from, to);
  }
  view.dispatch(tr.scrollIntoView());
}


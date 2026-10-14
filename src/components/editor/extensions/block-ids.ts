"use client";

import { Extension } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";

/**
 * Stable block ids — mint a persistent `id` on every **top-level** block.
 *
 * `src/lib/deep-links.ts` addresses a block with the `#<blockId>` fragment, but
 * editor nodes carried no persisted identity (the old handler used a document
 * offset, `#block-<pos>`, which drifts on every edit above it — see the
 * `block-context-menu.tsx` comment / O84.2). This extension closes that gap:
 *
 *   • `addGlobalAttributes` adds an optional `id` attribute to every node type,
 *     so any top-level block the schema can hold is eligible — no per-node
 *     plumbing and no edit to the shared `page-editor.tsx`.
 *   • a ProseMirror `appendTransaction` mints an id for a top-level block that
 *     is missing one (new/append/setContent) and re-mints a *duplicate* one
 *     (split, paste, duplicate). Existing ids are never overwritten, so they
 *     survive edits and reorders; only the second copy of a duplicated id
 *     changes.
 *
 * `keepOnSplit: false` stops the id being copied onto the block a split-off, so
 * the common Enter case mints a fresh id instead of relying on the dedupe.
 *
 * The minting/dedupe logic is pure and lives in `planBlockIds` (plan) and
 * `ensureBlockIds` (apply to a document); the plugin is the thin adapter
 * `blockIdsTransaction`. Registered through `input-rules.ts`'s `addExtensions`
 * hook, the same pattern as `SmartTypography` / `SmartSuggestions`.
 */

/** Mints candidate ids; the extension uses {@link defaultBlockIdFactory}. */
export type BlockIdFactory = () => string;

/** A top-level block whose `id` must be (re)assigned, and the id to give it. */
export interface BlockIdAssignment {
  /** ProseMirror offset of the top-level block inside the document. */
  offset: number;
  /** The stable id the block should carry. */
  id: string;
}

export const blockIdsPluginKey = new PluginKey("blockIds");

/** Bounded retries while the factory hunts for an unused id. */
const MAX_MINT_ATTEMPTS = 50;

let seed = 0;

/**
 * Default id minting. A random UUID when the platform exposes one (browsers and
 * modern Node), else a timestamp + counter fallback so ids stay unique without
 * throwing in a restricted context.
 */
export function defaultBlockIdFactory(): string {
  seed += 1;
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return `blk_${cryptoApi.randomUUID()}`;
    } catch {
      // Fall through to the counter-based id.
    }
  }
  return `blk_${Date.now().toString(36)}_${seed.toString(36)}`;
}

/** Whether a node type carries the (optional) `id` attribute in this schema. */
function hasIdAttribute(node: PMNode): boolean {
  const attributes = node.type.spec.attrs;
  return attributes != null && Object.prototype.hasOwnProperty.call(attributes, "id");
}

/** A usable id is a non-empty, non-whitespace string. */
function isUsableId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Mint an id that is neither blocked nor empty, retrying the factory a bounded
 * number of times; a deterministic `block-<n>` escape hatch keeps the document
 * consistent if the factory keeps colliding or returns junk.
 */
function mintUniqueId(factory: BlockIdFactory, blocked: Set<string>): string {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
    const candidate = factory();
    if (isUsableId(candidate) && !blocked.has(candidate)) return candidate;
  }
  let ordinal = blocked.size + 1;
  let fallback = `block-${ordinal}`;
  while (blocked.has(fallback)) {
    ordinal += 1;
    fallback = `block-${ordinal}`;
  }
  return fallback;
}

/**
 * Plan the id assignments for a document's top-level blocks.
 *
 * - a block with a usable id that has not been claimed yet keeps it;
 * - a missing/empty/duplicate id is re-minted through `factory`, skipping every
 *   id already present anywhere in the document (so a minted id can never
 *   shadow an id that appears later) and every id minted in this pass.
 *
 * Pure: reads `doc` only and returns the offsets that need a `setNodeMarkup`.
 * The first occurrence of a duplicated id wins; later copies move.
 */
export function planBlockIds(doc: PMNode, factory: BlockIdFactory): BlockIdAssignment[] {
  const reserved = new Set<string>();
  doc.forEach((node) => {
    if (hasIdAttribute(node) && isUsableId(node.attrs?.id)) reserved.add(node.attrs.id);
  });

  const claimed = new Set<string>();
  const assignments: BlockIdAssignment[] = [];
  doc.forEach((node, offset) => {
    if (!hasIdAttribute(node)) return;
    const current = node.attrs?.id;
    if (isUsableId(current) && !claimed.has(current)) {
      claimed.add(current);
      return;
    }
    const id = mintUniqueId(factory, reserved);
    reserved.add(id);
    claimed.add(id);
    assignments.push({ offset, id });
  });
  return assignments;
}

/**
 * Apply {@link planBlockIds} to a document, returning the updated document (the
 * **same instance** when nothing needs changing) and the assignments used.
 */
export function ensureBlockIds(
  doc: PMNode,
  factory: BlockIdFactory,
): { doc: PMNode; assignments: BlockIdAssignment[] } {
  const assignments = planBlockIds(doc, factory);
  if (assignments.length === 0) return { doc, assignments };

  const idByOffset = new Map(assignments.map((assignment) => [assignment.offset, assignment.id]));
  const children: PMNode[] = [];
  doc.forEach((node, offset) => {
    const id = idByOffset.get(offset);
    children.push(
      id === undefined
        ? node
        : node.type.create({ ...node.attrs, id }, node.content, node.marks),
    );
  });
  return { doc: doc.copy(Fragment.fromArray(children)), assignments };
}

/**
 * The `appendTransaction` core: after a document change, return a transaction
 * that stamps ids on the affected top-level blocks, or `null` when there is
 * nothing to do (no change, or every id already settled).
 */
export function blockIdsTransaction(
  transactions: readonly Transaction[],
  newState: EditorState,
  factory: BlockIdFactory,
): Transaction | null {
  if (!transactions.some((transaction) => transaction.docChanged)) return null;

  const assignments = planBlockIds(newState.doc, factory);
  if (assignments.length === 0) return null;

  const tr = newState.tr;
  for (const { offset, id } of assignments) {
    const node = tr.doc.nodeAt(offset);
    if (!node || !hasIdAttribute(node)) continue;
    // Attribute-only markup: node sizes are unchanged, so later offsets stay valid.
    tr.setNodeMarkup(offset, undefined, { ...node.attrs, id });
  }
  return tr.docChanged ? tr : null;
}

export const BlockIds = Extension.create({
  name: "blockIds",

  addGlobalAttributes() {
    return [
      {
        // Every node type is eligible, so any top-level block the schema can
        // hold is covered; only top-level blocks are ever minted.
        types: "nodes",
        attributes: {
          id: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => element.getAttribute("data-block-id"),
            renderHTML: (attributes) =>
              attributes.id ? { "data-block-id": attributes.id } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdsPluginKey,
        appendTransaction: (transactions, _oldState, newState) =>
          blockIdsTransaction(transactions, newState, defaultBlockIdFactory),
      }),
    ];
  },
});

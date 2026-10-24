"use client";

import { Extension, type CommandProps } from "@tiptap/core";
import {
  Fragment,
  type Node as PMNode,
  type Schema,
} from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  applyOne,
  applySuggestions,
  createSuggestions,
  type Block,
  type Suggestion,
} from "@/lib/suggestions";

/**
 * Suggestions (track-changes) editing mode — the editor half of "Suggestions
 * mode" / "Accept/reject suggestion" (docs/MISSING_FEATURES.md §7).
 *
 * `src/lib/suggestions.ts` owns the pure, tested engine: a `Suggestion` is one
 * *block-level* edit (`insert` / `delete` / `replace`) matched by block id, and
 * `createSuggestions(base, proposed)` diffs two `Block[]` snapshots while
 * `applySuggestions` / `applyOne` accept or reject them. This extension drives
 * that **same** engine from a TipTap editor:
 *
 *   • `setSuggesting(true)` snapshots the current document (`doc → Block[]`,
 *     stamped with stable internal ids) as the **base** — the committed view a
 *     reviewer is comparing against.
 *   • While suggesting, every document change re-diffs `base` against the live
 *     document with `createSuggestions`, so block inserts / deletes / replaces
 *     become pending suggestions instead of silent edits. The engine is the one
 *     source of truth for what counts as a change.
 *   • Pending suggestions render decoratively: a node decoration per inserted /
 *     replaced block and a widget marker at a deleted block's anchor. Accept and
 *     reject are exposed as editor commands (`acceptSuggestion` /
 *     `rejectSuggestion` / `acceptAll` / `rejectAll`), so a toolbar owns the
 *     controls and this file owns the state.
 *
 * Identity bridge (engine ↔ editor): the engine matches by block id, but
 * ProseMirror nodes have no id attribute (adding one would leak into the saved
 * document). `alignBlockIds` therefore reconciles the base snapshot with the
 * live top-level nodes: unchanged blocks are matched by content (an LCS) and
 * keep their base id; within the runs *between* matches, base and node slots are
 * paired positionally so an edited block inherits its base id (→ a `replace`),
 * while surplus nodes get fresh ids (→ `insert`) and surplus base blocks vanish
 * (→ `delete`). See `alignBlockIds` for the exact rule and its one documented
 * limitation (two adjacent blocks edited *and* shifted at once can mis-pair).
 *
 * Commitment model:
 *   • accept advances `base` (`applyOne` / `applySuggestions`); the document,
 *     which already shows the proposed content, does not move — the accepted
 *     suggestion simply stops being a diff.
 *   • reject moves the *document* back toward `base` (delete an inserted node,
 *     restore a replaced node, re-insert a deleted one); the engine's list then
 *     recomputes without it.
 *
 * Honesty boundaries: the engine's `Block` carries only
 * `{ type, text }`, so accepting/rejecting a changed block rebuilds that block
 * from text and drops inline marks and nested structure — structural blocks
 * (lists, tables, images, custom nodes) are decorated but not surgically
 * revertible and `rejectAll` rebuilds the document from the block snapshot. The
 * extension is registered through `input-rules.ts`'s `addExtensions` hook (the
 * `smart-typography.ts` pattern) so the shared `page-editor.tsx` need not change.
 */

/** Structural subset of a ProseMirror node the alignment needs (keeps it testable). */
export type BlockSource = {
  type: { name: string };
  isTextblock: boolean;
  textContent: string;
};

/** Project a live node onto the engine's `Block` (text only for textblocks). */
export function blockFromNode(id: string, node: BlockSource): Block {
  return node.isTextblock
    ? { id, type: node.type.name, text: node.textContent }
    : { id, type: node.type.name };
}

function sameContent(block: Block, node: BlockSource): boolean {
  if ((block.type ?? null) !== node.type.name) return false;
  return (block.text ?? null) === (node.isTextblock ? node.textContent : null);
}

/** Longest-common-subsequence pairs over *content* equality (ids are not compared). */
function lcsPairs(
  base: readonly Block[],
  nodes: readonly BlockSource[],
): { base: number; node: number }[] {
  const n = base.length;
  const m = nodes.length;
  if (n === 0 || m === 0) return [];

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = sameContent(base[i], nodes[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: { base: number; node: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sameContent(base[i], nodes[j])) {
      pairs.push({ base: i, node: j });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Reconcile the engine's `base` blocks with the live top-level nodes, producing a
 * `proposed` `Block[]` aligned index-for-index with the document.
 *
 * - blocks matched by the LCS keep their base id;
 * - inside each unmatched run, base and node slots are paired positionally, so a
 *   single edited block reuses its base id (the engine reports a `replace`);
 * - surplus nodes mint fresh ids via `freshId` (the engine reports `insert`);
 * - surplus base blocks are simply absent (the engine reports `delete`).
 *
 * `fresh` is how many fresh ids were minted, so the caller can advance its
 * monotonic counter without collisions.
 */
export function alignBlockIds(
  base: readonly Block[],
  nodes: readonly BlockSource[],
  freshId: (ordinal: number) => string,
): { blocks: Block[]; fresh: number } {
  const result: (Block | undefined)[] = new Array(nodes.length);
  const pairs = lcsPairs(base, nodes);
  let ordinal = 0;

  const pair = (baseIndex: number, nodeIndex: number) => {
    result[nodeIndex] = blockFromNode(base[baseIndex].id, nodes[nodeIndex]);
  };

  let baseCursor = 0;
  let nodeCursor = 0;
  const runs: { baseStart: number; baseEnd: number; nodeStart: number; nodeEnd: number }[] = [];
  for (const anchor of pairs) {
    runs.push({
      baseStart: baseCursor,
      baseEnd: anchor.base,
      nodeStart: nodeCursor,
      nodeEnd: anchor.node,
    });
    baseCursor = anchor.base + 1;
    nodeCursor = anchor.node + 1;
  }
  runs.push({ baseStart: baseCursor, baseEnd: base.length, nodeStart: nodeCursor, nodeEnd: nodes.length });

  for (const run of runs) {
    const baseLength = run.baseEnd - run.baseStart;
    const nodeLength = run.nodeEnd - run.nodeStart;
    const paired = Math.min(baseLength, nodeLength);
    for (let k = 0; k < paired; k += 1) pair(run.baseStart + k, run.nodeStart + k);
    for (let k = paired; k < nodeLength; k += 1) {
      result[run.nodeStart + k] = blockFromNode(freshId(ordinal), nodes[run.nodeStart + k]);
      ordinal += 1;
    }
  }
  for (const anchor of pairs) pair(anchor.base, anchor.node);

  return { blocks: result as Block[], fresh: ordinal };
}

/**
 * Where a deleted block's marker belongs: the document index of the next base
 * block that survived into `proposed` (mirrors the engine's delete anchor), or
 * `proposed.length` when nothing survives after it.
 */
export function deleteAnchorIndex(
  base: readonly Block[],
  proposed: readonly Block[],
  deletedId: string,
): number {
  const proposedIndex = new Map(proposed.map((block, index) => [block.id, index]));
  const baseIndex = base.findIndex((block) => block.id === deletedId);
  if (baseIndex < 0) return proposed.length;
  for (let k = baseIndex + 1; k < base.length; k += 1) {
    const index = proposedIndex.get(base[k].id);
    if (index !== undefined) return index;
  }
  return proposed.length;
}

type Meta =
  | { type: "set"; active: boolean; authorId?: string }
  | { type: "hydrate"; base: Block[]; authorId?: string }
  | { type: "accept"; id: string }
  | { type: "acceptAll" };

/** Plugin state — the review session plus the derived decoration set. */
export type SmartSuggestionsState = {
  active: boolean;
  authorId?: string;
  /** Committed view the diff is taken against; `null` when the mode is off. */
  base: Block[] | null;
  /** Live document projected to engine blocks, aligned index-for-index. */
  proposed: Block[];
  suggestions: Suggestion[];
  /** Monotonic counter for fresh (inserted) block ids. */
  ordinal: number;
  decorations: DecorationSet;
};

export const suggestionsPluginKey = new PluginKey<SmartSuggestionsState>("smartSuggestions");

/** Read the review session from an editor state (for a toolbar/badge). */
export function getSmartSuggestionsState(
  state: EditorState,
): SmartSuggestionsState | undefined {
  return suggestionsPluginKey.getState(state);
}

/** Pending suggestions, for a badge/count in the UI. */
export function pendingSuggestions(state: EditorState): Suggestion[] {
  return suggestionsPluginKey.getState(state)?.suggestions ?? [];
}

/** Whether capture is currently on. */
export function isSuggesting(state: EditorState): boolean {
  return suggestionsPluginKey.getState(state)?.active ?? false;
}

function emptyState(ordinal = 0): SmartSuggestionsState {
  return {
    active: false,
    base: null,
    proposed: [],
    suggestions: [],
    ordinal,
    decorations: DecorationSet.empty,
  };
}

function topLevelOffsets(doc: PMNode): number[] {
  const offsets: number[] = [];
  doc.forEach((_node, offset) => {
    offsets.push(offset);
  });
  return offsets;
}

/**
 * Build an engine-block node through the schema. Textblocks are rebuilt from
 * their text; structural blocks without representable content fall back to an
 * empty node (or `null` when the schema cannot create one at all).
 */
function buildNode(schema: Schema, block: Block): PMNode | null {
  const type = schema.nodes[block.type ?? "paragraph"];
  if (!type) return null;
  if (block.text) {
    const withText = type.createAndFill(undefined, schema.text(block.text));
    if (withText) return withText;
  }
  return type.createAndFill() ?? null;
}

function buildDecorations(doc: PMNode, state: SmartSuggestionsState): DecorationSet {
  if (!state.base || state.suggestions.length === 0) return DecorationSet.empty;

  const offsets = topLevelOffsets(doc);
  const byId = new Map(state.proposed.map((block, index) => [block.id, index]));
  const decorations: Decoration[] = [];

  for (const suggestion of state.suggestions) {
    if (suggestion.kind === "delete") {
      const anchor = deleteAnchorIndex(state.base, state.proposed, suggestion.blockId);
      const position = anchor < state.proposed.length ? offsets[anchor] : doc.content.size;
      const removed = suggestion.before?.text?.trim();
      const label = removed ? `− ${removed}` : "deleted block";
      decorations.push(
        Decoration.widget(position, () => deletedWidget(label, suggestion.id), {
          side: -1,
          key: `delete:${suggestion.id}`,
        }),
      );
      continue;
    }

    const index = byId.get(suggestion.blockId);
    if (index === undefined) continue;
    const from = offsets[index];
    const to = from + doc.child(index).nodeSize;
    const visualKind: "insert" | "replace" = suggestion.kind;
    // Node attributes are the stable CSS hook; a sibling widget badge gives
    // visible feedback without clobbering a node's own `style` (e.g. text-align).
    decorations.push(
      Decoration.node(from, to, {
        class: `noema-suggestion noema-suggestion--${visualKind}`,
        "data-suggestion-kind": visualKind,
        "data-suggestion-id": suggestion.id,
      }),
      Decoration.widget(from, () => kindWidget(visualKind), {
        side: -1,
        key: `kind:${suggestion.id}`,
      }),
    );
  }

  decorations.sort((left, right) => left.from - right.from || left.to - right.to);
  return DecorationSet.create(doc, decorations);
}

/** Insert/replace marker badge (built lazily, only when the view renders). */
function kindWidget(kind: "insert" | "replace"): HTMLElement {
  const element = document.createElement("span");
  element.className = `noema-suggestion-badge noema-suggestion-badge--${kind}`;
  element.setAttribute("data-suggestion-kind", kind);
  element.setAttribute("contenteditable", "false");
  element.textContent = kind === "insert" ? "＋" : "✎";
  element.style.cssText = "display:inline-block;margin-right:0.25rem;font-size:0.85em;opacity:0.85;";
  return element;
}

/**
 * Inline `cssText` for the delete marker. Token-only (design system §1): the
 * danger tokens replace the old `rgba(235,87,87,0.12)` / `#b91c1c`, so the
 * marker follows light / dark / high-contrast from the same source. Pure, so a
 * node test can pin it without a DOM.
 */
export function suggestionDeleteStyle(): string {
  return (
    "display:inline-block;margin:0 0.25rem;padding:0 0.25rem;border-radius:var(--radius-sm);" +
    "background:var(--danger-soft);color:var(--danger);text-decoration:line-through;font-size:0.85em;"
  );
}

/** Delete marker DOM (built lazily, only when the view renders). */
function deletedWidget(label: string, id: string): HTMLElement {
  const element = document.createElement("span");
  element.className = "noema-suggestion-delete";
  element.setAttribute("data-suggestion-id", id);
  element.setAttribute("data-suggestion-kind", "delete");
  element.setAttribute("contenteditable", "false");
  element.textContent = label;
  element.style.cssText = suggestionDeleteStyle();
  return element;
}

/** Snapshot a document to engine blocks, minting fresh sequential ids. */
function blocksFromDoc(
  doc: PMNode,
  freshId: (ordinal: number) => string,
): { blocks: Block[]; fresh: number } {
  const blocks: Block[] = [];
  let ordinal = 0;
  doc.forEach((node) => {
    blocks.push(blockFromNode(freshId(ordinal), node));
    ordinal += 1;
  });
  return { blocks, fresh: ordinal };
}

/** Re-diff `base` against the live document and rebuild the decoration set. */
function recompute(value: SmartSuggestionsState, doc: PMNode): SmartSuggestionsState {
  if (!value.base) return { ...value, proposed: [], suggestions: [], decorations: DecorationSet.empty };

  const nodes: BlockSource[] = [];
  doc.forEach((node) => {
    nodes.push(node);
  });

  const aligned = alignBlockIds(value.base, nodes, (ordinal) => `sug-${value.ordinal + ordinal}`);
  const next: SmartSuggestionsState = {
    ...value,
    proposed: aligned.blocks,
    suggestions: createSuggestions(value.base, aligned.blocks, { authorId: value.authorId }),
    ordinal: value.ordinal + aligned.fresh,
    decorations: DecorationSet.empty,
  };
  next.decorations = buildDecorations(doc, next);
  return next;
}

function applyMeta(
  meta: Meta,
  value: SmartSuggestionsState,
  doc: PMNode,
): SmartSuggestionsState {
  if (meta.type === "set") {
    if (!meta.active) return emptyState(value.ordinal);
    let used = 0;
    const snapshot = blocksFromDoc(doc, () => `sug-${value.ordinal + used++}`);
    const next: SmartSuggestionsState = {
      active: true,
      base: snapshot.blocks,
      proposed: snapshot.blocks.slice(),
      suggestions: [],
      ordinal: value.ordinal + snapshot.fresh,
      decorations: DecorationSet.empty,
    };
    if (meta.authorId !== undefined) next.authorId = meta.authorId;
    return next;
  }

  if (meta.type === "hydrate") {
    const base = meta.base.map((block) => ({ ...block }));
    const hydrated: SmartSuggestionsState = {
      active: true,
      base,
      proposed: [],
      suggestions: [],
      ordinal: Math.max(value.ordinal, base.length),
      decorations: DecorationSet.empty,
    };
    if (meta.authorId !== undefined) hydrated.authorId = meta.authorId;
    return recompute(hydrated, doc);
  }

  if (!value.base) return value;

  if (meta.type === "accept") {
    const suggestion = value.suggestions.find((candidate) => candidate.id === meta.id);
    if (!suggestion) return value;
    return recompute({ ...value, base: applyOne(value.base, suggestion, "accept") }, doc);
  }

  return recompute(
    { ...value, base: applySuggestions(value.base, value.suggestions, "accept") },
    doc,
  );
}

/**
 * Move the document back toward `base` for one suggestion: delete an inserted
 * node, rebuild a replaced node from `before`, or re-insert a deleted one.
 */
function revertSuggestion(
  tr: Transaction,
  schema: Schema,
  doc: PMNode,
  current: SmartSuggestionsState,
  suggestion: Suggestion,
): boolean {
  const proposedIndex = current.proposed.findIndex((block) => block.id === suggestion.blockId);
  const offsets = topLevelOffsets(doc);

  if (suggestion.kind === "replace") {
    if (proposedIndex < 0 || !suggestion.before) return false;
    const from = offsets[proposedIndex];
    const to = from + doc.child(proposedIndex).nodeSize;
    const node = buildNode(schema, suggestion.before);
    if (!node) return false;
    tr.replaceWith(from, to, node);
    return true;
  }

  if (suggestion.kind === "insert") {
    if (proposedIndex < 0) return false;
    const from = offsets[proposedIndex];
    tr.delete(from, from + doc.child(proposedIndex).nodeSize);
    return true;
  }

  if (!suggestion.before) return false;
  const node = buildNode(schema, suggestion.before);
  if (!node) return false;
  const anchor = deleteAnchorIndex(current.base ?? [], current.proposed, suggestion.blockId);
  const position = anchor < current.proposed.length ? offsets[anchor] : doc.content.size;
  tr.insert(position, node);
  return true;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    smartSuggestions: {
      /**
       * Toggle suggesting (track-changes) mode. Turning it on snapshots the
       * document as the base; turning it off stops tracking and discards the
       * pending list (the on-screen content is kept).
       */
      setSuggesting: (active: boolean, options?: { authorId?: string }) => ReturnType;
      /** Restore a persisted session: base blocks + optional author. */
      hydrateSuggestions: (
        base: Block[],
        options?: { authorId?: string },
      ) => ReturnType;
      /** Accept one pending suggestion by its engine id. */
      acceptSuggestion: (id: string) => ReturnType;
      /** Reject one pending suggestion by its engine id (reverts the block). */
      rejectSuggestion: (id: string) => ReturnType;
      /** Accept every pending suggestion. */
      acceptAll: () => ReturnType;
      /** Reject every pending suggestion (rebuilds the document from the base). */
      rejectAll: () => ReturnType;
    };
  }
}

export const SmartSuggestions = Extension.create({
  name: "smartSuggestions",

  addProseMirrorPlugins() {
    return [
      new Plugin<SmartSuggestionsState>({
        key: suggestionsPluginKey,
        state: {
          init: () => emptyState(),
          apply: (tr, value, _oldState, newState) => {
            const meta = tr.getMeta(suggestionsPluginKey) as Meta | undefined;

            if (meta?.type === "set") return applyMeta(meta, value, newState.doc);

            if (meta) {
              const applied = applyMeta(meta, value, newState.doc);
              return tr.docChanged ? recompute(applied, newState.doc) : applied;
            }

            if (!value.active || !value.base || !tr.docChanged) return value;
            return recompute(value, newState.doc);
          },
        },
        props: {
          decorations: (state) =>
            suggestionsPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },

  addCommands() {
    return {
      setSuggesting:
        (active: boolean, options?: { authorId?: string }) =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(suggestionsPluginKey, {
              type: "set",
              active,
              authorId: options?.authorId,
            } satisfies Meta);
            dispatch(tr);
          }
          return true;
        },

      hydrateSuggestions:
        (base: Block[], options?: { authorId?: string }) =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(suggestionsPluginKey, {
              type: "hydrate",
              base,
              authorId: options?.authorId,
            } satisfies Meta);
            dispatch(tr);
          }
          return true;
        },

      acceptSuggestion:
        (id: string) =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(suggestionsPluginKey, { type: "accept", id } satisfies Meta);
            dispatch(tr);
          }
          return true;
        },

      rejectSuggestion:
        (id: string) =>
        ({ state, tr, dispatch }: CommandProps) => {
          const current = suggestionsPluginKey.getState(state);
          if (!current?.base) return false;
          const suggestion = current.suggestions.find((candidate) => candidate.id === id);
          if (!suggestion) return false;
          if (!dispatch) return true;
          if (!revertSuggestion(tr, state.schema, state.doc, current, suggestion)) return false;
          dispatch(tr);
          return true;
        },

      acceptAll:
        () =>
        ({ tr, dispatch }: CommandProps) => {
          if (dispatch) {
            tr.setMeta(suggestionsPluginKey, { type: "acceptAll" } satisfies Meta);
            dispatch(tr);
          }
          return true;
        },

      rejectAll:
        () =>
        ({ state, tr, dispatch }: CommandProps) => {
          const current = suggestionsPluginKey.getState(state);
          if (!current?.base || current.suggestions.length === 0) return false;
          if (!dispatch) return true;
          const nodes = current.base
            .map((block) => buildNode(state.schema, block))
            .filter((node): node is PMNode => node !== null);
          if (nodes.length === 0) return false;
          tr.replaceWith(0, state.doc.content.size, Fragment.fromArray(nodes));
          dispatch(tr);
          return true;
        },
    };
  },
});

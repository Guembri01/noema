/**
 * Notion-style drag-to-indent for block drags started from the drag handle.
 *
 * ProseMirror's default drop only reorders: `dropPoint` climbs out of lists
 * whenever the slice does not fit, so horizontal movement never changes
 * nesting. This module decides — from the horizontal distance travelled since
 * drag start — whether a drop should nest one level deeper, unnest, or fall
 * back to the stock reorder, and plans the resulting transaction pieces.
 *
 * Pure: ProseMirror state/slice math only, no DOM, unit-testable.
 */

import type { Node as PMNode, ResolvedPos, Slice } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

/** Horizontal distance (px) the pointer must travel to change nesting. */
export const DRAG_THRESHOLD_PX = 24;

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const ITEM_TYPES = new Set(["listItem", "taskItem"]);

export type DropZone = "indent" | "align" | "outdent";

export type DropContext = {
  /** The dragged slice (from `view.dragging`). */
  slice: Slice;
  /** True when the drop moves content (Alt/Ctrl toggles copy). */
  moved: boolean;
  /** Position resolved from the pointer coordinates. */
  dropPos: number;
  zone: DropZone;
  /** Absolute start position of the dragged node (`dragging.node.from`), if any. */
  sourcePos: number | null;
};

export type DropPlan = {
  /** Range holding the moved source; deleted before the insert. */
  source: { from: number; to: number };
  /** Gap where the normalised node is inserted (closed slice). */
  insertPos: number;
  /** The single node to insert, already normalised/wrapped for its target. */
  node: PMNode;
  /** When set, sink the freshly inserted item one level after insertion. */
  nest: { itemType: string } | null;
};

/**
 * Zone from the horizontal distance since drag start. Grabbing the handle and
 * moving purely vertically stays an `align` (stock reorder), so hit-testing
 * cannot mistake an ordinary reorder for an indent.
 */
export function dropZone(pointerX: number, startX: number): DropZone {
  const dx = pointerX - startX;
  if (dx >= DRAG_THRESHOLD_PX) return "indent";
  if (dx <= -DRAG_THRESHOLD_PX) return "outdent";
  return "align";
}

type DropTarget = {
  /** The list item under (or immediately before) the pointer. */
  node: PMNode;
  /** Gap directly after the target item, inside its parent list. */
  anchor: number;
  /** Depth of the list that directly contains the target item. */
  listDepth: number;
  /** Gap after the target item's parent item (one level up), when nested. */
  liftAnchor: number | null;
  /** Depth of the list that would receive a lifted item. */
  liftListDepth: number | null;
};

/** Locate the list item the pointer aims at, with insertion anchors. */
export function findDropTarget($pos: ResolvedPos): DropTarget | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (ITEM_TYPES.has(node.type.name)) {
      const listDepth = depth - 1;
      const liftDepth = depth - 2;
      const lift =
        liftDepth >= 1 && ITEM_TYPES.has($pos.node(liftDepth).type.name)
          ? { anchor: $pos.after(liftDepth), listDepth: liftDepth - 1 }
          : null;
      return {
        node,
        anchor: $pos.after(depth),
        listDepth,
        liftAnchor: lift ? lift.anchor : null,
        liftListDepth: lift ? lift.listDepth : null,
      };
    }
  }
  // A gap between two items resolves to the list itself: the previous item is
  // the effective target.
  const depth = $pos.depth;
  if (
    depth > 0 &&
    LIST_TYPES.has($pos.node(depth).type.name) &&
    $pos.nodeBefore &&
    ITEM_TYPES.has($pos.nodeBefore.type.name)
  ) {
    const liftDepth = depth - 1;
    const lift =
      liftDepth >= 1 && ITEM_TYPES.has($pos.node(liftDepth).type.name)
        ? { anchor: $pos.after(liftDepth), listDepth: liftDepth - 1 }
        : null;
    return {
      node: $pos.nodeBefore,
      anchor: $pos.pos,
      listDepth: depth,
      liftAnchor: lift ? lift.anchor : null,
      liftListDepth: lift ? lift.listDepth : null,
    };
  }
  return null;
}

function expectedItemType($pos: ResolvedPos, listDepth: number): string {
  return $pos.node(listDepth).type.name === "taskList" ? "taskItem" : "listItem";
}

/**
 * Widen the delete range to the parent list when the dragged item is its
 * list's only child.
 *
 * ProseMirror's replace fitter keeps a minimal `listItem` shell instead of
 * leaving a `bulletList` empty (`listItem+` may not match zero children), so
 * deleting just the item would leave an empty bullet behind after the move.
 */
function widenOnlyChildList(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } {
  const node = state.doc.nodeAt(from);
  if (!node || !ITEM_TYPES.has(node.type.name)) return { from, to };
  const $from = state.doc.resolve(from);
  const depth = $from.depth;
  if (
    depth > 0 &&
    LIST_TYPES.has($from.node(depth).type.name) &&
    $from.node(depth).childCount === 1
  ) {
    return { from: $from.before(depth), to: $from.after(depth) };
  }
  return { from, to };
}

/**
 * Plan an indent/outdent drop. Returns `null` whenever the move should fall
 * back to ProseMirror's stock behaviour (multi-block slices, cross-list-type
 * moves, non-list targets, plain align drags).
 */
export function analyzeBlockDrop(state: EditorState, ctx: DropContext): DropPlan | null {
  if (!ctx.moved || ctx.zone === "align") return null;
  if (ctx.slice.size === 0 || ctx.slice.content.childCount !== 1) return null;

  let src = ctx.slice.content.firstChild;
  if (!src) return null;
  // Dragging a whole one-item list drags the list wrapper; unwrap it so the
  // item can move inside another list.
  if (LIST_TYPES.has(src.type.name)) {
    if (src.childCount !== 1) return null;
    src = src.child(0);
    if (!src) return null;
  }

  const rawSource =
    ctx.sourcePos !== null
      ? state.doc.nodeAt(ctx.sourcePos)
        ? { from: ctx.sourcePos, to: ctx.sourcePos + state.doc.nodeAt(ctx.sourcePos)!.nodeSize }
        : null
      : !state.selection.empty
        ? { from: state.selection.from, to: state.selection.to }
        : null;
  if (!rawSource) return null;
  const source = widenOnlyChildList(state, rawSource.from, rawSource.to);

  const $drop = state.doc.resolve(ctx.dropPos);
  const target = findDropTarget($drop);
  if (!target) return null;

  if (ctx.zone === "indent") {
    const itemType = target.node.type.name;
    let node: PMNode;
    if (ITEM_TYPES.has(src.type.name)) {
      if (src.type.name !== itemType) return null; // keep task/literal lists apart
      node = src;
    } else {
      const type = state.schema.nodes[itemType];
      if (!type) return null;
      node = type.create(null, src);
    }
    return {
      source,
      insertPos: target.anchor,
      node,
      nest: { itemType },
    };
  }

  // Outdent: land the item one level up (next to the target's parent when the
  // target is itself nested), already at the destination level — no lift step.
  if (!ITEM_TYPES.has(src.type.name)) return null;
  const useLift = target.liftAnchor !== null && target.liftListDepth !== null;
  const listDepth = useLift ? target.liftListDepth! : target.listDepth;
  if (src.type.name !== expectedItemType($drop, listDepth)) return null;
  return {
    source,
    insertPos: useLift ? target.liftAnchor! : target.anchor,
    node: src,
    nest: null,
  };
}

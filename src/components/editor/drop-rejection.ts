/**
 * Drop rejection — the pure decision behind the editor's invalid-drop feedback.
 *
 * When a block is dragged, most targets are fine: drop it above, below or
 * inside a neighbour and the move engine reorders it. A few targets cannot
 * accept the move, and refusing them *silently* leaves the pointer with no
 * feedback at all — the block simply snaps back. This module decides, from ids
 * alone, whether the current drop target is one of those, so the editor can
 * paint a danger-tinted rejection state (and a screen reader can announce it)
 * without touching the DOM itself.
 *
 * Pure: no React, no ProseMirror, no DOM — unit-testable in isolation. The
 * editor is the only caller, so the verdict and its reasons stay in one place.
 */

/** Why a drop target was accepted, or why the drop was rejected. */
export type DropRejectionReason =
  /** No drag is in progress: there is nothing to accept or reject. */
  | "idle"
  /** The target is a legal destination for the dragged block. */
  | "ok"
  /** The pointer is not over a droppable block. */
  | "missing-target"
  /** The block is being dropped onto itself. */
  | "self"
  /** The block is being dropped inside its own subtree (a descendant). */
  | "descendant";

export type DropVerdict = { valid: boolean; reason: DropRejectionReason };

export type DropVerdictInput = {
  /** The block being dragged, or `null`/`undefined` when no drag is active. */
  draggingId?: string | null;
  /** The block under the pointer, or `null` when the pointer is over none. */
  targetId?: string | null;
  /** The block that contains the target, when that target is nested. */
  targetParentId?: string | null;
  /** Every block inside the dragged block's subtree. */
  descendants?: readonly string[];
};

/** Normalise an optional id: whitespace-only and `null` read as "absent". */
function normaliseId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Decide whether `targetId` may receive the block `draggingId`.
 *
 * A block's own subtree — the block itself plus every `descendant` — can never
 * receive it: a block cannot become its own child. A pointer that is not over
 * any block is a rejection too (there is no destination to drop into).
 * Everything else is a legal reorder/indent target.
 *
 * The decision is deliberately id-only and side-effect-free, so the editor can
 * run it on every `dragover` without allocation or DOM reads.
 */
export function dropVerdict(input: DropVerdictInput): DropVerdict {
  const dragging = normaliseId(input.draggingId);
  const target = normaliseId(input.targetId);

  if (dragging === "") return { valid: true, reason: "idle" };
  if (target === "") return { valid: false, reason: "missing-target" };
  if (target === dragging) return { valid: false, reason: "self" };

  const subtree = new Set<string>([dragging]);
  for (const child of input.descendants ?? []) {
    const childId = normaliseId(child);
    if (childId !== "") subtree.add(childId);
  }
  if (subtree.has(target)) return { valid: false, reason: "descendant" };

  const parent = normaliseId(input.targetParentId);
  if (parent !== "" && subtree.has(parent)) return { valid: false, reason: "descendant" };

  return { valid: true, reason: "ok" };
}

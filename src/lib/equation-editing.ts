/**
 * Pure edit state for the inline/block equation dialog.
 *
 * The dialog used to keep three independent `useState` values (`latex`,
 * `view`, `request`), which made "cancel" and "blur" implicit: closing the
 * component silently dropped the draft, and toggling to Preview unmounted the
 * textarea (losing focus and the caret). This reducer gives the editor one
 * explicit state machine:
 *
 *  - `edit` changes the draft source without touching `original`;
 *  - `view` only changes which pane is shown;
 *  - `dismiss` (Cancel, Escape, scrim click, blur) resets the draft to the
 *    source it was opened with — the document was never mutated, so the
 *    existing equation source is preserved;
 *  - `commitValue` returns the trimmed value to write, or `null` for empty.
 *
 * The module is DOM-free so the behaviour is unit-testable in the node test
 * environment.
 */

import type { EquationRequest } from "./editor-events";

export type EquationKind = "inline" | "block";
export type EquationView = "source" | "preview";

export type EquationRange = { from: number; to: number };

export type EquationDraft = {
  kind: EquationKind;
  /** Current editor contents. */
  latex: string;
  /** The source the draft was opened with (never mutated by `edit`). */
  original: string;
  view: EquationView;
  /** Position of the existing node being edited, or `null` when inserting. */
  pos: number | null;
  /** Selection replaced when inserting an inline equation from the toolbar. */
  range: EquationRange | null;
};

export type EquationDraftAction =
  | { type: "edit"; latex: string }
  | { type: "view"; view: EquationView }
  | { type: "cancel" }
  | { type: "dismiss" };

/** Build a draft from an `EQUATION_EVENT` payload. */
export function beginEquationDraft(request: EquationRequest): EquationDraft {
  const latex = typeof request.latex === "string" ? request.latex : "";
  const from = request.from;
  const to = request.to;
  return {
    kind: request.kind === "inline" ? "inline" : "block",
    latex,
    original: latex,
    view: "source",
    pos: typeof request.pos === "number" ? request.pos : null,
    range:
      typeof from === "number" && typeof to === "number" && to >= from
        ? { from, to }
        : null,
  };
}

/** Apply one dialog action. `cancel`/`dismiss` never keep a dirty source. */
export function equationDraftReducer(
  draft: EquationDraft,
  action: EquationDraftAction,
): EquationDraft {
  switch (action.type) {
    case "edit":
      return { ...draft, latex: action.latex };
    case "view":
      return { ...draft, view: action.view };
    case "cancel":
    case "dismiss":
      return { ...draft, latex: draft.original, view: "source" };
  }
}

/** Whether the draft differs from the source it was opened with. */
export function equationDraftIsDirty(draft: EquationDraft): boolean {
  return draft.latex !== draft.original;
}

/**
 * The value to write to the document on Apply, or `null` for a blank draft
 * (which closes without creating an empty node).
 */
export function equationCommitValue(draft: EquationDraft): string | null {
  const value = draft.latex.trim();
  return value.length > 0 ? value : null;
}

/** ProseMirror node name expected for a given equation kind. */
export function equationNodeName(kind: EquationKind): "inlineMath" | "blockMath" {
  return kind === "inline" ? "inlineMath" : "blockMath";
}

/**
 * Guard a stale `pos`: after a remote edit or a block move the position may
 * point at another node. Committing must update only an equation of the same
 * kind, never convert an unrelated block.
 */
export function equationNodeMatches(
  kind: EquationKind,
  node: { type?: { name?: string } } | null | undefined,
): boolean {
  return node?.type?.name === equationNodeName(kind);
}

/** How a new display equation should enter the document. */
export type BlockEquationInsertion =
  | { type: "replace"; from: number; to: number }
  | { type: "insert"; at: number };

/**
 * Block equations are block nodes: they cannot be inserted *inside* the
 * paragraph that owns the selection. `/equation` opens the dialog from an
 * empty paragraph, so replace that paragraph; otherwise insert after it (the
 * same rule the markdown auto-detect path uses).
 */
export function planBlockEquationInsertion(input: {
  hasTextblock: boolean;
  emptyTextblock: boolean;
  before: number;
  after: number;
  pos: number;
}): BlockEquationInsertion {
  if (input.hasTextblock && input.emptyTextblock) {
    return { type: "replace", from: input.before, to: input.after };
  }
  return { type: "insert", at: input.hasTextblock ? input.after : input.pos };
}

/** Scrim clicks close the dialog; clicks inside the panel do not. */
export function equationDismissFromScrim(
  target: unknown,
  currentTarget: unknown,
): boolean {
  return target !== null && target === currentTarget;
}

/**
 * A focus change that leaves the dialog (blur) dismisses the draft instead of
 * silently committing it. `contains` is supplied by the caller so this stays
 * DOM-free and testable.
 *
 * `relatedTarget: null` is deliberately *not* a dismissal: browsers report it
 * when focus moves to the document body, for example after clicking a
 * non-focusable part of the panel (the preview, a section label). The scrim
 * mousedown handler and Escape still close the dialog explicitly.
 */
export function equationDismissOnBlur(
  relatedTarget: unknown,
  currentTarget: { contains: (target: never) => boolean } | null,
): boolean {
  if (relatedTarget === null || relatedTarget === undefined) return false;
  if (currentTarget === null) return true;
  return !currentTarget.contains(relatedTarget as never);
}

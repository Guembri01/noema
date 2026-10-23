"use client";

/**
 * Editor motion tokens and the presentational row chrome.
 *
 * Extracted from ./page-editor; the public import path stays stable through
 * that module's re-export. Pure mappings only — the ProseMirror plugin that
 * plays them stays with the editor.
 */
import { GripVertical, Plus } from "lucide-react";
import { DUR, EASE } from "@/lib/design-tokens";

/* ----------------------------------------------------------- motion (§6/§19) */

/** The two block-lifecycle motions the editor animates. */
export type BlockMotion = "insert" | "remove";

/**
 * Height + opacity keyframes for a block entering (`insert`) or leaving
 * (`remove`). Animating the block's own height is what lets its neighbours
 * slide instead of jumping (DESIGN_SYSTEM §6, FRONTEND_PLAN 19.7); the opacity
 * ramp also hides the empty-block placeholder until the block has settled, so
 * it never flashes mid-insert.
 */
export function blockMotionFrames(action: BlockMotion, height: number): Keyframe[] {
  const measured = Number.isFinite(height) && height > 0 ? `${Math.round(height)}px` : "0px";
  const hidden: Keyframe = { height: "0px", opacity: 0, overflow: "hidden" };
  const shown: Keyframe = { height: measured, opacity: 1, overflow: "hidden" };
  return action === "insert" ? [hidden, shown] : [shown, hidden];
}

/** Duration + easing for a block lifecycle animation (base token, smooth). */
export function blockMotionOptions(): { duration: number; easing: string } {
  return { duration: DUR.base, easing: EASE.smooth };
}

/** Class marker applied while a block plays its enter/leave motion. */
export function blockMotionClass(action: BlockMotion): string {
  return action === "insert" ? "noema-block-insert" : "noema-block-remove";
}

/**
 * ProseMirror drop-cursor options: the drag destination is a 2px accent line
 * (FRONTEND_PLAN 19.8). Fed straight to `dropCursor`, so the indicator needs no
 * bespoke stylesheet and always uses the accent token.
 */
export function dropIndicatorOptions(): { color: string; width: number; class: string } {
  return { color: "var(--accent)", width: 2, class: "noema-drop-indicator" };
}

/**
 * Root class while a drag is live. Dragging must track the cursor 1:1, so the
 * whole editor drops its transitions (DESIGN_SYSTEM §6 "Dragging is 1:1").
 */
export function dragActiveClass(active: boolean): string {
  return active ? "u-no-transition noema-drag-active" : "";
}

/** Inline lift for the block under the cursor: shadow-2 + a slight scale. */
export function dropLiftStyle(): { boxShadow: string; transform: string } {
  return { boxShadow: "var(--shadow-2)", transform: "scale(1.01)" };
}

/** Spring-settle keyframes played when a drag ends (popovers/drag settle). */
export function dropSettleFrames(): Keyframe[] {
  return [
    { transform: "scale(1.01)", boxShadow: "var(--shadow-2)", offset: 0 },
    { transform: "scale(1)", boxShadow: "var(--shadow-1)", offset: 1 },
  ];
}

/** Duration + easing for the drag settle (base token, spring ease). */
export function dropSettleOptions(): { duration: number; easing: string } {
  return { duration: DUR.base, easing: EASE.spring };
}

/** Visibility inputs for a block's hover chrome (grip + add). */
export type RowChromeState = {
  hovered?: boolean;
  focused?: boolean;
  selected?: boolean;
};

/**
 * The drag handle + add-button fade in on row hover and stay put while the row
 * is focused or selected, so the keyboard path gets the same affordances as the
 * pointer (DESIGN_SYSTEM §8/§9). Colour-only motion via `.u-colors`.
 */
export function rowChromeClass(state: RowChromeState = {}): string {
  const visible = Boolean(state.hovered || state.focused || state.selected);
  return `noema-row-chrome u-colors ${visible ? "opacity-100" : "opacity-0"}`;
}

/**
 * Presentational block chrome: the drag grip and the + affordance.
 * Pure (no hooks), so it renders identically on the server and in this slice's
 * `renderToStaticMarkup` proof. The grip is decorative — the surrounding
 * `DragHandle` owns the actual drag behaviour, and the + stays chrome-only so
 * this slice never introduces a new command.
 */
export function EditorRowChrome({ state = {} }: { state?: RowChromeState }) {
  const visible = Boolean(state.hovered || state.focused || state.selected);
  return (
    <span
      className={rowChromeClass(state)}
      data-row-chrome=""
      data-chrome-visible={visible ? "true" : "false"}
    >
      <span className="noema-drag-handle" aria-hidden="true">
        <GripVertical className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
      <span className="noema-row-add" aria-hidden="true">
        <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
    </span>
  );
}


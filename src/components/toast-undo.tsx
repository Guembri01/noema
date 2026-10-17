"use client";

import type { CSSProperties } from "react";
import { t } from "@/lib/i18n";
import { UNDO_WINDOW_MS } from "@/lib/actions-client";

/**
 * The rendered "Undo" affordance for a toast.
 *
 * `withUndo` (see `@/lib/actions-client`) hands you the guard and the copy; this
 * is the button a surface renders for it. It is deliberately dumb: no state, no
 * timer, no re-render. The countdown is a pure CSS animation whose duration is
 * the undo window, so the bar empties in lockstep with the guard without ever
 * waking React — and `prefers-reduced-motion` neutralises it globally.
 *
 *   toast.custom((id) => (
 *     <UndoButton action="Delete" onUndo={() => undo(id)} />
 *   ));
 *
 * The `undo-countdown` keyframes live in `src/app/tokens.css` with the rest of
 * the motion vocabulary; the window is handed over as a local CSS custom
 * property, so a data-driven duration never becomes a hard-coded animation value.
 */

export type UndoButtonProps = {
  /** The action being undone, e.g. "Delete" — becomes "Undo Delete". */
  action: string;
  onUndo: () => void;
  /** Countdown window in ms; mirrors `withUndo`'s window. */
  windowMs?: number;
  locale?: string;
};

export function UndoButton({
  action,
  onUndo,
  windowMs = UNDO_WINDOW_MS,
  locale = "en",
}: UndoButtonProps) {
  const undoLabel = t(locale, "undo");
  return (
    <button
      type="button"
      onClick={onUndo}
      aria-label={`${undoLabel} ${action}`}
      aria-keyshortcuts="Control+Z"
      data-testid="undo-action"
      className="focus-ring u-interactive relative inline-flex items-center overflow-hidden rounded-sm px-2 py-1 text-sm font-medium text-accent"
    >
      {undoLabel}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
      >
        <span
          data-testid="undo-countdown"
          className="block h-full w-full origin-center bg-accent opacity-40"
          style={
            {
              // The window is data, not design: it rides a local custom property
              // and the animation consumes it.
              "--undo-window": `${windowMs}ms`,
              animationName: "undo-countdown",
              animationDuration: "var(--undo-window)",
              animationTimingFunction: "var(--ease-linear)",
              animationFillMode: "forwards",
            } as CSSProperties
          }
        />
      </span>
    </button>
  );
}

"use client";

import { t } from "@/lib/i18n";
import { NoemaMark } from "@/components/brand/noema-mark";
import { cn } from "@/lib/utils";
import { DUR, EASE, Z } from "@/lib/design-tokens";
import { FLOATING_CORNER } from "@/lib/floating-corner";

/**
 * The floating "Ask AI" button, bottom-right.
 *
 * A real `<button>` (not a `div role="button"`): it is focusable, activates on
 * Enter/Space, and announces itself — the pattern it replaces had to re-implement
 * all three by hand.
 *
 * Its corner is a shared contract, not a local choice: `FLOATING_CORNER.fab`
 * (see `src/lib/floating-corner.ts`) is the same source the transient bars that
 * stack above it read, because this button and the editor's undo/redo bar used to
 * be pinned to the same inset and drew on top of each other. The geometry is
 * exercised by `floating-corner.test.ts` and measured in a browser by
 * `npm run check:floating`.
 *
 * The mark is `NoemaMark`, the product's own letterform, painted with
 * `currentColor` so it stays legible in light, dark and high-contrast themes
 * without a second asset.
 *
 * Placement notes (learned the hard way elsewhere in this codebase): the button
 * is `position: fixed`, so it must NOT live inside an ancestor that has a
 * `transform` or `backdrop-filter` — those make that ancestor the containing block
 * and the button would drift. It is mounted as a direct child of the workspace
 * shell for that reason, and `check:popovers` measures it.
 */
export function ChatFab({
  open,
  onOpen,
  locale,
}: {
  /** The chat panel is open — the panel itself becomes the entry point. */
  open: boolean;
  onOpen: () => void;
  locale: string;
}) {
  const label = t(locale, "askAI");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="chat-fab"
      // `hidden` (not unmounting) keeps the button's node stable while the panel
      // is open, so `aria-expanded` stays truthful.
      className={cn(
        "focus-ring u-interactive u-transform fixed z-0 grid h-10 w-10 place-items-center",
        FLOATING_CORNER.fab,
        "rounded-full bg-action text-action-fg shadow-2 hover:scale-105 active:scale-95",
        open && "hidden",
      )}
      // Motion from the vocabulary: the spring easing is the one token that makes
      // a small control feel deliberate rather than abrupt.
      style={{
        zIndex: Z.sidebar,
        transition: `transform var(--dur-3) var(--ease-spring), box-shadow var(--dur-1) var(--ease-smooth)`,
      }}
    >
      <NoemaMark className="h-6 w-6" />
    </button>
  );
}

/** Exported for tests and for anyone building a second entry point. */
export const CHAT_FAB_MOTION = {
  duration: DUR.slower,
  easing: EASE.spring,
} as const;

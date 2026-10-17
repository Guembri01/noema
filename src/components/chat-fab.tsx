"use client";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { DUR, EASE, Z } from "@/lib/design-tokens";

/**
 * The floating "Ask AI" button, bottom-right.
 *
 * A real `<button>` (not a `div role="button"`): it is focusable, activates on
 * Enter/Space, and announces itself — the pattern it replaces had to re-implement
 * all three by hand.
 *
 * The mark is an inline SVG rather than an image file so it follows the theme:
 * `currentColor` is the accent foreground, so it stays legible in light, dark and
 * high-contrast without a second asset. Swap `NoemaMark` for an `<img>` if a
 * bitmap is ever wanted — nothing else in this file depends on it.
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
        "focus-ring u-interactive u-transform fixed bottom-5 end-5 z-0 grid h-10 w-10 place-items-center",
        "rounded-full bg-accent text-accent-fg shadow-2 hover:scale-105 active:scale-95",
        open && "hidden",
      )}
      // Motion from the vocabulary: the spring easing is the one token that makes
      // a small control feel deliberate rather than abrupt.
      style={{
        zIndex: Z.sidebar,
        transition: `transform var(--dur-3) var(--ease-spring), box-shadow var(--dur-1) var(--ease-smooth)`,
      }}
    >
      <NoemaMark />
    </button>
  );
}

/** Noema's mark: the "N" monogram, drawn with the current text colour. */
function NoemaMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" focusable="false">
      <path
        d="M6.5 17.5V6.5l11 11v-11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Exported for tests and for anyone building a second entry point. */
export const CHAT_FAB_MOTION = {
  duration: DUR.slower,
  easing: EASE.spring,
} as const;

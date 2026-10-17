/**
 * The desktop shell's native menu, as events.
 *
 * `src-tauri/src/shell.rs` owns the menu, and clicking an item emits
 * `shell://<id>` into the webview. Nothing listened to those events, so every
 * item in the Windows/Linux menu bar was decorative: it looked complete and did
 * nothing at all.
 *
 * The ids are mirrored here so both ends can be checked against each other, and
 * the translation to a *window* event is a pure function, so the rule is
 * unit-testable without a shell (and `shell-events.test.ts` reads the Rust file
 * to prove the two lists have not drifted).
 *
 * Why a window event rather than calling the action here: the bridge component
 * is rendered once, near the document root, while the surfaces that can act on a
 * menu item (open quick find, navigate to settings, start a backup) live deeper
 * in the tree. A window event is the same decoupling `noema:open-chat` already
 * uses, and it keeps this module free of React.
 */

/** Every menu id the shell emits, in menu order. */
export const SHELL_MENU_EVENTS = [
  "new-note",
  "quick-find",
  "search",
  "settings",
  "shortcuts",
  "about",
  "diagnostics",
  "backup",
  "check-update",
] as const;

export type ShellMenuEvent = (typeof SHELL_MENU_EVENTS)[number];

/** The event name the shell emits for a menu id. */
export function shellEventName(id: ShellMenuEvent): string {
  return `shell://${id}`;
}

/** Prefix of the window event the bridge dispatches for a menu id. */
export const SHELL_WINDOW_EVENT_PREFIX = "noema:shell:";

/**
 * The window event a menu id turns into.
 *
 * Namespaced under `noema:shell:` so a page can listen for exactly the menu
 * items it can serve and ignore the rest.
 */
export function shellWindowEvent(id: ShellMenuEvent): string {
  return `${SHELL_WINDOW_EVENT_PREFIX}${id}`;
}

/**
 * Narrow an event name to a menu id, or `null`.
 *
 * An unrecognised `shell://…` event is ignored rather than dispatched: a newer
 * shell may emit an item this build has no handler for, and inventing a window
 * event for it would only produce a listener nobody registered.
 */
export function shellMenuEventFrom(event: string): ShellMenuEvent | null {
  if (!event.startsWith("shell://")) return null;
  const id = event.slice("shell://".length);
  return (SHELL_MENU_EVENTS as readonly string[]).includes(id)
    ? (id as ShellMenuEvent)
    : null;
}

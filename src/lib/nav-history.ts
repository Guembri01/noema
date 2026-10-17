/**
 * Navigation history — the pure half of the back/forward controls.
 *
 * The browser's own history is opaque: `history.length` says nothing about
 * whether a *forward* entry exists, and it counts entries from before the
 * workspace was opened. So the app tracks its own depth:
 *
 *   depth     how many in-app navigations we are away from the entry point
 *   forward   how many times we went back without navigating forward afterwards
 *
 * That is exactly the pair of facts the buttons need, and it keeps the logic
 * testable without a DOM or a router.
 *
 * Why this exists at all: the installed desktop app has no browser chrome, so if
 * the app does not offer back/forward there is no way to go back at all.
 */

export type NavHistory = {
  /** In-app navigations away from the entry point. */
  depth: number;
  /** Entries available ahead, accumulated by going back. */
  forward: number;
};

export const NAV_HISTORY_INITIAL: NavHistory = { depth: 0, forward: 0 };

/** A new navigation (link click, redirect). A `replace` keeps the stack as-is. */
export function afterNavigating(state: NavHistory, options: { replace: boolean }): NavHistory {
  if (options.replace) return state;
  return { depth: state.depth + 1, forward: 0 };
}

/** We moved back: one step less deep, one more entry ahead. */
export function afterGoingBack(state: NavHistory): NavHistory {
  if (state.depth <= 0) return state;
  return { depth: state.depth - 1, forward: state.forward + 1 };
}

/** We moved forward: one step deeper, one fewer entry ahead. */
export function afterGoingForward(state: NavHistory): NavHistory {
  if (state.forward <= 0) return state;
  return { depth: state.depth + 1, forward: state.forward - 1 };
}

/** Back is available once we have navigated at least once. */
export function canGoBack(state: NavHistory): boolean {
  return state.depth > 0;
}

/** Forward is available only after going back without navigating forward again. */
export function canGoForward(state: NavHistory): boolean {
  return state.forward > 0;
}

/**
 * Pure focus-management engine backing the FEATURE_MATRIX row "Focus
 * management" (https://github.com/.../docs/FEATURE_MATRIX.md).
 *
 * B45 hardened the `ui/dialog` / `ui/dropdown-menu` primitives, but the
 * hand-rolled feature overlays (`topbar/actions-menu`, `who-has-access`,
 * `version-history`, `tickets/ticket-drawer`, `editor/equation-editor`) bypass
 * the primitive and have no Tab trap of their own. This module is the small,
 * DOM-free kernel those overlays can share: it takes a plain list of
 * {@link Focusable} descriptors and decides
 *
 *  - which elements are reachable at all ({@link isFocusable},
 *    {@link visibleFocusables}),
 *  - which element a Tab / Shift+Tab keydown should move to, wrapping at the
 *    ends ({@link nextStop}),
 *  - the first and last stop of a ring ({@link firstStop}, {@link lastStop}),
 *  - whether an overlay can still restore focus to its invoker
 *    ({@link resolveReturnTarget}),
 *  - the exact element a keydown should focus, or `null` to let the browser
 *    handle it ({@link trapPlan}), plus a human summary
 *    ({@link describeFocusPlan}).
 *
 * Everything here is pure and deterministic: no DOM, no React, and the caller's
 * arrays and descriptors are never mutated. The actual element identity is
 * carried by {@link Focusable.id}; a real overlay maps its DOM nodes to these
 * descriptors (or uses a structurally compatible type).
 */

/**
 * Minimal description of one candidate focus stop.
 *
 * Only `id` is required; every other field is an optional signal that a single
 * rule in {@link isFocusable} or {@link resolveReturnTarget} reads. A real
 * overlay can pass a DOM element typed as this shape by projecting only these
 * fields, so the engine stays free of `lib.dom.d.ts`.
 */
export type Focusable = {
  /** Stable identity used to match a stop across renders. */
  id: string;
  /** A disabled control is skipped by the tab order. */
  disabled?: boolean;
  /** Hidden (display:none / visibility:hidden / aria-hidden / inert). */
  hidden?: boolean;
  /** `tabindex`; `-1` keeps the node programmatically focusable only. */
  tabIndex?: number;
  /**
   * Still attached to the document. Only {@link resolveReturnTarget} reads
   * this; an absent value is treated as connected (`true`). A detached node
   * cannot be focused, so focus "return" must fall back.
   */
  connected?: boolean;
};

/**
 * Canonical CSS selector for natively focusable elements, matching the intent
 * of the `e2e/focus.spec.ts` probe (`a[href],button,input,select,textarea,
 * [tabindex]`) but excluding the two cases that still cannot take Tab focus:
 * disabled controls and `tabindex="-1"`. Use when an overlay must collect its
 * stops from a container (`root.querySelectorAll(focusableSelector)`).
 */
export const focusableSelector: string = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]",
  'audio[controls]',
  'video[controls]',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * True when `el` can be a real, visible tab stop: not disabled, not hidden and
 * not taken out of the sequential order with `tabindex="-1"`. (An object with
 * no `tabIndex` is treated as tabbable, matching the default for natively
 * focusable elements.)
 */
export function isFocusable(el: Focusable): boolean {
  if (el.disabled) return false;
  if (el.hidden) return false;
  if (el.tabIndex === -1) return false;
  return true;
}

/**
 * The visible tab stops of `list`: the elements that pass {@link isFocusable},
 * in their original order, as a fresh array. The headline rule is dropping
 * hidden overlays' contents; disabled controls and `tabindex="-1"` nodes are
 * excluded by the same predicate so callers never build a ring around an
 * element the browser would skip.
 */
export function visibleFocusables(list: readonly Focusable[]): Focusable[] {
  return list.filter(isFocusable);
}

/** The first element of `list`, or `null` when it is empty. */
export function firstStop(list: readonly Focusable[]): Focusable | null {
  return list.length > 0 ? list[0] : null;
}

/** The last element of `list`, or `null` when it is empty. */
export function lastStop(list: readonly Focusable[]): Focusable | null {
  return list.length > 0 ? list[list.length - 1] : null;
}

/**
 * Position of `current` in `list`, matching by object identity first and then
 * by {@link Focusable.id} so a re-render that hands over a fresh descriptor for
 * the same element still resolves. `null`/unknown `current` yields `-1`.
 */
function indexOfStop(
  list: readonly Focusable[],
  current: Focusable | null,
): number {
  if (!current) return -1;
  const byIdentity = list.indexOf(current);
  if (byIdentity !== -1) return byIdentity;
  return list.findIndex((el) => el.id === current.id);
}

/**
 * The element a Tab (`shift: false`) or Shift+Tab (`shift: true`) keydown
 * should move focus to from `current`, wrapping at the ends of `list`.
 *
 * - empty `list` -> `null`
 * - `current` absent from `list` (or `null`) -> the first stop on Tab, the last
 *   on Shift+Tab (i.e. entering the ring)
 * - a single-stop list -> that stop, both directions
 * - otherwise the next/previous element, wrapping past either end.
 *
 * `list` is expected to be the already-filtered ring (see
 * {@link visibleFocusables}); this function never mutates it.
 */
export function nextStop(
  list: readonly Focusable[],
  current: Focusable | null,
  { shift = false }: { shift?: boolean } = {},
): Focusable | null {
  const count = list.length;
  if (count === 0) return null;

  const index = indexOfStop(list, current);
  if (index === -1) return shift ? lastStop(list) : firstStop(list);

  const nextIndex = shift ? (index - 1 + count) % count : (index + 1) % count;
  return list[nextIndex];
}

/**
 * Decide where focus should land when an overlay closes: the recorded
 * `invoker` when it is still connected, otherwise the `fallback` (e.g. the
 * overlay's trigger or a stable container) when that is connected, otherwise
 * `null` (the caller lets the browser decide). A `connected` field that is
 * explicitly `false` disqualifies an element.
 */
export function resolveReturnTarget({
  invoker,
  fallback,
}: {
  invoker?: Focusable | null;
  fallback?: Focusable | null;
}): Focusable | null {
  if (invoker && invoker.connected !== false) return invoker;
  if (fallback && fallback.connected !== false) return fallback;
  return null;
}

/**
 * Why a {@link FocusPlan} picked its target:
 *  - `enter`: focus was outside the ring (or on a skipped element) and this is
 *    the initial stop,
 *  - `next` / `prev`: an ordinary step through the ring,
 *  - `only`: the ring has a single stop, so both directions stay on it.
 */
export type FocusReason = "enter" | "next" | "prev" | "only";

/** The outcome of {@link trapPlan}: what to focus, and why. */
export type FocusPlan = {
  /** The exact element the keydown should focus. */
  target: Focusable;
  reason: FocusReason;
  /** True when the step crossed an end of the ring. */
  wrapped: boolean;
};

/**
 * The plan for a Tab / Shift+Tab keydown inside a trapping overlay: the exact
 * element to focus, or `null` when there is nothing to trap and the browser
 * should keep the default (so an empty or fully hidden overlay never swallows
 * the key).
 *
 * `initial` is the element currently focused (usually
 * `document.activeElement`); when it is `null` or not a real stop of the ring
 * (`hidden` / `disabled` / `tabindex="-1"` / absent) the plan *enters* the ring
 * - the first stop on Tab, the last on Shift+Tab. This is also the choice an
 * overlay makes on open: `trapPlan(stops, { initial: null })` names the initial
 * focus target. The ring is `visibleFocusables(list)`; the input is untouched.
 */
export function trapPlan(
  list: readonly Focusable[],
  { initial = null, shift = false }: { initial?: Focusable | null; shift?: boolean } = {},
): FocusPlan | null {
  const ring = visibleFocusables(list);
  const count = ring.length;
  if (count === 0) return null;

  const index = indexOfStop(ring, initial);
  if (index === -1) {
    const target = shift ? ring[count - 1] : ring[0];
    return { target, reason: "enter", wrapped: false };
  }

  if (count === 1) {
    return { target: ring[0], reason: "only", wrapped: false };
  }

  const nextIndex = shift ? (index - 1 + count) % count : (index + 1) % count;
  const wrapped = shift ? index === 0 : index === count - 1;
  return {
    target: ring[nextIndex],
    reason: shift ? "prev" : "next",
    wrapped,
  };
}

/**
 * Human-readable summary of a {@link trapPlan} result, for logging and tests:
 * `"release: nothing to focus"` for a `null` plan, otherwise
 * `"focus #<id> (<reason>[, wrap])"`.
 */
export function describeFocusPlan(plan: FocusPlan | null): string {
  if (!plan) return "release: nothing to focus";
  const wrap = plan.wrapped ? ", wrap" : "";
  return `focus #${plan.target.id} (${plan.reason}${wrap})`;
}

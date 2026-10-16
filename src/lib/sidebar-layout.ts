/**
 * Sidebar width model.
 *
 * Kept in `src/lib` (not inside the client component) so the clamping rules are
 * unit-testable in the repo's node-only vitest environment, and so both the
 * drag handler and the keyboard handler share one source of truth.
 */

/** localStorage key holding the user's chosen sidebar width, in px. */
export const SIDEBAR_WIDTH_STORAGE_KEY = "noema:sidebar-width";

/** localStorage key holding whether the desktop sidebar is collapsed. */
export const SIDEBAR_HIDDEN_STORAGE_KEY = "noema:sidebar-hidden";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 240;

/** Default step (px) for a keyboard nudge; Shift widens the step. */
export const SIDEBAR_STEP = 12;
export const SIDEBAR_STEP_LARGE = 40;

/** Clamp an arbitrary value into the allowed sidebar width range. */
export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

/**
 * Resolve the next width for a keyboard nudge. `delta` is in px (negative
 * narrows). Unusable input falls back to the default width.
 */
export function nudgeSidebarWidth(current: number, delta: number, shift = false): number {
  const base = Number.isFinite(current) ? current : SIDEBAR_DEFAULT_WIDTH;
  const step = !Number.isFinite(delta) ? 0 : shift ? delta * (SIDEBAR_STEP_LARGE / SIDEBAR_STEP) : delta;
  return clampSidebarWidth(base + step);
}

/**
 * Width implied by dragging from `startWidth` when the pointer has moved
 * `deltaX` px horizontally.
 */
export function dragSidebarWidth(startWidth: number, deltaX: number): number {
  const base = Number.isFinite(startWidth) ? startWidth : SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(base + (Number.isFinite(deltaX) ? deltaX : 0));
}

/** Parse a persisted width; absent/corrupt values fall back to the default. */
export function parseStoredSidebarWidth(raw: string | null): number {
  if (raw === null || raw.trim() === "") return SIDEBAR_DEFAULT_WIDTH;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
}

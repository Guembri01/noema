/**
 * Design tokens, in TypeScript form.
 *
 * `globals.css` owns the CSS variables; this module exposes the same values to
 * JSX that needs them inline (`style={{ zIndex: Z.modal }}`) or to logic that
 * must agree with the stylesheet (durations, breakpoints). Keep the two in sync:
 * `design-tokens.test.ts` pins the numbers so a drift fails the suite.
 *
 * Rules (see docs/DESIGN_SYSTEM.md):
 * - never a magic z-index → `Z.*`
 * - never an ad-hoc duration → `DUR.*`
 * - never a raw radius/shadow → `RADIUS.*` / `SHADOW.*`
 */

/** Layering order. Mirrors `--z-*` in globals.css. */
export const Z = {
  base: 0,
  sticky: 10,
  sidebar: 30,
  overlay: 40,
  popover: 50,
  modal: 60,
  toast: 70,
  tooltip: 80,
  drag: 90,
} as const;

/** Motion durations in ms. Mirrors `--dur-*`. */
export const DUR = {
  instant: 80,
  fast: 120,
  base: 180,
  slow: 240,
  slower: 320,
} as const;

/** Easing curves. Mirrors `--ease-*`. */
export const EASE = {
  smooth: "cubic-bezier(0.2, 0, 0, 1)",
  inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
  spring: "cubic-bezier(0.34, 1.32, 0.64, 1)",
} as const;

/** Radii in px. Mirrors `--radius-*`. */
export const RADIUS = {
  xs: 3,
  sm: 4,
  md: 6,
  lg: 10,
  xl: 14,
  full: 999,
} as const;

/** Shadows. Mirrors `--shadow-*`. */
export const SHADOW = {
  raised: "var(--shadow-1)",
  popover: "var(--shadow-2)",
  modal: "var(--shadow-3)",
  focus: "var(--shadow-focus)",
} as const;

/** Spacing grid step (px). Tailwind's `p-1` == 4px. */
export const SPACE = 4;

/** Responsive breakpoints in px. Mirrors the Tailwind defaults we rely on. */
export const BREAKPOINT = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

/** Tag palette hue names, matching `--tag-<hue>-*`. */
export const TAG_PALETTE = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "teal",
] as const;

export type TagHue = (typeof TAG_PALETTE)[number];

/** Type guard for a tag hue coming from untrusted data. */
export function isTagHue(value: unknown): value is TagHue {
  return typeof value === "string" && (TAG_PALETTE as readonly string[]).includes(value);
}

/**
 * CSS class string for a tag of the given hue. Falls back to gray so an unknown
 * hue can never render an unstyled chip.
 */
export function tagClass(hue: string | null | undefined): string {
  const safe: TagHue = isTagHue(hue) ? hue : "gray";
  return `tag tag-${safe}`;
}

/**
 * Inline style for a tag of the given hue — used where a Tailwind class is not
 * possible (e.g. dynamic user colours).
 */
export function tagStyle(hue: string | null | undefined): Record<string, string> {
  const safe: TagHue = isTagHue(hue) ? hue : "gray";
  return {
    color: `var(--tag-${safe}-fg)`,
    background: `var(--tag-${safe}-bg)`,
    borderColor: `var(--tag-${safe}-bd)`,
  };
}

/**
 * High-contrast theme tokens + WCAG contrast math.
 *
 * Backs docs/MISSING_FEATURES.md §16 "High-contrast support": the values below
 * are mirrored verbatim by the `.high-contrast` / `.high-contrast.dark` and
 * `@media (prefers-contrast: more)` override blocks in `src/app/globals.css`.
 * `high-contrast.test.ts` asserts the two stay in sync, so change both or the
 * suite goes red.
 *
 * The class is applied to the document root (`<html class="high-contrast">`);
 * the media query covers the OS/browser preference with no JS at all.
 */

/** Which token map applies — `.dark` on the root selects the dark variant. */
export type ContrastTheme = "light" | "dark";

/** Custom properties overridden by the high-contrast variant. */
export type ContrastToken =
  | "bg"
  | "sidebar"
  | "surface"
  | "surface-2"
  | "border"
  | "fg"
  | "muted"
  | "accent"
  | "accent-fg"
  | "selection";

export type TokenMap = Record<ContrastToken, string>;

/**
 * Opaque hex colours chosen to clear WCAG AA (4.5:1) for body/muted/accent text
 * and WCAG 1.4.11 (3:1) for borders against every surface, in both themes.
 */
export const HIGH_CONTRAST_TOKENS: Record<ContrastTheme, TokenMap> = {
  light: {
    bg: "#ffffff",
    sidebar: "#f5f5f5",
    surface: "#ececec",
    "surface-2": "#e0e0e0",
    border: "#767676",
    fg: "#1b1b1b",
    muted: "#4a4a4a",
    accent: "#0b57d0",
    "accent-fg": "#ffffff",
    selection: "#a6c9f7",
  },
  dark: {
    bg: "#000000",
    sidebar: "#0a0a0a",
    surface: "#151515",
    "surface-2": "#202020",
    border: "#8a8a8a",
    fg: "#ffffff",
    muted: "#c9c9c9",
    accent: "#7cb8ff",
    "accent-fg": "#000000",
    selection: "#1f4a7a",
  },
};

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance (0 = black, 1 = white) of a `#rgb`/`#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  if (!HEX_RE.test(hex)) {
    throw new Error(`Not a hex colour: ${String(hex)}`);
  }
  const body = hex.slice(1);
  const digits =
    body.length === 3
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body;
  const r = parseInt(digits.slice(0, 2), 16);
  const g = parseInt(digits.slice(2, 4), 16);
  const b = parseInt(digits.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours (1 = identical, 21 = black vs white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Whether `fg` on `bg` clears a contrast threshold.
 * Defaults to 4.5 (WCAG AA text); pass 3 for WCAG 1.4.11 non-text UI parts.
 */
export function meetsContrast(fg: string, bg: string, minimum = 4.5): boolean {
  return contrastRatio(fg, bg) >= minimum;
}

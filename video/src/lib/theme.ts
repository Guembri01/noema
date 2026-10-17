/**
 * The film's design system.
 *
 * Every value here is lifted from the product's own tokens
 * (`src/app/tokens.css` + `src/app/globals.css`) rather than invented for a
 * trailer: the film is supposed to look like it came out of the app, so the
 * palette, the radii and — most importantly — the two easing curves are the
 * app's. `--ease-smooth` is what every Noema transition uses; a cut that moves
 * on a different curve reads as a different product.
 */

export const NOEMA = {
  bg: "#ffffff",
  sidebar: "#f7f7f5",
  surface: "#f1f1ef",
  surface3: "#e7e7e4",
  border: "#e9e9e7",
  borderStrong: "#d3d3cf",
  fg: "#37352f",
  muted: "#6b6a65",
  subtle: "#8a8a84",
  accent: "#1a75d2",
  accentSoft: "rgba(26, 117, 210, 0.10)",
  danger: "#d44c47",
  success: "#448361",
  warning: "#cb912f",
  /** The three surfaces a shot can stand on, dark. */
  dark: {
    bg: "#191919",
    sidebar: "#202020",
    surface: "#2c2c2c",
    border: "#2f2f2f",
    fg: "rgba(255, 255, 255, 0.81)",
    muted: "rgba(255, 255, 255, 0.52)",
    accent: "#4c9bea",
  },
  /** The app's 10-hue tag palette: [fg, bg, border]. */
  tag: {
    gray: ["#5a5a55", "#f1f1ef", "#e3e3e0"],
    brown: ["#8a5a3b", "#f4eeee", "#ecdcd3"],
    orange: ["#b5602a", "#faebdd", "#f2d5bd"],
    yellow: ["#9a7621", "#fbf3db", "#f0e2b6"],
    green: ["#3f7d54", "#edf3ec", "#d7e6d8"],
    blue: ["#2a6bb0", "#e7f0fb", "#c9ddf5"],
    purple: ["#6b4fa8", "#f0ecf9", "#ddd4f0"],
    pink: ["#ad4a76", "#f9eef4", "#f0d6e3"],
    red: ["#b03a38", "#fbeceb", "#f3d3d1"],
    teal: ["#2c7a72", "#e8f2f1", "#cfe4e2"],
  },
} as const;

export type TagHue = keyof typeof NOEMA.tag;

/** The app's motion vocabulary — the same two curves the interface uses. */
export const EASE = {
  /** `--ease-smooth: cubic-bezier(0.2, 0, 0, 1)` — every UI transition. */
  smooth: [0.2, 0, 0, 1] as const,
  /** `--ease-in-out-soft: cubic-bezier(0.4, 0, 0.2, 1)` — shimmers, loops. */
  inOutSoft: [0.4, 0, 0.2, 1] as const,
  /** `--ease-spring: cubic-bezier(0.34, 1.32, 0.64, 1)` — the settle. */
  spring: [0.34, 1.32, 0.64, 1] as const,
  /** Camera moves only. Slower out of the gate than the UI's curve, so a push
   *  reads as weight rather than a snap. */
  camera: [0.33, 0, 0.15, 1] as const,
};

export const FONT =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** Radius scale from the app (`--radius-sm` … `--radius-xl`). */
export const RADIUS = { sm: 4, md: 6, lg: 10, xl: 14 };

/** The app's `--shadow-2`, at film scale. */
export const SHADOW = {
  card: "0 1px 2px rgba(15,15,15,0.06), 0 0 0 1px rgba(15,15,15,0.04)",
  lifted: "0 10px 30px rgba(15,15,15,0.10), 0 0 0 1px rgba(15,15,15,0.05)",
  float: "0 24px 60px rgba(15,15,15,0.16), 0 0 0 1px rgba(15,15,15,0.06)",
  dark: "0 10px 30px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06)",
} as const;

/**
 * Type sizes for the film, not the app. Q11 in the skill's rulebook: a caption
 * must be at least 5.2% of the 1080px frame (56px) or it cannot be read, and
 * auxiliary labels at least 32px.
 */
export const TYPE = {
  caption: 58,
  label: 34,
  kicker: 34,
  cardTitle: 132,
  wordmark: 220,
} as const;

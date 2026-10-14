/**
 * WCAG 2.x contrast utilities — pure colour math for theme/token checks.
 *
 * Companion to `high-contrast.ts`, which pins a fixed set of hex tokens. This
 * module is the general-purpose toolkit: it accepts `#rgb`/`#rrggbb`, `rgb()`
 * and `rgba()`, exposes relative luminance and contrast ratios, answers the
 * WCAG AA/AAA question, and picks a readable text colour for a background.
 *
 * Everything here is pure and synchronous — no DOM, no CSS, no colour profiles.
 * Colours are treated as sRGB 8-bit channels (`0..255`); alpha is only ever
 * *input* to `blendColors` and never part of the returned channel triple.
 */

/** An sRGB colour as 8-bit channels. */
export type Rgb = { r: number; g: number; b: number };

/** Anything the utilities accept: a CSS colour string or an already-parsed `Rgb`. */
export type ColorInput = string | Rgb;

/** WCAG conformance level. */
export type WCAGLevel = "AA" | "AAA";

export type WCAGOptions = {
  level: WCAGLevel;
  /** Large text (≥ 18pt, or ≥ 14pt bold) relaxes the AA/AAA thresholds. */
  large?: boolean;
};

export type BestTextColorOptions = {
  /** Candidate foreground colours; the highest-contrast one is returned. */
  candidates: readonly string[];
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_RE = /^rgba?\(\s*([^)]*)\s*\)$/i;

/** Split the inside of an `rgb()`/`rgba()` call into its numeric parts. */
function rgbParts(body: string): string[] {
  // Accept `r, g, b`, `r, g, b, a`, `r g b` and `r g b / a`.
  return body.split(/[\s,/]+/).filter((part) => part !== "");
}

function channel(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid color: ${label} channel "${value}" is not an integer 0-255.`);
  }
  const n = Number(value);
  if (n > 255) {
    throw new Error(`Invalid color: ${label} channel ${n} is outside 0-255.`);
  }
  return n;
}

function alpha(value: string): void {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`Invalid color: alpha "${value}" is not between 0 and 1.`);
  }
}

/**
 * Parse a CSS colour into `{ r, g, b }` (each `0..255`).
 *
 * Accepts `#rgb`, `#rrggbb`, `rgb(r, g, b)`, `rgb(r g b)` and `rgba(...)`; an
 * `rgba()` alpha is validated (0..1) and then discarded, since this module
 * models opaque channels. Anything else — named colours, malformed values,
 * channels outside 0..255 — throws.
 */
export function parseColor(input: string): Rgb {
  if (typeof input !== "string") {
    throw new Error(`Invalid color: expected a string, got ${typeof input}.`);
  }
  const value = input.trim();

  if (HEX_RE.test(value)) {
    const body = value.slice(1);
    const digits =
      body.length === 3
        ? body
            .split("")
            .map((c) => c + c)
            .join("")
        : body;
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }

  const match = RGB_RE.exec(value);
  if (match) {
    const [r, g, b, a, ...rest] = rgbParts(match[1]);
    if (r === undefined || g === undefined || b === undefined || rest.length > 0) {
      throw new Error(`Invalid color: ${value} needs exactly 3 channels.`);
    }
    if (a !== undefined) alpha(a);
    return { r: channel(r, "red"), g: channel(g, "green"), b: channel(b, "blue") };
  }

  throw new Error(`Invalid color: ${JSON.stringify(value)} is not a hex or rgb() colour.`);
}

/** Normalise a `ColorInput` to `Rgb`. */
function toRgb(color: ColorInput): Rgb {
  return typeof color === "string" ? parseColor(color) : color;
}

/** The WCAG sRGB-linearised channel transfer function. */
function linearize(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG 2.x relative luminance (`0` = black, `1` = white) of a colour.
 */
export function relativeLuminance(color: ColorInput): number {
  const { r, g, b } = toRgb(color);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * WCAG contrast ratio between two colours: `1` for identical colours up to
 * `21` for black on white. Symmetric in its arguments.
 */
export function contrastRatio(a: ColorInput, b: ColorInput): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Minimum contrast ratios from WCAG 2.1 SC 1.4.3 (AA) and 1.4.6 (AAA). */
const THRESHOLDS: Record<WCAGLevel, { normal: number; large: number }> = {
  AA: { normal: 4.5, large: 3 },
  AAA: { normal: 7, large: 4.5 },
};

/**
 * Whether a contrast `ratio` satisfies `level` for the given text size
 * (`large` defaults to false).
 */
export function meetsWCAG(ratio: number, options: WCAGOptions): boolean {
  const bounds = THRESHOLDS[options.level];
  return ratio >= (options.large === true ? bounds.large : bounds.normal);
}

/**
 * Pick the candidate colour with the highest contrast against `bg`. Ties go to
 * the earliest candidate, so the order acts as a preference. Throws when
 * `candidates` is empty. The winning candidate is returned verbatim.
 */
export function bestTextColor(bg: ColorInput, options: BestTextColorOptions): string {
  if (options.candidates.length === 0) {
    throw new Error("bestTextColor requires at least one candidate.");
  }
  let best = options.candidates[0];
  let bestRatio = contrastRatio(best, bg);
  for (const candidate of options.candidates.slice(1)) {
    const ratio = contrastRatio(candidate, bg);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * Composite `fg` over `bg` at `alpha` (`1` = pure `fg`, `0` = pure `bg`),
 * per channel, rounded to the nearest integer. `alpha` must be within `0..1`.
 */
export function blendColors(fg: ColorInput, bg: ColorInput, alphaValue: number): Rgb {
  if (!Number.isFinite(alphaValue) || alphaValue < 0 || alphaValue > 1) {
    throw new Error(`Invalid alpha: expected 0..1, got ${String(alphaValue)}.`);
  }
  const f = toRgb(fg);
  const b = toRgb(bg);
  const mix = (channelFg: number, channelBg: number): number =>
    Math.round(channelFg * alphaValue + channelBg * (1 - alphaValue));
  return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b) };
}

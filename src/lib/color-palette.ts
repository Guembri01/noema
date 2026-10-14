/**
 * Colour palette generation — pure, deterministic tint/shade math.
 *
 * Companion to `theme-contrast.ts` (which answers the WCAG contrast question):
 * this module *builds* colours. It parses `#rgb`/`#rrggbb`, serialises back to
 * `#rrggbb`, mixes channels towards white (`lighten`/`tint`) or black
 * (`darken`/`shade`), and expands a single base colour into an ordered 50–900
 * scale like the ones design systems ship.
 *
 * Everything is pure and synchronous — no DOM, no CSS, no colour profiles.
 * Channels are sRGB 8-bit (`0..255`); every transform rounds to the nearest
 * integer and clamps into range, so output is always a valid `#rrggbb` string
 * and repeated calls with the same input are byte-for-byte identical.
 */

import type { Rgb } from "./theme-contrast";

/** Ordered palette stops, lightest to darkest. */
export const PALETTE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/** A single stop on a generated palette. */
export type PaletteStep = (typeof PALETTE_STEPS)[number];

/** A generated palette: one opaque `#rrggbb` colour per stop. */
export type Palette = Record<PaletteStep, string>;

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Whether `value` is a `#rgb` or `#rrggbb` colour (case-insensitive). */
export function isValidHex(value: string): boolean {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

/**
 * Parse `#rgb`/`#rrggbb` into an `Rgb`. Shorthand expands each nibble. `#` is
 * required; anything else — missing `#`, wrong length, non-hex digits — throws.
 */
export function parseHex(hex: string): Rgb {
  if (typeof hex !== "string" || !HEX_RE.test(hex.trim())) {
    throw new Error(`Invalid hex color: ${JSON.stringify(hex)} is not #rgb or #rrggbb.`);
  }
  const body = hex.trim().slice(1);
  const digits = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
  };
}

/** Clamp a channel to an integer within `0..255` (non-finite values become 0). */
function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Serialise an `Rgb` as a lowercase, zero-padded `#rrggbb` string. */
export function toHex(rgb: Rgb): string {
  const part = (value: number): string =>
    clampChannel(value).toString(16).padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** Clamp `value` into `[min, max]`, mapping non-finite input to `min`. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Mix one channel towards `target` (white = 255, black = 0) by `amount`. */
function mix(channel: number, target: number, amount: number): number {
  return channel + (target - channel) * amount;
}

/**
 * Move `hex` towards white by `amount` (`0` = unchanged, `1` = white).
 * `amount` is clamped to `0..1`.
 */
export function lighten(hex: string, amount: number): string {
  const a = clamp(amount, 0, 1);
  const { r, g, b } = parseHex(hex);
  return toHex({ r: mix(r, 255, a), g: mix(g, 255, a), b: mix(b, 255, a) });
}

/**
 * Move `hex` towards black by `amount` (`0` = unchanged, `1` = black).
 * `amount` is clamped to `0..1`.
 */
export function darken(hex: string, amount: number): string {
  const a = clamp(amount, 0, 1);
  const { r, g, b } = parseHex(hex);
  return toHex({ r: mix(r, 0, a), g: mix(g, 0, a), b: mix(b, 0, a) });
}

/** Mix `hex` towards white by `percent` (`0..100`). Clamped. */
export function tint(hex: string, percent: number): string {
  return lighten(hex, clamp(percent, 0, 100) / 100);
}

/** Mix `hex` towards black by `percent` (`0..100`). Clamped. */
export function shade(hex: string, percent: number): string {
  return darken(hex, clamp(percent, 0, 100) / 100);
}

/** How far each stop moves from the base `500`, towards white below / black above. */
const SCALE: Record<PaletteStep, number> = {
  50: 0.95,
  100: 0.9,
  200: 0.8,
  300: 0.6,
  400: 0.3,
  500: 0,
  600: 0.15,
  700: 0.35,
  800: 0.55,
  900: 0.75,
};

/**
 * Expand a base colour into an ordered `50..900` palette: `500` is the base
 * itself (normalised to `#rrggbb`), lower stops are tinted towards white and
 * higher stops shaded towards black. Deterministic and pure.
 */
export function generatePalette(base: string): Palette {
  const normalized = toHex(parseHex(base));
  return {
    50: lighten(normalized, SCALE[50]),
    100: lighten(normalized, SCALE[100]),
    200: lighten(normalized, SCALE[200]),
    300: lighten(normalized, SCALE[300]),
    400: lighten(normalized, SCALE[400]),
    500: normalized,
    600: darken(normalized, SCALE[600]),
    700: darken(normalized, SCALE[700]),
    800: darken(normalized, SCALE[800]),
    900: darken(normalized, SCALE[900]),
  };
}

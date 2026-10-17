/**
 * The one colour catalogue.
 *
 * Before this module every tag-hue consumer carried its own copy of the hue
 * list and its own `var(--tag-<hue>-*)` string builder: `block-colors.ts`
 * (block backgrounds), `database-types.ts` (option chips) and
 * `design-tokens.ts` (`tagStyle`/`tagClass`). The persisted ids live in the
 * token layer — this file is the single façade over them, so a hue is declared
 * once and both catalogues resolve through the same lookups.
 *
 * The list itself is {@link HUE_NAMES}, a re-export of `TAG_HUES` from
 * `@/lib/design-tokens` (the CSS variables in `tokens.css` are the real source;
 * `design-tokens.test.ts` keeps the two in sync). Everything here is pure and
 * fail-soft: a missing or unknown hue reads as `gray` so a swatch can never be
 * left unstyled.
 *
 * Additive only — this changes no persisted value. Block-colour ids (`"gray"`
 * … `"red"`) and option ids keep round-tripping exactly as before; only the
 * lookup that turns them into a token moved here.
 */

import { TAG_HUES, isTagHue, type TagHue } from "@/lib/design-tokens";

/** Every hue the tag palette defines, in menu order (the single hue list). */
export const HUE_NAMES = TAG_HUES;

/** Human labels for each hue (used by the block-colour menu). */
export const HUE_LABELS: Record<TagHue, string> = {
  gray: "Gray",
  brown: "Brown",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  red: "Red",
  teal: "Teal",
};

/** Type guard for a tag hue coming from untrusted data. */
export function isHue(value: unknown): value is TagHue {
  return isTagHue(value);
}

/**
 * Normalise a persisted colour id to a hue in the shared palette. Anything
 * unknown — a stale id, a future hue, `null` — reads as `gray` so a swatch is
 * never left unstyled. This is the single normaliser every lookup below calls.
 */
export function normalizeHue(hue: string | null | undefined): TagHue {
  return isTagHue(hue) ? hue : "gray";
}

/** The tag ink (`--tag-<hue>-fg`) for a hue, defaulting to gray. */
export function hueInk(hue: string | null | undefined): string {
  return `var(--tag-${normalizeHue(hue)}-fg)`;
}

/** The tag surface (`--tag-<hue>-bg`) for a hue, defaulting to gray. */
export function hueSurface(hue: string | null | undefined): string {
  return `var(--tag-${normalizeHue(hue)}-bg)`;
}

/** The tag edge (`--tag-<hue>-bd`) for a hue, defaulting to gray. */
export function hueEdge(hue: string | null | undefined): string {
  return `var(--tag-${normalizeHue(hue)}-bd)`;
}

/** The display label for a hue, defaulting to gray's. */
export function hueLabel(hue: string | null | undefined): string {
  return HUE_LABELS[normalizeHue(hue)];
}

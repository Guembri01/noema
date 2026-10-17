import { Extension } from "@tiptap/core";
import { HUE_NAMES, hueInk, hueLabel, hueSurface } from "@/lib/palette";
import type { TagHue } from "@/lib/design-tokens";

/**
 * Notion-style block background colours.
 *
 * Every block that can be painted carries a `blockColor` attribute (one of
 * the palette names, not a raw hex, so the presentation owns the values and a
 * future dark theme only has to remap them). The attribute is added globally so
 * the schema change lives in one place instead of per-node.
 */
export const BLOCK_COLOR_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "toggle",
] as const;

/**
 * The nine block-background hues Notion offers, in menu order.
 *
 * Each one is also a design-system tag hue, so a painted block reads
 * `--tag-<hue>-bg` for the tint and `--tag-<hue>-fg` for legible text. That
 * keeps light / dark / high-contrast working from a single source instead of a
 * literal hex per row.
 */
export const BLOCK_COLOR_HUES = HUE_NAMES.filter(
  (hue): hue is Exclude<TagHue, "teal"> => hue !== "teal",
);

export type BlockColorHue = (typeof BLOCK_COLOR_HUES)[number];

/** One palette row: a stable persisted id plus the tag hue that paints it. */
export type BlockColorEntry = {
  /** i18n label (`block-context-menu.tsx` maps it to a catalogue key). */
  label: string;
  /**
   * The persisted id written to `data-block-color` and JSON. `null` is Default
   * (clears the colour). This value is a serialization contract — never
   * renumber it; it round-trips through `doc-renderer.tsx`, the paste path and
   * the `.noema-*` stylesheet.
   */
  value: BlockColorHue | null;
  /** Tag hue whose `--tag-<hue>-{bg,fg}` pair paints this colour. */
  hue: BlockColorHue | null;
  /** Swatch background token (`var(--tag-<hue>-bg)`), or `transparent`. */
  tint: string;
};

/**
 * Legacy → token mapping. The stored **id is unchanged** (still `"gray"`,
 * `"brown"`, …, the value every saved document and paste already carries); only
 * the *presentation* moved from a hard-coded hex to the shared tag token:
 *
 *   gray   #f1f1ef → var(--tag-gray-bg)
 *   brown  #eee0da → var(--tag-brown-bg)
 *   orange #faebdd → var(--tag-orange-bg)
 *   yellow #fbf3db → var(--tag-yellow-bg)
 *   green  #edf3ec → var(--tag-green-bg)
 *   blue   #e7f3f8 → var(--tag-blue-bg)
 *   purple #f6f3f9 → var(--tag-purple-bg)
 *   pink   #fbe4e8 → var(--tag-pink-bg)
 *   red    #fdebec → var(--tag-red-bg)
 *
 * (The token values are the tag palette's, so a few tints differ by a shade
 * from the old one-off hexes — that is the point of a single source.)
 */

/** The nine tints Notion offers, plus Default (which clears the colour). */
export const BLOCK_COLORS: BlockColorEntry[] = [
  { label: "Default", value: null, hue: null, tint: "transparent" },
  ...BLOCK_COLOR_HUES.map((hue): BlockColorEntry => ({
    label: hueLabel(hue),
    value: hue,
    hue,
    tint: hueSurface(hue),
  })),
];

/**
 * The tag hue a stored block-colour id paints with, or `null` when the id is
 * missing / unknown (a block that is not tinted, or data from an older
 * catalogue). Reads the catalogue rather than assuming id === hue, so renaming
 * a hue only touches {@link BLOCK_COLORS}.
 */
export function blockColorHue(id: string | null | undefined): BlockColorHue | null {
  if (typeof id !== "string") return null;
  const key = id.trim().toLowerCase();
  const entry = BLOCK_COLORS.find((candidate) => candidate.value === key);
  return entry?.hue ?? null;
}

/** Inline token style for a block colour: tint + legible text, or nothing. */
export type BlockColorStyle = { backgroundColor: string; color?: string };

/**
 * Inline style for a stored block-colour id. Uses the tag background token for
 * the tint and the matching foreground token so text stays readable on it in
 * every theme. Default / unknown ids render `transparent`.
 */
export function blockColorCss(id: string | null | undefined): BlockColorStyle {
  const hue = blockColorHue(id);
  return hue
    ? { backgroundColor: hueSurface(hue), color: hueInk(hue) }
    : { backgroundColor: "transparent" };
}

export const BlockColors = Extension.create({
  name: "blockColors",

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_COLOR_TYPES],
        attributes: {
          blockColor: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-block-color"),
            renderHTML: (attributes) =>
              attributes.blockColor
                ? { "data-block-color": attributes.blockColor }
                : {},
          },
        },
      },
    ];
  },
});

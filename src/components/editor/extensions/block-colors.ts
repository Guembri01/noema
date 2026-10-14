import { Extension } from "@tiptap/core";

/**
 * Notion-style block background colours.
 *
 * Every block that can be painted carries a `blockColor` attribute (one of
 * the palette names, not a raw hex, so the CSS owns the values and a future
 * dark theme only has to remap them). The attribute is added globally so the
 * schema change lives in one place instead of per-node.
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

/** The nine tints Notion offers, plus Default (which clears the colour). */
export const BLOCK_COLORS: {
  label: string;
  value: string | null;
  tint: string;
}[] = [
  { label: "Default", value: null, tint: "transparent" },
  { label: "Gray", value: "gray", tint: "#f1f1ef" },
  { label: "Brown", value: "brown", tint: "#eee0da" },
  { label: "Orange", value: "orange", tint: "#faebdd" },
  { label: "Yellow", value: "yellow", tint: "#fbf3db" },
  { label: "Green", value: "green", tint: "#edf3ec" },
  { label: "Blue", value: "blue", tint: "#e7f3f8" },
  { label: "Purple", value: "purple", tint: "#f6f3f9" },
  { label: "Pink", value: "pink", tint: "#fbe4e8" },
  { label: "Red", value: "red", tint: "#fdebec" },
];

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

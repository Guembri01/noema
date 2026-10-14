import { Node, mergeAttributes } from "@tiptap/core";

/**
 * Inline @-mention atom. Stores `{ id, label, type }` so page mentions can be
 * indexed for backlinks. Rendered with a glyph + label (no node view needed for
 * an inline atom — keeps selection/copy behaviour predictable).
 */
export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  selectable: false,
  atom: true,

  addAttributes() {
    return {
      id: { default: null },
      label: { default: null },
      type: { default: "page" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const type = String(node.attrs.type ?? "page");
    const glyph = type === "user" ? "👤" : type === "date" ? "🗓" : "📄";
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-mention": type,
        class: "noema-mention",
      }),
      `${glyph} ${String(node.attrs.label ?? "")}`,
    ];
  },

  renderText({ node }) {
    return `@${String(node.attrs.label ?? "")}`;
  },
});

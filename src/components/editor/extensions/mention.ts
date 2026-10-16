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
    // Block references share the reference glyph used by the picker so the
    // inline chip matches its menu row; the `--block` class is an extra CSS
    // hook layered on the shared `.noema-mention` styles.
    const glyph =
      type === "block" ? "🔗" : type === "user" ? "👤" : type === "date" ? "🗓" : "📄";
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-mention": type,
        class: type === "block" ? "noema-mention noema-mention--block" : "noema-mention",
      }),
      `${glyph} ${String(node.attrs.label ?? "")}`,
    ];
  },

  renderText({ node }) {
    return `@${String(node.attrs.label ?? "")}`;
  },
});

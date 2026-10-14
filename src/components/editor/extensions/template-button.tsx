"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Copy } from "lucide-react";
import { TEMPLATES, templateContent, type TemplateId } from "@/lib/templates";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    templateButton: {
      setTemplateButton: (attrs?: { templateId?: TemplateId }) => ReturnType;
    };
  }
}

/** A reusable button that inserts a block template at its position. */
export const TemplateButton = Node.create({
  name: "templateButton",
  group: "block",
  atom: true,

  addAttributes() {
    return { templateId: { default: "meeting" } };
  },

  parseHTML() {
    return [{ tag: "div[data-template-button]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-template-button": "" })];
  },

  addCommands() {
    return {
      setTemplateButton:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: attrs ?? { templateId: "meeting" },
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(TemplateButtonView);
  },
});

/**
 * D7 note (B57): the labels below — `aria-label="Choose template"`, "Insert",
 * `aria-label="Remove template button"` — are intentionally still English
 * literals. This node view receives no locale: threading one needs
 * `page-editor.tsx` (editor-slot owned) and the keys must land in all five
 * catalogues via `scripts/i18n-insert.mjs` (i18n slot, single-writer rule).
 * Localized together with the unified picker in R31.10/T31.10 (spec
 * docs/specs/templates.md D7); none of these strings are asserted anywhere yet
 * (only `e2e` text matching risk — see spec §10 note 3).
 */
function TemplateButtonView({ node, editor, getPos, deleteNode }: NodeViewProps) {
  const templateId = (node.attrs.templateId as TemplateId) ?? "meeting";
  const definition = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];

  const insert = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor
      .chain()
      .focus()
      .insertContentAt(pos + node.nodeSize, templateContent(definition.id))
      .run();
  };

  return (
    <NodeViewWrapper className="noema-template-button" data-template-button="">
      <div className="noema-template-card" contentEditable={false}>
        <span className="noema-template-label">
          <Copy className="h-3.5 w-3.5" />
          {definition.label}
        </span>
        <select
          value={templateId}
          onChange={(event) =>
            editor
              .chain()
              .command(({ tr }) => {
                tr.setNodeMarkup(getPos() as number, undefined, {
                  templateId: event.target.value,
                });
                return true;
              })
              .run()
          }
          aria-label="Choose template"
          className="noema-template-select"
        >
          {TEMPLATES.map((template) => (
            <option key={template.id} value={template.id}>
              {template.label}
            </option>
          ))}
        </select>
        <button type="button" className="noema-template-insert" onClick={insert}>
          Insert
        </button>
        <button
          type="button"
          aria-label="Remove template button"
          className="noema-template-remove"
          onClick={() => deleteNode()}
        >
          ×
        </button>
      </div>
    </NodeViewWrapper>
  );
}

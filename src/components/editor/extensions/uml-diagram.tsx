"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { UmlDiagramView } from "@/components/diagrams/uml-diagram-view";
import { normalizeUmlDiagram, type UmlDiagramData } from "@/lib/diagrams/uml";

function parseStoredData(raw: string | null): UmlDiagramData {
  if (!raw) return normalizeUmlDiagram(null);
  try {
    return normalizeUmlDiagram(JSON.parse(raw));
  } catch {
    return normalizeUmlDiagram(null);
  }
}

export const UmlDiagram = Node.create({
  name: "umlDiagram",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      data: {
        default: null,
        parseHTML: (element) => parseStoredData(element.getAttribute("data-uml-data")),
        renderHTML: (attributes) => ({
          "data-uml-data": JSON.stringify(normalizeUmlDiagram(attributes.data)),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-uml-diagram]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-uml-diagram": "" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer((props: NodeViewProps) => {
      const data = normalizeUmlDiagram(props.node.attrs.data);
      const diagramId = String((props.node.attrs as { id?: unknown }).id ?? "diagram");
      return (
        <NodeViewWrapper className="uml-diagram-node" data-uml-node-view="">
          <UmlDiagramView
            data={data}
            diagramId={diagramId}
            readOnly={!props.editor.isEditable}
            onChange={(next) => props.updateAttributes({ data: next })}
          />
        </NodeViewWrapper>
      );
    });
  },
});

"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    breadcrumb: {
      setBreadcrumb: () => ReturnType;
    };
  }
}

export type BreadcrumbCrumb = { id: string; title: string };

export type BreadcrumbOptions = {
  trail: BreadcrumbCrumb[];
  workspaceSlug: string;
};

/** A static ancestry trail (workspace → … → parent). */
export const Breadcrumb = Node.create<BreadcrumbOptions>({
  name: "breadcrumb",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { trail: [], workspaceSlug: "" };
  },

  parseHTML() {
    return [{ tag: "div[data-breadcrumb]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-breadcrumb": "" })];
  },

  addCommands() {
    return {
      setBreadcrumb:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(BreadcrumbView);
  },
});

function BreadcrumbView({ extension }: NodeViewProps) {
  const options = extension.options as BreadcrumbOptions;
  const trail = options.trail ?? [];
  return (
    <NodeViewWrapper className="noema-breadcrumb" data-breadcrumb="" contentEditable={false}>
      {trail.length === 0 ? (
        <span className="noema-breadcrumb-empty">This page has no parent pages.</span>
      ) : (
        <span className="noema-breadcrumb-trail">
          {trail.map((crumb, index) => (
            <span key={crumb.id} className="noema-breadcrumb-item">
              <a href={`/w/${options.workspaceSlug}/${crumb.id}`}>
                {crumb.title || "Untitled"}
              </a>
              {index < trail.length - 1 && <span className="noema-breadcrumb-sep">/</span>}
            </span>
          ))}
        </span>
      )}
    </NodeViewWrapper>
  );
}

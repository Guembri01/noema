"use client";

import { BlockMath, InlineMath, type MathematicsOptions } from "@tiptap/extension-mathematics";
import { Extension } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { renderEquation } from "@/lib/math-tex";
import { cn } from "@/lib/utils";

/**
 * Inline/block equation node views.
 *
 * The stock `@tiptap/extension-mathematics` node views call `katex.render`
 * directly and, on failure, replace the whole equation with its raw source.
 * That is safe but gives no inline error and no click affordance. These views
 * share the bounded macro set and error normalisation from `@/lib/math-tex`
 * instead:
 *
 *  - valid source → KaTeX's escaped markup (no user HTML ever reaches the DOM);
 *  - invalid source → the (React-escaped) source plus a compact `role="alert"`
 *    message, so one bad equation can never take the document down;
 *  - empty source → an "Empty equation" affordance instead of a blank atom.
 *
 * Clicking/Enter opens the shared equation dialog through the extension's
 * `onClick` option, preserving the existing `EQUATION_EVENT` contract.
 */

export type EquationNodeKind = "inline" | "block";

export type EquationNodeSurfaceProps = {
  kind: EquationNodeKind;
  latex: string;
  selected?: boolean;
  /** Opens the edit dialog. Omit for the static preview used in tests. */
  onEdit?: () => void;
};

/**
 * Presentational content shared by both node views and the static render
 * tests. It owns no editor state, so `renderToStaticMarkup` can pin the
 * valid/error/empty branches without a live ProseMirror view.
 */
export function EquationNodeSurface({
  kind,
  latex,
  selected = false,
  onEdit,
}: EquationNodeSurfaceProps) {
  const rendered = renderEquation(latex, { displayMode: kind === "block" });
  const Root = kind === "block" ? "div" : "span";
  const interactive = typeof onEdit === "function";

  return (
    <Root
      className={cn(
        "noema-math-node",
        kind === "block" ? "noema-math-block" : "noema-math-inline",
        selected && "is-selected",
      )}
      data-equation-kind={kind}
      data-equation-state={rendered.error ? "error" : rendered.empty ? "empty" : "ready"}
      data-latex={latex}
      role="math"
      aria-label={latex || "Empty equation"}
      tabIndex={interactive ? 0 : undefined}
      onPointerDownCapture={
        interactive
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onEdit();
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onEdit();
            }
          : undefined
      }
    >
      {rendered.error ? (
        <>
          <span className="noema-math-source">{latex || "…"}</span>
          <span className="noema-math-error" role="alert" title={rendered.error}>
            {rendered.error}
          </span>
        </>
      ) : rendered.empty ? (
        <span className="noema-math-empty">Empty equation</span>
      ) : (
        <span
          className="noema-math-render"
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      )}
    </Root>
  );
}

type EquationNodeViewProps = NodeViewProps & {
  kind: EquationNodeKind;
  onClick?: (node: PMNode, pos: number) => void;
};

function EquationNodeView({ node, selected, getPos, kind, onClick }: EquationNodeViewProps) {
  const latex = typeof node.attrs.latex === "string" ? node.attrs.latex : "";
  const edit = () => {
    const pos = getPos();
    if (typeof pos === "number" && onClick) onClick(node, pos);
  };

  return (
    <NodeViewWrapper
      as={kind === "inline" ? "span" : "div"}
      className={cn(
        "tiptap-mathematics-render noema-math-node-view",
        kind === "block" ? "noema-math-block-view" : "noema-math-inline-view",
      )}
      data-type={kind === "block" ? "block-math" : "inline-math"}
      data-latex={latex}
      contentEditable={false}
    >
      <EquationNodeSurface
        kind={kind}
        latex={latex}
        selected={selected}
        onEdit={edit}
      />
    </NodeViewWrapper>
  );
}

const InlineMathNode = InlineMath.extend({
  addNodeView() {
    const onClick = this.options.onClick;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <EquationNodeView {...props} kind="inline" onClick={onClick} />
    ));
  },
});

const BlockMathNode = BlockMath.extend({
  addNodeView() {
    const onClick = this.options.onClick;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <EquationNodeView {...props} kind="block" onClick={onClick} />
    ));
  },
});

/**
 * Drop-in replacement for `Mathematics` from `@tiptap/extension-mathematics`.
 * The same `insertInlineMath`/`insertBlockMath`/`update*` commands are
 * registered by the underlying nodes; only the node views change.
 */
export const Mathematics = Extension.create<MathematicsOptions>({
  name: "mathematics",

  addOptions() {
    return {
      inlineOptions: undefined,
      blockOptions: undefined,
      katexOptions: undefined,
    };
  },

  addExtensions() {
    return [
      InlineMathNode.configure({ ...this.options.inlineOptions }),
      BlockMathNode.configure({ ...this.options.blockOptions }),
    ];
  },
});

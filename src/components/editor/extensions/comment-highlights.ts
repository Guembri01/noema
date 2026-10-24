/**
 * Inline-comment decorations.
 *
 * The persisted anchor is the source of truth; decorations are a projection of
 * it over the live document. They never touch `doc` and never mark text whose
 * quote no longer matches the current slice - a stale range is simply not
 * painted (the panel keeps the quote and its "Text changed" badge).
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { rangeFromAnchor } from "@/components/editor/comment-anchor";

export type CommentHighlightAnchor = {
  readonly commentId: string;
  readonly blockId: string;
  readonly from?: number | null;
  readonly to?: number | null;
  readonly quote?: string | null;
};

type CommentHighlightState = {
  readonly anchors: readonly CommentHighlightAnchor[];
  readonly activeId: string | null;
  readonly decorations: DecorationSet;
};

type CommentHighlightMeta =
  | { type: "setAnchors"; anchors: readonly CommentHighlightAnchor[] }
  | { type: "setActive"; id: string | null };

export const commentHighlightPluginKey = new PluginKey<CommentHighlightState>(
  "commentHighlights",
);

/** Build the decoration set for `anchors`; stale anchors are skipped. */
export function commentHighlightDecorations(
  doc: PMNode,
  anchors: readonly CommentHighlightAnchor[],
  activeId: string | null = null,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const anchor of anchors) {
    const range = rangeFromAnchor(doc, anchor);
    if (range === null) continue;
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class:
          activeId === anchor.commentId
            ? "noema-comment-highlight noema-comment-highlight-active"
            : "noema-comment-highlight",
        "data-comment-id": anchor.commentId,
        "data-comment-active": activeId === anchor.commentId ? "true" : "false",
        ...(anchor.quote ? { title: anchor.quote } : {}),
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

export type CommentHighlightsOptions = {
  anchors: readonly CommentHighlightAnchor[];
};

export const CommentHighlights = Extension.create<CommentHighlightsOptions>({
  name: "commentHighlights",

  addOptions() {
    return { anchors: [] };
  },

  addProseMirrorPlugins() {
    const initialAnchors = this.options.anchors;
    return [
      new Plugin<CommentHighlightState>({
        key: commentHighlightPluginKey,
        state: {
          init: (_config, state) => ({
            anchors: initialAnchors,
            activeId: null,
            decorations: commentHighlightDecorations(
              state.doc,
              initialAnchors,
              null,
            ),
          }),
          apply(transaction, value, _oldState, newState) {
            const meta = transaction.getMeta(commentHighlightPluginKey) as
              | CommentHighlightMeta
              | undefined;
            if (meta === undefined && !transaction.docChanged) return value;
            const anchors =
              meta?.type === "setAnchors" ? meta.anchors : value.anchors;
            const activeId =
              meta?.type === "setActive" ? meta.id : value.activeId;
            return {
              anchors,
              activeId,
              decorations: commentHighlightDecorations(
                newState.doc,
                anchors,
                activeId,
              ),
            };
          },
        },
        props: {
          decorations(state) {
            return commentHighlightPluginKey.getState(state)?.decorations ?? null;
          },
        },
      }),
    ];
  },
});

/** Replace the anchor list (after a refresh/reload) without a document write. */
export function setCommentHighlightAnchors(
  view: EditorView,
  anchors: readonly CommentHighlightAnchor[],
): void {
  view.dispatch(
    view.state.tr.setMeta(commentHighlightPluginKey, {
      type: "setAnchors",
      anchors,
    } satisfies CommentHighlightMeta),
  );
}

/** Flash one anchor as the active jump target. */
export function setActiveCommentHighlight(
  view: EditorView,
  id: string | null,
): void {
  view.dispatch(
    view.state.tr.setMeta(commentHighlightPluginKey, {
      type: "setActive",
      id,
    } satisfies CommentHighlightMeta),
  );
}

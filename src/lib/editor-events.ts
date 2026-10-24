/**
 * Editor event names and their payloads.
 *
 * These constants live outside the components that consume them so a toolbar or
 * menu does not pull the whole comment/equation panel into its module graph just
 * to dispatch an event. The component modules re-export them for compatibility.
 */
export const COMMENT_EVENT = "noema:comment";
/** Panel → editor: jump to a persisted anchor and flash its exact range. */
export const COMMENT_JUMP_EVENT = "noema:comment-jump";
/** Editor → panel: which persisted ranges no longer match the live document. */
export const COMMENT_ANCHOR_STATE_EVENT = "noema:comment-anchor-state";
export const EQUATION_EVENT = "noema:equation";

/**
 * A captured selection handed to the comment composer. `from`/`to` are UTF-16
 * offsets inside `blockId`'s plain text, or omitted for a block/page comment.
 */
export type CommentRequest = {
  quote?: string;
  blockId?: string;
  from?: number;
  to?: number;
};

/** The panel's jump request for an existing root comment. */
export type CommentJumpRequest = {
  commentId: string;
  blockId: string;
  quote?: string | null;
  from?: number | null;
  to?: number | null;
};

/** Live staleness report from the editor after a document change. */
export type CommentAnchorStateRequest = {
  /** Comment ids whose quote no longer matches their block's live text. */
  staleIds: string[];
};

export type EquationRequest = {
  kind: "inline" | "block";
  latex?: string;
  /** Position of an existing equation node being edited. */
  pos?: number | null;
  /**
   * Selection replaced by a new inline equation. Optional: when omitted the
   * equation editor captures the live editor selection as the dialog opens, so
   * confirming replaces the selected text instead of duplicating it.
   */
  from?: number;
  to?: number;
};

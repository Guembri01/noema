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

/** Page header → body editor: put the caret in the first body block. */
export const FOCUS_PAGE_BODY_EVENT = "noema:focus-page-body";
/** Page header → body editor: turn automatic word correction on/off. */
export const AUTOCORRECT_EVENT = "noema:autocorrect";
/** Bottom editor bar → body editor: open the Markdown source panel. */
export const OPEN_PAGE_SOURCE_EVENT = "noema:open-page-source";

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

/** localStorage key holding the per-page autocorrect preference. */
export function autocorrectStorageKey(pageId: string): string {
  return `noema:autocorrect:${pageId}`;
}

/** Read the persisted autocorrect preference; storage failures fail closed. */
export function readAutocorrectPreference(pageId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(autocorrectStorageKey(pageId)) === "1";
  } catch {
    return false;
  }
}

/** Persist the preference and notify the editor in the same tick. */
export function writeAutocorrectPreference(pageId: string, enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(autocorrectStorageKey(pageId), enabled ? "1" : "0");
  } catch {
    // storage unavailable: the toggle still applies for this session
  }
  window.dispatchEvent(
    new CustomEvent(AUTOCORRECT_EVENT, { detail: { enabled } }),
  );
}

/** Ask the editor to put the caret in the first body block. */
export function focusPageBody(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FOCUS_PAGE_BODY_EVENT));
}

/** Ask the editor to open the Markdown source view. */
export function openPageSource(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_PAGE_SOURCE_EVENT));
}

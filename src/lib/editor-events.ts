/**
 * Editor event names and their payloads.
 *
 * These constants live outside the components that consume them so a toolbar or
 * menu does not pull the whole comment/equation panel into its module graph just
 * to dispatch an event. The component modules re-export them for compatibility.
 */
export const COMMENT_EVENT = "noema:comment";
export const EQUATION_EVENT = "noema:equation";

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

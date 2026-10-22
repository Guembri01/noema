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
  pos?: number | null;
};

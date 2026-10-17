/**
 * Clicking the empty space under the last block.
 *
 * In Notion the space below a page's content is still the page: a click in it
 * puts the caret where the click *looks* like it landed — a fresh paragraph at
 * the end — instead of at the end of whatever block happens to be last (which,
 * mid-sentence, silently reassembles an unfinished thought). The page editor
 * owns the geometry (was the pointer below the last child?) and the transaction;
 * this module owns the decision, so it can be unit-tested without a DOM.
 */

/** The tail of the document, as the caller reads it off the ProseMirror node. */
export type DocumentTail = {
  /** Type name of the last top-level block, if the document has one. */
  lastBlockType?: string;
  /** Whether that block holds no content at all. */
  lastBlockEmpty: boolean;
};

/** What a click under the content should do. */
export type BlankClickPlan =
  /** The document already ends in an empty paragraph: simply use it. */
  | { kind: "use-tail" }
  /** Nothing to type into: append an empty paragraph and use that. */
  | { kind: "append" };

/**
 * Only a trailing *empty paragraph* is reusable as-is: a heading, a list, a code
 * block or a filled paragraph all mean the writer wants a new one, and the empty
 * paragraph they asked for is cheaper to append than to carve out of another
 * block's shape.
 */
export function blankClickPlan({ lastBlockType, lastBlockEmpty }: DocumentTail): BlankClickPlan {
  if (lastBlockType === "paragraph" && lastBlockEmpty) return { kind: "use-tail" };
  return { kind: "append" };
}

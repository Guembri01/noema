/**
 * The frame around the row context the AI autofill hands to the model.
 *
 * The row context is workspace content: the property values and the row title
 * are written by whoever owns the row, not by whoever runs the autofill. An
 * unframed block lets that content speak in the voice of the prompt — a title
 * that carries an instruction reads like an instruction, and a newline in that
 * title opens a paragraph of its own (a second `Row context:` holding nothing
 * but the instruction).
 *
 * The frame is a pair of tags around the finished text:
 *
 *   <row-context id="…">
 *   Notes: {"text":"Body text"}
 *   Title: Launch plan
 *   </row-context id="…">
 *
 * Two things keep the frame honest, and neither of them is the model's
 * cooperation:
 *
 *  - the id is minted per request from the CSPRNG, so the content cannot know
 *    which tag closes the block;
 *  - text that could pass for a tag is removed from the content, so the block
 *    cannot be closed from the inside even by a model that ignores the id.
 *
 * The frame goes around the *finished* text: the autofill has no context
 * budget (`maxTokens` there is the output budget), so nothing can cut the
 * closing tag off.
 *
 * This is the same frame the AI proxy uses for its grounding block (audit B74,
 * PR #201), kept local here so that this branch stands on its own. The two
 * frames are meant to become one helper — same tag shape, same per-request id,
 * same neutralisation — and only the tag name and the block behind it differ.
 */

import { randomBytes } from "node:crypto";

/** The tag name of the frame: it says what the block holds. */
const ROW_CONTEXT_TAG = "row-context";

/** Bytes of randomness in a frame id (16 bytes → 22 base64url characters). */
const ID_BYTES = 16;

/**
 * An id travels inside a tag, so it has to be URL-safe — and long enough that
 * a row title cannot guess the one of the request it is written into.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Text that could pass for one of the frame's tags. The id inside the tag is
 * unknown to the content, but a model that ignores the id must not be able to
 * close the block from the inside either — so every tag-shaped run is removed
 * from the content before the frame goes around it.
 *
 * The run stays on one line: a match that swallowed a line break could join
 * two values into one line.
 */
const TAG_SHAPED = /<\/?row-context\b[^>\n]*>?/gi;

/** The frame of a row context: the two tags and the text between them. */
export type RowContextFrame = {
  /** The per-request id that both tags carry. */
  id: string;
  /** The opening tag, e.g. `<row-context id="…">`. */
  open: string;
  /** The closing tag. */
  close: string;
  /** The row context, framed. */
  framed: string;
};

/** A fresh frame id, minted per request from the CSPRNG. */
function mintId(): string {
  return randomBytes(ID_BYTES).toString("base64url");
}

/**
 * Fold a workspace value onto one line: every run of whitespace becomes a
 * single space. A newline in a value must not open a line of its own — neither
 * a forged paragraph nor a second property.
 */
export function foldToLine(value: string): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Frame the row context: the text goes between two tags that carry the same
 * per-request id, and text that could pass for a tag is removed from it.
 *
 * `id` may be passed in to make the framing deterministic (a test). An id that
 * is not URL-safe is not used — a fresh one is minted instead, so a caller
 * cannot break out of the tag through it. Never throws.
 */
export function frameRowContext(text: string, id?: string): RowContextFrame {
  const frameId = typeof id === "string" && ID_PATTERN.test(id) ? id : mintId();
  const open = `<${ROW_CONTEXT_TAG} id="${frameId}">`;
  const close = `</${ROW_CONTEXT_TAG} id="${frameId}">`;
  const body = typeof text === "string" ? text.replace(TAG_SHAPED, "") : "";
  return { id: frameId, open, close, framed: `${open}\n${body}\n${close}` };
}

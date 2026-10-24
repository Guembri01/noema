/**
 * Editor-side target resolution and insertion for the AI skills
 * (R25.19-R25.21).
 *
 * The commands stay here instead of inside the two menus so the selection
 * toolbar and the block menu share one insertion policy:
 *
 *  - `replace` rewrites the selected range (or the block's content);
 *  - `continue` appends inline at the end of the current text;
 *  - `append` adds a paragraph below the selection / block (or at the end of
 *    the page when the action ran on the whole page).
 *
 * The page fallback is deliberate: "Summarize a page or section" and
 * "Translate selection or page" mean a skill invoked with no selection reads
 * the whole document. It always appends, never replaces the page — an empty
 * selection must never turn a rewrite into a destructive whole-page edit.
 */

import type { Editor } from "@tiptap/react";
import type { AiSkillId } from "@/lib/ai-skills";

export type AiSkillScope = "selection" | "block" | "page";

export type AiSkillTarget = {
  /** The text handed to the route. */
  text: string;
  /** The range a rewrite replaces / a continuation joins. */
  from: number;
  to: number;
  /** Where an appended paragraph goes (below the target). */
  insertAt: number;
  scope: AiSkillScope;
};

export type AiInsertMode = "replace" | "continue" | "append";

/**
 * What a skill result does to the document. Continuations always join the
 * text inline, rewrites only replace a real selection/block, and page-scoped
 * actions always append.
 */
export function aiInsertMode(input: {
  skillId: AiSkillId | string;
  replacesSelection: boolean;
  scope: AiSkillScope;
}): AiInsertMode {
  if (input.skillId === "continue") return "continue";
  if (input.replacesSelection && input.scope !== "page") return "replace";
  return "append";
}

/** The whole page as a target; a page-scoped result always appends. */
export function pageSkillTarget(editor: Editor): AiSkillTarget | null {
  const end = editor.state.doc.content.size;
  const text = editor.state.doc.textBetween(0, end, "\n").trim();
  if (text === "") return null;
  return { text, from: end, to: end, insertAt: end, scope: "page" };
}

/** The current selection, or the whole page when the selection is empty. */
export function selectionSkillTarget(editor: Editor): AiSkillTarget | null {
  const { from, to } = editor.state.selection;
  if (from !== to) {
    const text = editor.state.doc.textBetween(from, to, "\n").trim();
    if (text !== "") return { text, from, to, insertAt: to, scope: "selection" };
  }
  return pageSkillTarget(editor);
}

/** The text of one top-level block and the ranges that act on it. */
export function blockSkillTarget(editor: Editor, pos: number): AiSkillTarget | null {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return null;
  const text = node.textContent.trim();
  if (text === "") return null;
  return {
    text,
    from: pos + 1,
    to: pos + node.nodeSize - 1,
    insertAt: pos + node.nodeSize,
    scope: "block",
  };
}

/**
 * Apply a skill's answer to the target. Returns `false` when there is nothing
 * to insert, so the caller can show an honest error instead of a success toast.
 */
export function applySkillResult(
  editor: Editor,
  input: { target: AiSkillTarget; mode: AiInsertMode; text: string },
): boolean {
  const text = input.text.trim();
  if (text === "") return false;

  if (input.mode === "replace") {
    // A text node, not a raw string: an insertion string is parsed as HTML.
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: input.target.from, to: input.target.to },
        { type: "text", text },
      )
      .run();
    return true;
  }

  if (input.mode === "continue" && input.target.scope !== "page") {
    // Join the existing text: keep one space between it and the answer when
    // the character before the insertion point is not already whitespace.
    const before = editor.state.doc.textBetween(
      Math.max(0, input.target.to - 1),
      input.target.to,
      "",
    );
    const separator = before !== "" && !/\s$/.test(before) ? " " : "";
    editor
      .chain()
      .focus()
      .insertContentAt(input.target.to, { type: "text", text: `${separator}${text}` })
      .run();
    return true;
  }

  editor
    .chain()
    .focus()
    .insertContentAt(input.target.insertAt, {
      type: "paragraph",
      content: [{ type: "text", text }],
    })
    .run();
  return true;
}

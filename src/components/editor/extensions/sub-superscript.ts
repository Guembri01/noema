import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Subscript + superscript marks (🧭 MISSING_FEATURES §2 "Text formatting").
 *
 * Two sibling inline marks over `<sub>` / `<sup>` — the HTML pair every
 * renderer and paste source understands. They exclude each other (text can
 * sit below *or* above the baseline, never both) but compose with every
 * other StarterKit mark: `**bold ~sub~**`, links, colour and highlight all
 * keep working.
 *
 * Entry points:
 *   • `Mod+,` / `Mod+.` keyboard shortcuts,
 *   • `toggleSubscript()` / `toggleSuperscript()` commands for menu buttons,
 *   • `H~2~O` / `x^2^` markdown triggers, registered by `input-rules.ts`
 *     through the pure `matchScriptShortcut` matcher below.
 */

export type ScriptKind = "subscript" | "superscript";

/** A trigger found in the text in front of the cursor. */
export interface ScriptShortcutMatch {
  /** Which mark the trigger opens. */
  kind: ScriptKind;
  /** The full pair including delimiters, e.g. `~2~`. */
  full: string;
  /** The text between the delimiters, e.g. `2`. */
  inner: string;
  /** Where `full` starts inside the inspected text. */
  index: number;
}

/**
 * End-anchored patterns: an input rule only fires on the keystroke that
 * *closes* the pair, and the `$` anchor keeps `~~strike~~` (stock strike
 * rule) out of the subscript rule's reach — `~~x~~` never matches
 * `~([^~]+)~$`.
 */
const SCRIPT_SHORTCUTS: Record<ScriptKind, RegExp> = {
  subscript: /~([^~]+)~$/,
  superscript: /\^([^\^]+)\^$/,
};

/**
 * Match a just-closed `~sub~` / `^sup^` pair at the end of `text`.
 * Pure so the trigger spec can be unit-tested without an editor
 * (`sub-superscript.test.ts`).
 */
export function matchScriptShortcut(text: string): ScriptShortcutMatch | null {
  for (const kind of ["subscript", "superscript"] as const) {
    const match = SCRIPT_SHORTCUTS[kind].exec(text);
    if (match && match[1]) {
      return { kind, full: match[0], inner: match[1], index: match.index };
    }
  }
  return null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    subscript: {
      /** Toggle subscript on the selection (menu / bubble-toolbar entry point). */
      toggleSubscript: () => ReturnType;
    };
    superscript: {
      /** Toggle superscript on the selection (menu / bubble-toolbar entry point). */
      toggleSuperscript: () => ReturnType;
    };
  }
}

export const Subscript = Mark.create({
  name: "subscript",

  // Text cannot be lowered and raised at the same time; everything else
  // (bold, italic, link, colour, highlight) still stacks on top.
  excludes: "subscript superscript",

  parseHTML() {
    return [{ tag: "sub" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sub", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      toggleSubscript: () => ({ commands }) => commands.toggleMark(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-,": () => this.editor.chain().focus().toggleSubscript().run(),
    };
  },
});

export const Superscript = Mark.create({
  name: "superscript",

  excludes: "subscript superscript",

  parseHTML() {
    return [{ tag: "sup" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      toggleSuperscript: () => ({ commands }) => commands.toggleMark(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-.": () => this.editor.chain().focus().toggleSuperscript().run(),
    };
  },
});

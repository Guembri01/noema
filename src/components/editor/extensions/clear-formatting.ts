import { Extension } from "@tiptap/core";

/**
 * Clear formatting (🧭 MISSING_FEATURES §2 "Text formatting").
 *
 * Strips **every** mark off the selected range in one action — bold,
 * italic, underline, strike, code, link, text colour and highlight — via
 * the stock `unsetAllMarks` command, which also honours marks that opt out
 * with `clearable: false`. Node-level formatting (headings, lists) is left
 * alone: this is the text-mark reset, not a block reset.
 *
 * The bubble toolbar already exposes the same action behind its eraser
 * button (`unsetAllMarks().clearNodes()`); this extension adds the missing
 * keyboard action so the row ships as a real shortcut:
 * `Mod+Shift+C` — free in the codebase (stock bindings are `Mod-Shift-b/h/s`,
 * `Mod-Alt-c`, text-align `Mod-Shift-e/j/l/r`).
 *
 * With a collapsed cursor the shortcut instead clears the marks the next
 * typed character would inherit, mirroring Google Docs / Word.
 */
export const ClearFormatting = Extension.create({
  name: "clearFormatting",

  addCommands() {
    return {
      clearFormatting: () => ({ tr, dispatch, commands }) => {
        if (tr.selection.empty) {
          if (dispatch) tr.setStoredMarks([]);
          return true;
        }
        return commands.unsetAllMarks();
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-c": () => this.editor.chain().focus().clearFormatting().run(),
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    clearFormatting: {
      /** Remove every clearable mark from the selection. */
      clearFormatting: () => ReturnType;
    };
  }
}

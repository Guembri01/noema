"use client";

import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import {
  autocorrectWord,
  isAutocorrectTrigger,
} from "@/lib/autocorrect";

declare module "@tiptap/core" {
  interface Storage {
    autocorrect: { enabled: boolean };
  }
  interface Commands<ReturnType> {
    autocorrect: {
      /** Turn the opt-in automatic word correction on or off. */
      setAutocorrect: (enabled: boolean) => ReturnType;
    };
  }
}

/**
 * Opt-in automatic typo correction.
 *
 * Native spellcheck stays enabled so the browser still underlines a misspelling
 * and offers its own suggestions. This extension only handles the small set of
 * unambiguous words in `@/lib/autocorrect`, and only when the user has switched
 * the page's autocorrect toggle on. It rewrites on the trigger character (space
 * or punctuation), not while the word is still being typed.
 */
export const Autocorrect = Extension.create({
  name: "autocorrect",

  addStorage() {
    return { enabled: false };
  },

  addCommands() {
    return {
      setAutocorrect:
        (enabled: boolean) =>
        ({ editor }) => {
          editor.storage.autocorrect.enabled = enabled;
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    // Capture the mutable storage object, not the extension instance: the
    // toggle mutates `enabled` in place and the plugin must see the new value.
    const storage = this.editor.storage.autocorrect;
    return [
      new Plugin({
        props: {
          handleTextInput(view, from, to, text) {
            if (!storage.enabled) return false;
            if (!isAutocorrectTrigger(text)) return false;
            if (from !== to) return false;

            const $from = view.state.doc.resolve(from);
            // Code is literal by contract; a word inside a fence must never be
            // rewritten. Tables, lists and headings are all fine.
            if ($from.parent.type.spec.code) return false;
            if ($from.parentOffset === 0) return false;

            const before = $from.parent.textBetween(
              0,
              $from.parentOffset,
              undefined,
              "\ufffc",
            );
            const match = /([A-Za-z][A-Za-z']*)$/.exec(before);
            if (!match) return false;
            const word = match[1] ?? "";
            const corrected = autocorrectWord(word);
            if (!corrected) return false;

            const start = from - word.length;
            const transaction = view.state.tr.insertText(
              `${corrected}${text}`,
              start,
              to,
            );
            transaction.scrollIntoView();
            view.dispatch(transaction);
            return true;
          },
        },
      }),
    ];
  },
});

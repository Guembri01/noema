"use client";

import { Extension, InputRule, wrappingInputRule } from "@tiptap/core";
import { emojiForShortcode, matchEmojiShortcode } from "@/lib/emoji";
import {
  matchMarkdownShortcut,
  splitTableRow,
  type MarkdownShortcutKind,
} from "@/lib/markdown";

/**
 * B18 — markdown shortcut long tail + emoji shortcodes.
 *
 * `src/lib/markdown.ts` owns the pure spec (`matchMarkdownShortcut`) and is
 * unit-tested rule by rule; this extension wires the triggers TipTap does NOT
 * ship on its own:
 *   • `1)` ordered lists — StarterKit's rule only matches `1.`,
 *   • `| Name | Qty |` + Enter → table — there is no stock input rule at all,
 *   • `:smile:` → 🙂 as soon as the closing colon is typed.
 *
 * The core triggers (`#`, `-`, `>`, `[] `, ```` ``` ````, `~~`, `==`, `---`)
 * come from the stock extensions and are asserted end-to-end in
 * `e2e/editor-extras.spec.ts`; the pure matcher tests keep their spec honest.
 */

/** Build a TipTap `find` function for the given shortcut kinds. */
function findShortcuts(...kinds: MarkdownShortcutKind[]) {
  return (text: string): { index: number; text: string } | null => {
    const match = matchMarkdownShortcut(text);
    if (!match || !kinds.includes(match.kind)) return null;
    // TipTap turns this into `match[0] = text`, so handlers derive their
    // payload from the consumed trigger itself.
    return { index: match.from, text: match.trigger };
  };
}

export const InputRules = Extension.create({
  name: "inputRules",

  addInputRules() {
    return [
      // `1) item` → ordered list starting at 1 (mirror of the stock `1.` rule).
      wrappingInputRule({
        find: findShortcuts("ordered"),
        type: this.editor.schema.nodes.orderedList,
        getAttributes: (match) => ({ start: Number(/^\d+/.exec(match[0])?.[0]) || 1 }),
        joinPredicate: (match, node) =>
          node.childCount + node.attrs.start === (Number(/^\d+/.exec(match[0])?.[0]) || 1),
      }),

      // `| Name | Qty |` + Enter → a two-row table that keeps the typed
      // header text (the row is consumed, not thrown away).
      new InputRule({
        find: findShortcuts("table"),
        handler: ({ state, range, match }) => {
          const cells = splitTableRow(String(match[0] ?? ""));
          if (cells.length === 0) return null;
          const { schema } = state;
          const cell = (kind: "tableHeader" | "tableCell", content: string) =>
            schema.nodes[kind].create(
              null,
              schema.nodes.paragraph.create(null, content ? schema.text(content) : undefined),
            );
          const table = schema.nodes.table.create(null, [
            schema.nodes.tableRow.create(null, cells.map((value) => cell("tableHeader", value))),
            schema.nodes.tableRow.create(null, cells.map(() => cell("tableCell", ""))),
          ]);
          state.tr.replaceRangeWith(range.from, range.to, table);
        },
      }),

      // `:smile:` → 🙂 (unknown shortcodes keep their text: the handler
      // returns null, so TipTap falls back to plain typing).
      new InputRule({
        find: (text: string): { index: number; text: string } | null => {
          const match = matchEmojiShortcode(text);
          if (!match) return null;
          return { index: match.from, text: text.slice(match.from, match.to) };
        },
        handler: ({ state, range, match }) => {
          const emoji = emojiForShortcode(String(match[0] ?? "").replace(/^:|:$/g, ""));
          if (!emoji) return null;
          state.tr.insertText(emoji, range.from, range.to);
        },
      }),
    ];
  },
});

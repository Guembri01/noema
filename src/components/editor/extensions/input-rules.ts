"use client";

import { Extension, InputRule, wrappingInputRule } from "@tiptap/core";
import { emojiForShortcode, matchEmojiShortcode } from "@/lib/emoji";
import {
  matchMarkdownShortcut,
  splitTableRow,
  type MarkdownShortcutKind,
} from "@/lib/markdown";
import { ClearFormatting } from "@/components/editor/extensions/clear-formatting";
import {
  matchScriptShortcut,
  Subscript,
  Superscript,
} from "@/components/editor/extensions/sub-superscript";

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
 *
 * It also plays a second role: anchoring the **text formatting** slice
 * (clear formatting, subscript/superscript). `page-editor.tsx` owns the
 * editor's extension list but is shared across the whole fleet, so the new
 * extensions are registered through TipTap v3's `addExtensions` — the same
 * hook `StarterKit` uses to bundle its parts — and flattened into the
 * schema from here. Once they are listed in `page-editor.tsx` directly,
 * drop the hook (duplicate names would warn).
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

  addExtensions() {
    return [ClearFormatting, Subscript, Superscript];
  },

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

      // `H~2~O` → subscript, `x^2^` → superscript (GitHub-style triggers).
      // The pure, unit-tested spec lives next to the marks
      // (`matchScriptShortcut` in `sub-superscript.ts`); `find` only adapts
      // it to TipTap's `{ index, text }` shape and the handler re-derives
      // the pair so it knows which mark to apply. An end-anchored pattern
      // guarantees the just-typed closing delimiter is part of the match,
      // and the stock `~~strike~~` rule stays untouched (`~~x~~` never
      // matches `~([^~]+)~$`).
      new InputRule({
        find: (text: string): { index: number; text: string } | null => {
          const match = matchScriptShortcut(text);
          return match ? { index: match.index, text: match.full } : null;
        },
        handler: ({ state, range, match }) => {
          const script = matchScriptShortcut(String(match[0] ?? ""));
          if (!script) return null;
          // Marks only exist once `addExtensions` above registered them;
          // without them the keystroke must fall through to plain typing.
          const markType = state.schema.marks[script.kind];
          if (!markType) return null;
          const { tr } = state;
          // `range` spans exactly the pair, so: drop the closing delimiter
          // first (earlier positions do not move), then the opening one,
          // then mark the text that is left between them.
          tr.delete(range.to - 1, range.to);
          tr.delete(range.from, range.from + 1);
          tr.addMark(range.from, range.from + script.inner.length, markType.create());
          // Close the pair without leaving the mark armed for the next
          // character (same courtesy the stock `markInputRule` extends).
          tr.removeStoredMark(markType);
          tr.scrollIntoView();
        },
      }),
    ];
  },
});

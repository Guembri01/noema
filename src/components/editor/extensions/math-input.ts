"use client";

import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

const BLOCK = /^\$\$([\s\S]{1,2000}?)\$\$$/;
const INLINE = /\$([^$\n]{1,240})\$/g;
/** Only transform things that actually look like maths. */
const LOOKS_LIKE_MATH = /[\\^_={}]|\d\s*[+\-*/]\s*\d/;

/**
 * LaTeX auto-detection.
 *
 * Type `$x^2$` (inline) or `$$…$$` (block) and it becomes a real math node,
 * editable through the equation dialog. Implemented as a document transform
 * (`appendTransaction`) plus a paste handler: input rules proved unreliable in
 * this editor version, and a transform works identically for typing, pasting
 * and programmatic inserts.
 *
 * The "looks like maths" guard keeps prices and prose (`$5 and $6`) intact.
 */
export const MathAutoDetect = Extension.create({
  name: "mathAutoDetect",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const { schema } = newState;
          if (!schema.nodes.inlineMath || !schema.nodes.blockMath) return null;

          const matches: { from: number; to: number; latex: string; block: boolean }[] = [];
          newState.doc.descendants((node, pos) => {
            if (!node.isTextblock) return true;
            const text = node.textContent;
            if (!text.includes("$")) return false;

            const blockMatch = BLOCK.exec(text);
            if (blockMatch && LOOKS_LIKE_MATH.test(blockMatch[1])) {
              matches.push({
                from: pos + 1,
                to: pos + node.nodeSize - 1,
                latex: blockMatch[1].trim(),
                block: true,
              });
              return false;
            }

            for (const match of text.matchAll(INLINE)) {
              const latex = match[1].trim();
              if (!LOOKS_LIKE_MATH.test(latex)) continue;
              const start = pos + 1 + (match.index ?? 0);
              matches.push({ from: start, to: start + match[0].length, latex, block: false });
            }
            return false;
          });
          if (matches.length === 0) return null;

          // Replace from the end so earlier positions stay valid.
          const tr = newState.tr;
          for (const match of matches.sort((a, b) => b.from - a.from)) {
            const node = match.block
              ? schema.nodes.blockMath.create({ latex: match.latex })
              : schema.nodes.inlineMath.create({ latex: match.latex });
            tr.replaceWith(match.from, match.to, node);
          }
          return tr;
        },

        props: {
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (!text.includes("$") || text.length > 4000) return false;

            const blockMatch = BLOCK.exec(text.trim());
            if (blockMatch && LOOKS_LIKE_MATH.test(blockMatch[1])) {
              const node = view.state.schema.nodes.blockMath?.create({
                latex: blockMatch[1].trim(),
              });
              if (node) {
                view.dispatch(view.state.tr.replaceSelectionWith(node));
                return true;
              }
            }

            const content: unknown[] = [];
            let last = 0;
            for (const match of text.matchAll(INLINE)) {
              const latex = match[1].trim();
              if (!LOOKS_LIKE_MATH.test(latex)) continue;
              const index = match.index ?? 0;
              if (index > last) content.push({ type: "text", text: text.slice(last, index) });
              content.push({ type: "inlineMath", attrs: { latex } });
              last = index + match[0].length;
            }
            if (content.length === 0) return false;
            if (last < text.length) content.push({ type: "text", text: text.slice(last) });
            view.dispatch(
              view.state.tr.replaceSelectionWith(
                view.state.schema.nodes.paragraph.create(null, content as never),
              ),
            );
            return true;
          },
        },
      }),
    ];
  },
});

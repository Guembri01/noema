"use client";

import { Extension, InputRule } from "@tiptap/core";
import {
  TYPOGRAPHY_RULES,
  type TypographyRule,
} from "@/lib/smart-typography";

/**
 * Smart typography input rules — the editor half of "Ligatures & smart quotes"
 * (docs/MISSING_FEATURES.md §2).
 *
 * `src/lib/smart-typography.ts` owns the pure engine: an ordered list of
 * `TypographyRule` descriptors (`{ id, pattern, replace, description }`) that
 * `applySmartTypography` runs over a whole line (and `applyRule` over one rule).
 * This extension compiles that *same* list into TipTap input rules so the
 * transforms happen as the user types, instead of only on paste/import.
 *
 * Each non-optional descriptor becomes one `InputRule`:
 *   • `find` anchors the descriptor's `pattern` at the just-typed character —
 *     the text before the cursor must *end* with the match — so a keystroke can
 *     never rewrite text the user is not currently editing;
 *   • `handler` rebuilds the engine's `TypographyRuleContext` (`text`, `match`,
 *     `index`, `groups`, `preceding`, `following`) from the live textblock and
 *     calls the descriptor's own `replace`, then swaps the matched range for the
 *     result. The engine stays the single source of truth.
 *
 * Descriptors are compiled in `TYPOGRAPHY_RULES` order, preserving the
 * documented `...` / `---` / `--` precedence: the em-dash rule is offered to a
 * completed `---` before the en-dash rule, exactly as `applySmartTypography`
 * applies them. Live typing differs from the whole-line engine in two honest
 * ways (both follow-ups): en-dash fires on the *second* hyphen, so a
 * triple-hyphen em dash is unreachable by typing, and the single-quote rule
 * cannot see the closing quote it uses to open a `'hi'` pair. Paste/import keep
 * going through `applySmartTypography`, so they are unaffected.
 *
 * `optional` descriptors only expand a ligature code point that is already in
 * the text (`disableLigatures` normalisation); no keystroke can trigger them and
 * there is no "expand ligatures" editor setting to honour, so they are skipped.
 */
function compileRule(rule: TypographyRule): InputRule {
  // `$`-anchored: the match must finish at the cursor (the just-typed char).
  const anchored = new RegExp(`${rule.pattern}$`);
  // Ungrouped re-run over the matched substring, only to recover capture groups.
  const unanchored = new RegExp(rule.pattern);

  return new InputRule({
    find: (text: string): { index: number; text: string } | null => {
      const found = anchored.exec(text);
      if (!found || found[0].length === 0) return null;
      return { index: found.index, text: found[0] };
    },

    handler: ({ state, range, match }) => {
      const matched = String(match[0] ?? "");
      if (matched === "") return null;

      // `range.from` starts exactly at the matched run, so resolving it gives
      // the run's offset inside its textblock — the engine's `index`.
      const $from = state.doc.resolve(range.from);
      const parent = $from.parent;
      if (!parent.isTextblock) return null;

      const subject = parent.textContent;
      const index = $from.parentOffset;
      const groups =
        unanchored
          .exec(matched)
          ?.slice(1)
          .map((group) => group ?? "") ?? [];

      const replacement = rule.replace({
        text: subject,
        match: matched,
        index,
        groups,
        preceding: index > 0 ? subject[index - 1] : "",
        following:
          index + matched.length < subject.length
            ? subject[index + matched.length]
            : "",
      });

      // A rule may judge the position ambiguous (e.g. a word-internal `"`);
      // returning null lets TipTap fall through to plain typing rather than
      // rewriting the keystroke.
      if (replacement === matched) return null;

      state.tr.insertText(replacement, range.from, range.to);
    },
  });
}

export const SmartTypography = Extension.create({
  name: "smartTypography",

  addInputRules() {
    return TYPOGRAPHY_RULES.filter((rule) => !rule.optional).map(compileRule);
  },
});

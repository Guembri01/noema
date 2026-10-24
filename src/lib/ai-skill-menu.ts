/**
 * The pure mapping the editor menus render (R25.19-R25.21).
 *
 * The built-in skills stay code-owned in `./ai-skills`; this module only
 * decides how they are presented. Keeping the mapping out of the components
 * means the selection toolbar and the block menu cannot drift apart, and it is
 * testable without a live editor.
 */

import { AI_SKILLS, type AiSkill, type AiSkillId } from "./ai-skills";
import { LOCALES, type LocaleCode } from "./i18n";

export type TranslateLocaleChoice = {
  code: LocaleCode;
  /** The locale's own name (`Français`, `العربية`, …). */
  label: string;
};

/** One entry of an AI skills menu. */
export type AiSkillMenuEntry =
  | {
      kind: "skill";
      id: AiSkillId;
      label: string;
      hint: string;
      replacesSelection: boolean;
    }
  | {
      kind: "translate";
      id: "translate";
      label: string;
      hint: string;
      replacesSelection: boolean;
      locales: TranslateLocaleChoice[];
    };

/** The five shipped locale targets, in menu order (`./i18n.ts`). */
export function translateLocaleChoices(): TranslateLocaleChoice[] {
  return LOCALES.map((locale) => ({ code: locale.code, label: locale.label }));
}

/**
 * Every built-in skill in registry order. The translate entry carries its
 * locale choices, so a menu can render one "Translate" row with a submenu
 * instead of five near-identical rows.
 */
export function aiSkillMenuEntries(): AiSkillMenuEntry[] {
  return AI_SKILLS.map((skill: AiSkill): AiSkillMenuEntry => {
    if (skill.takesTargetLocale) {
      return {
        kind: "translate",
        id: "translate",
        label: skill.label,
        hint: skill.hint,
        replacesSelection: skill.replacesSelection,
        locales: translateLocaleChoices(),
      };
    }
    return {
      kind: "skill",
      id: skill.id,
      label: skill.label,
      hint: skill.hint,
      replacesSelection: skill.replacesSelection,
    };
  });
}

/** True when the skill needs a target locale (only translate today). */
export function isTranslateSkill(id: string): id is "translate" {
  return AI_SKILLS.some((skill) => skill.id === id && skill.takesTargetLocale === true);
}

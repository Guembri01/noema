import { describe, expect, it } from "vitest";
import { AI_SKILLS } from "./ai-skills";
import { LOCALES } from "./i18n";
import {
  aiSkillMenuEntries,
  isTranslateSkill,
  translateLocaleChoices,
} from "./ai-skill-menu";

/**
 * The menus (selection toolbar + block menu) render `aiSkillMenuEntries`
 * instead of reading the registry themselves. These tests pin the mapping that
 * makes every built-in skill reachable and gives translate its five targets
 * (R25.19-R25.21).
 */

describe("aiSkillMenuEntries", () => {
  it("includes every built-in skill exactly once, in registry order", () => {
    const entries = aiSkillMenuEntries();
    expect(entries.map((entry) => entry.id)).toEqual(AI_SKILLS.map((skill) => skill.id));
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });

  it("exposes the new parity skills to both menus", () => {
    const ids = aiSkillMenuEntries().map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["continue", "simplify", "summarize"]));
  });

  it("carries the five shipped locales on the translate entry", () => {
    const translate = aiSkillMenuEntries().find((entry) => entry.kind === "translate");
    expect(translate).toBeDefined();
    if (translate?.kind !== "translate") return;
    expect(translate.locales.map((locale) => locale.code)).toEqual(
      LOCALES.map((locale) => locale.code),
    );
    expect(translate.locales.map((locale) => locale.label)).toEqual(
      LOCALES.map((locale) => locale.label),
    );
    expect(translate.locales).toHaveLength(5);
  });
});

describe("translateLocaleChoices", () => {
  it("is the shipped locale list, not a hardcoded English target", () => {
    expect(translateLocaleChoices()).toEqual(
      LOCALES.map((locale) => ({ code: locale.code, label: locale.label })),
    );
  });
});

describe("isTranslateSkill", () => {
  it("recognises only the locale-taking skill", () => {
    expect(isTranslateSkill("translate")).toBe(true);
    expect(isTranslateSkill("summarize")).toBe(false);
    expect(isTranslateSkill("nope")).toBe(false);
  });
});

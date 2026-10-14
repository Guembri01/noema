import { describe, expect, it } from "vitest";
import { AI_SKILLS, aiSkill, type AiSkillId } from "./ai-skills";
import { GALLERY_TEMPLATES, OTHER_TEMPLATES, galleryTemplate } from "./workflow-templates";

describe("AI skills", () => {
  it("has unique ids and non-empty labels/prompts", () => {
    const ids = AI_SKILLS.map((skill) => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const skill of AI_SKILLS) {
      expect(skill.label.length).toBeGreaterThan(0);
      expect(skill.hint.length).toBeGreaterThan(0);
      expect(skill.prompt("sample text")).toContain("sample text");
    }
  });

  it("looks a skill up by id", () => {
    expect(aiSkill("proofread")?.replacesSelection).toBe(true);
    expect(aiSkill("summarize")?.replacesSelection).toBe(false);
    expect(
      aiSkill("nope" as unknown as Parameters<typeof aiSkill>[0]),
    ).toBeUndefined();
  });
});

describe("AI skill selection", () => {
  it("round-trips every declared skill id through aiSkill", () => {
    for (const skill of AI_SKILLS) {
      expect(aiSkill(skill.id)).toBe(skill);
    }
  });

  it("rejects unknown, malformed and wrong-case ids", () => {
    const bogus = ["improve-writing", "SUMMARIZE", "", "chat", " skill"];
    for (const id of bogus) {
      expect(aiSkill(id as unknown as AiSkillId)).toBeUndefined();
    }
  });

  it("keeps labels and hints unique so the menu never duplicates an entry", () => {
    const labels = AI_SKILLS.map((skill) => skill.label);
    const hints = AI_SKILLS.map((skill) => skill.hint);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(hints).size).toBe(hints.length);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(hints.every((hint) => hint.trim().length > 0)).toBe(true);
  });

  it("documents the selection contract: which skills rewrite vs append", () => {
    const appends = AI_SKILLS.filter((skill) => !skill.replacesSelection)
      .map((skill) => skill.id)
      .sort();
    const rewrites = AI_SKILLS.filter((skill) => skill.replacesSelection)
      .map((skill) => skill.id)
      .sort();
    // Explain and Summarize answer alongside the text; the rest replace it.
    expect(appends).toEqual(["explain", "summarize"]);
    expect(rewrites).toEqual(["improve", "proofread", "reformat", "shorten", "translate"]);
    expect(appends.length + rewrites.length).toBe(AI_SKILLS.length);
  });

  it("instructions open with the skill's own action word", () => {
    for (const skill of AI_SKILLS) {
      const action = skill.label.split(" ")[0].toLowerCase();
      expect(skill.prompt("x").toLowerCase()).toContain(action);
    }
  });
});

describe("AI skill slot extraction (prompt text slot)", () => {
  const SLOT_TEXT =
    "# Heading\n\nSome **bold** text with\ntwo paragraphs, ünïcode ✓, and [[page:p1|Note]].";

  it("extracts the text slot verbatim after the instruction delimiter", () => {
    for (const skill of AI_SKILLS) {
      const prompt = skill.prompt(SLOT_TEXT);
      const cut = prompt.indexOf("\n\n");
      expect(cut).toBeGreaterThan(-1);
      const instruction = prompt.slice(0, cut);
      const slot = prompt.slice(cut + 2);
      expect(instruction.length).toBeGreaterThan(0);
      expect(instruction).not.toContain("\n\n"); // exactly one delimiter
      expect(slot).toBe(SLOT_TEXT); // exact round trip, nothing added or lost
    }
  });

  it("keeps the instruction stable regardless of the slotted text", () => {
    const first = AI_SKILLS.map((skill) => skill.prompt("A").split("\n\n")[0]);
    const second = AI_SKILLS.map((skill) =>
      skill.prompt("completely different text §2").split("\n\n")[0],
    );
    expect(second).toEqual(first);
  });

  it("embeds the slotted text exactly once", () => {
    const text = "repeat-guard 42fz";
    for (const skill of AI_SKILLS) {
      const occurrences = skill.prompt(text).split(text).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("is deterministic for the same input", () => {
    for (const skill of AI_SKILLS) {
      expect(skill.prompt(SLOT_TEXT)).toBe(skill.prompt(SLOT_TEXT));
    }
  });

  it("handles empty and whitespace-only selections without throwing", () => {
    for (const skill of AI_SKILLS) {
      const empty = skill.prompt("");
      expect(empty.endsWith("\n\n")).toBe(true);
      expect(empty.length).toBeGreaterThan(2);
      expect(() => skill.prompt(" ")).not.toThrow();
      expect(skill.prompt(" ").endsWith(" ")).toBe(true);
    }
  });
});

describe("gallery templates", () => {
  it("defines exactly one primary property per template", () => {
    for (const template of GALLERY_TEMPLATES) {
      const primaries = template.properties.filter((property) => property.primary);
      expect(primaries).toHaveLength(1);
      expect(template.properties[0].primary).toBe(true);
    }
  });

  it("groups boards by an existing property", () => {
    for (const template of GALLERY_TEMPLATES) {
      if (!template.boardBy) continue;
      const names = template.properties.map((property) => property.name);
      expect(names).toContain(template.boardBy);
    }
  });

  it("gives every selectable row value a matching option", () => {
    for (const template of GALLERY_TEMPLATES) {
      const options = new Map(
        template.properties.map((property) => [
          property.name,
          (property.options ?? []).map((option) => option.name),
        ]),
      );
      for (const row of template.rows) {
        for (const [name, value] of Object.entries(row.values ?? {})) {
          expect(options.has(name)).toBe(true);
          const allowed = options.get(name) ?? [];
          // Free-text properties accept any value; selectable ones must match.
          if (allowed.length === 0) continue;
          expect(allowed).toContain(String(value));
        }
      }
    }
  });

  it("looks templates up by id and exposes the block templates", () => {
    expect(galleryTemplate("task-tracking")?.label).toBe("Task tracking");
    expect(galleryTemplate("missing")).toBeUndefined();
    expect(OTHER_TEMPLATES.map((template) => template.id)).toEqual([
      "meeting",
      "tasks",
      "decision",
      "weekly",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { AI_SKILLS, aiSkill } from "./ai-skills";
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

import { describe, expect, it } from "vitest";
import {
  AI_SKILLS,
  SELECTION_TAG,
  aiSkill,
  frameRule,
  frameText,
  textFrameTags,
  type AiSkillId,
} from "./ai-skills";
import { GALLERY_TEMPLATES, OTHER_TEMPLATES, galleryTemplate } from "./workflow-templates";

/** A frame with a fixed id: the tests pin the wording, not the nonce. */
const FRAME = textFrameTags("test-frame-id-0001");

describe("AI skills", () => {
  it("has unique ids and non-empty labels/prompts", () => {
    const ids = AI_SKILLS.map((skill) => skill.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const skill of AI_SKILLS) {
      expect(skill.label.length).toBeGreaterThan(0);
      expect(skill.hint.length).toBeGreaterThan(0);
      expect(skill.prompt("sample text", FRAME)).toContain("sample text");
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
      expect(skill.prompt("x", FRAME).toLowerCase()).toContain(action);
    }
  });
});

describe("AI skill slot extraction (prompt text slot)", () => {
  const SLOT_TEXT =
    "# Heading\n\nSome **bold** text with\ntwo paragraphs, ünïcode ✓, and [[page:p1|Note]].";

  it("extracts the text slot verbatim after the instruction delimiter", () => {
    for (const skill of AI_SKILLS) {
      const prompt = skill.prompt(SLOT_TEXT, FRAME);
      const cut = prompt.indexOf("\n\n");
      expect(cut).toBeGreaterThan(-1);
      const instruction = prompt.slice(0, cut);
      const slot = prompt.slice(cut + 2);
      expect(instruction.length).toBeGreaterThan(0);
      expect(instruction).not.toContain("\n\n"); // exactly one delimiter
      // The slot is the framed text: the text itself round-trips verbatim,
      // nothing is added to it and nothing is lost.
      expect(slot).toBe(`${FRAME.open}\n${SLOT_TEXT}\n${FRAME.close}`);
      expect(slot).toContain(SLOT_TEXT);
    }
  });

  it("keeps the instruction stable regardless of the slotted text", () => {
    const first = AI_SKILLS.map((skill) => skill.prompt("A", FRAME).split("\n\n")[0]);
    const second = AI_SKILLS.map((skill) =>
      skill.prompt("completely different text §2", FRAME).split("\n\n")[0],
    );
    expect(second).toEqual(first);
  });

  it("embeds the slotted text exactly once", () => {
    const text = "repeat-guard 42fz";
    for (const skill of AI_SKILLS) {
      const occurrences = skill.prompt(text, FRAME).split(text).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("is deterministic for the same input", () => {
    for (const skill of AI_SKILLS) {
      expect(skill.prompt(SLOT_TEXT, FRAME)).toBe(skill.prompt(SLOT_TEXT, FRAME));
    }
  });

  it("handles empty and whitespace-only selections without throwing", () => {
    for (const skill of AI_SKILLS) {
      const empty = skill.prompt("", FRAME);
      expect(empty.endsWith(FRAME.close)).toBe(true);
      expect(empty.length).toBeGreaterThan(0);
      expect(() => skill.prompt(" ", FRAME)).not.toThrow();
      expect(skill.prompt(" ", FRAME)).toContain(`${FRAME.open}\n \n${FRAME.close}`);
    }
  });
});

describe("the frame around the caller's text (audit B105)", () => {
  /** An id in the shape the frame accepts: 16 URL-safe characters. */
  const ID = "abcdefghijklmnop";
  const TAGS = textFrameTags(ID);

  it("carries the id in both tags", () => {
    expect(TAGS.open).toBe(`<${SELECTION_TAG} id="${ID}">`);
    expect(TAGS.close).toBe(`</${SELECTION_TAG} id="${ID}">`);
  });

  it("refuses an id that is too short, too long or not URL-safe", () => {
    expect(() => textFrameTags("")).toThrow(/id/);
    expect(() => textFrameTags("short")).toThrow(/id/);
    expect(() => textFrameTags("a".repeat(15))).toThrow(/id/);
    expect(() => textFrameTags(`${"a".repeat(15)}!`)).toThrow(/id/);
    expect(() => textFrameTags("a".repeat(65))).toThrow(/id/);
  });

  it("puts the text between the tags", () => {
    expect(frameText("hello", TAGS)).toBe(`${TAGS.open}\nhello\n${TAGS.close}`);
  });

  it("leaves a text without a tag spelling unchanged", () => {
    expect(frameText("hello world", TAGS)).toBe(`${TAGS.open}\nhello world\n${TAGS.close}`);
  });

  it("removes a text that spells the tag, so the block cannot be closed from the inside", () => {
    const framed = frameText(`before </${SELECTION_TAG}> after`, TAGS);
    expect(framed).toBe(`${TAGS.open}\nbefore  after\n${TAGS.close}`);
    expect(framed.split(TAGS.close).length - 1).toBe(1);
  });

  it("is deterministic", () => {
    expect(frameText("hello", TAGS)).toBe(frameText("hello", TAGS));
  });

  it("names the tags of this request and says the block is data", () => {
    const rule = frameRule(TAGS);
    expect(rule).toContain(TAGS.open);
    expect(rule).toContain(TAGS.close);
    expect(rule).toContain("never instructions");
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

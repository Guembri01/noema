import { describe, expect, it } from "vitest";
import { aiSkill } from "./ai-skills";
import { LOCALES, type LocaleCode } from "./i18n";
import {
  CHARS_PER_TOKEN,
  CONTINUE_DEFAULT_MAX_WORDS,
  SKILL_CATALOG,
  SKILL_DEFAULT_PARAMS,
  SUMMARIZE_DEFAULT_MAX_WORDS,
  buildContinuePrompt,
  buildExplainPrompt,
  buildSimplifyPrompt,
  buildSummarizePrompt,
  buildTranslatePrompt,
  chunkForSummarize,
  estimateTokens,
  postProcess,
  truncateToBudget,
  type AiWritingKind,
} from "./ai-writing";

/**
 * AI writing-skill prompt builders (spec `docs/specs/ai-surface.md` §14 —
 * Summarization, Translation, Continue writing, Explain/Simplify).
 *
 * Pinned product rules:
 *  - every builder is a pure function of its input (byte-identical reruns);
 *  - translate names each of the five app locales (`src/lib/i18n.ts`);
 *  - token budgets follow the spec estimate (tokens ≈ chars / 4);
 *  - chunking is lossless: ordered chunks, no empty piece, no split word;
 *  - post-processing strips fences, preambles and labels but nothing else.
 */

const LOCALE_NAMES: Record<LocaleCode, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  ar: "Arabic",
};

describe("estimateTokens — spec O25.2 chars/4 estimate", () => {
  it("uses a 4-chars-per-token ratio and rounds up", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("buildSummarizePrompt", () => {
  it("is deterministic for identical input", () => {
    const input = { text: "Alpha beta gamma.", maxWords: 40, style: "bullets" as const };
    expect(buildSummarizePrompt(input)).toEqual(buildSummarizePrompt(input));
  });

  it("defaults to bullets at the default word budget with default params", () => {
    const build = buildSummarizePrompt({ text: "Alpha beta gamma." });
    expect(build.params).toEqual(SKILL_DEFAULT_PARAMS.summarize);
    expect(build.user).toContain("Alpha beta gamma.");
    expect(build.user).toContain("bullet");
    expect(build.user).toContain(String(SUMMARIZE_DEFAULT_MAX_WORDS));
    expect(build.system.length).toBeGreaterThan(0);
  });

  it("embeds an explicit maxWords in the instruction", () => {
    expect(buildSummarizePrompt({ text: "t", maxWords: 25 }).user).toContain("25");
  });

  it("switches wording per style", () => {
    const paragraph = buildSummarizePrompt({ text: "t", style: "paragraph" });
    const outline = buildSummarizePrompt({ text: "t", style: "outline" });
    expect(paragraph.user).toContain("paragraph");
    expect(outline.user).toContain("outline");
    expect(paragraph.user).not.toBe(outline.user);
  });

  it("grows the output budget when more words are requested (capped)", () => {
    const small = buildSummarizePrompt({ text: "t", maxWords: 10 }).params.maxTokens;
    const large = buildSummarizePrompt({ text: "t", maxWords: 5000 }).params.maxTokens;
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(4096);
  });
});

describe("buildTranslatePrompt", () => {
  it("names every shipped locale in the prompt", () => {
    expect(LOCALES).toHaveLength(5);
    for (const { code } of LOCALES) {
      const { user } = buildTranslatePrompt({ text: "Bonjour", targetLocale: code });
      expect(user).toContain(LOCALE_NAMES[code]);
      expect(user).toContain(`(${code})`);
    }
  });

  it("defaults to a neutral tone and allows an override", () => {
    expect(buildTranslatePrompt({ text: "x", targetLocale: "fr" }).user).toContain("neutral");
    expect(
      buildTranslatePrompt({ text: "x", targetLocale: "fr", tone: "formal" }).user,
    ).toContain("formal");
  });

  it("returns the default translate params and is deterministic", () => {
    const build = buildTranslatePrompt({ text: "Bonjour le monde", targetLocale: "de" });
    expect(build.params).toEqual(SKILL_DEFAULT_PARAMS.translate);
    expect(build).toEqual(buildTranslatePrompt({ text: "Bonjour le monde", targetLocale: "de" }));
  });

  it("grows the output budget for long input", () => {
    const short = buildTranslatePrompt({ text: "hi", targetLocale: "fr" }).params.maxTokens;
    const long = buildTranslatePrompt({ text: "word ".repeat(500), targetLocale: "fr" }).params
      .maxTokens;
    expect(long).toBeGreaterThan(short);
  });

  it("rejects a locale that is not shipped", () => {
    expect(() =>
      buildTranslatePrompt({ text: "x", targetLocale: "xx" as LocaleCode }),
    ).toThrow(/locale/i);
  });
});

describe("buildContinuePrompt", () => {
  it("asks for a continuation of the given text with default params", () => {
    const build = buildContinuePrompt({ text: "Once upon a time." });
    expect(build.user).toContain("Once upon a time.");
    expect(build.user).toContain("continuation");
    expect(build.user).toContain(String(CONTINUE_DEFAULT_MAX_WORDS));
    expect(build.params).toEqual(SKILL_DEFAULT_PARAMS.continue);
  });

  it("embeds the requested tone", () => {
    expect(buildContinuePrompt({ text: "t", tone: "friendly" }).user).toContain("friendly");
  });

  it("is deterministic", () => {
    const input = { text: "t", tone: "casual" as const, maxWords: 80 };
    expect(buildContinuePrompt(input)).toEqual(buildContinuePrompt(input));
  });
});

describe("buildSimplifyPrompt", () => {
  it("defaults the audience to general", () => {
    const build = buildSimplifyPrompt({ text: "Quantum chromodynamics." });
    expect(build.user).toContain("general");
    expect(build.user).toContain("Quantum chromodynamics.");
    expect(build.params).toEqual(SKILL_DEFAULT_PARAMS.simplify);
  });

  it("embeds a custom audience and stays deterministic", () => {
    const input = { text: "t", audience: "beginner" as const };
    expect(buildSimplifyPrompt(input).user).toContain("beginner");
    expect(buildSimplifyPrompt(input)).toEqual(buildSimplifyPrompt(input));
  });
});

describe("buildExplainPrompt", () => {
  it("asks for a plain-language explanation of the text", () => {
    const build = buildExplainPrompt({ text: "Entropy always increases." });
    expect(build.user).toContain("plain language");
    expect(build.user).toContain("Entropy always increases.");
    expect(build.params).toEqual(SKILL_DEFAULT_PARAMS.explain);
  });

  it("is deterministic", () => {
    expect(buildExplainPrompt({ text: "t" })).toEqual(buildExplainPrompt({ text: "t" }));
  });
});

describe("truncateToBudget", () => {
  it("returns text that already fits unchanged", () => {
    expect(truncateToBudget("abcd", 1)).toBe("abcd");
    expect(truncateToBudget("hello world", 10)).toBe("hello world");
  });

  it("cuts on a word boundary and appends an ellipsis when over budget", () => {
    expect(truncateToBudget("hello world foo", 2)).toBe("hello…");
  });

  it("falls back to a hard cut when there is no word boundary", () => {
    expect(truncateToBudget("abcdefghij", 1)).toBe("abcd…");
  });

  it("returns an empty string for non-positive budgets and empty input", () => {
    expect(truncateToBudget("hello", 0)).toBe("");
    expect(truncateToBudget("hello", -5)).toBe("");
    expect(truncateToBudget("", 5)).toBe("");
  });
});

describe("chunkForSummarize", () => {
  it("returns no chunks and no reduce prompt for blank input", () => {
    expect(chunkForSummarize("   ", { maxTokens: 10 })).toEqual({ chunks: [], reducePrompt: "" });
  });

  it("keeps text under budget as a single chunk without a reduce step", () => {
    const plan = chunkForSummarize("one two three", { maxTokens: 20 });
    expect(plan.chunks).toEqual(["one two three"]);
    expect(plan.reducePrompt).toBe("");
  });

  it("splits paragraphs into ordered chunks and supplies a reduce prompt", () => {
    const text = "aaaa bbbb cccc\n\ndddd eeee ffff\n\ngggg hhhh iiii";
    const plan = chunkForSummarize(text, { maxTokens: 5 });
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks[0]).toContain("aaaa");
    expect(plan.chunks[1]).toContain("dddd");
    expect(plan.chunks[2]).toContain("gggg");
    expect(plan.reducePrompt).toContain("3 partial summaries");
  });

  it("hard-splits a single oversized paragraph so every chunk fits the budget", () => {
    const plan = chunkForSummarize("hello world foo", { maxTokens: 2 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const chunk of plan.chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(2);
    }
  });

  it("preserves word order across chunks", () => {
    const plan = chunkForSummarize("hello world foo bar baz", { maxTokens: 2 });
    expect(plan.chunks.join(" ").split(/\s+/)).toEqual(["hello", "world", "foo", "bar", "baz"]);
  });

  it("never emits an empty chunk", () => {
    const plan = chunkForSummarize("hello world foo", { maxTokens: 1 });
    expect(plan.chunks.length).toBeGreaterThan(0);
    for (const chunk of plan.chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });
});

describe("postProcess", () => {
  it("leaves already-clean output untouched", () => {
    expect(postProcess("summarize", "- one\n- two")).toBe("- one\n- two");
  });

  it("removes a wrapping code fence", () => {
    expect(postProcess("explain", "```\nHello\n```")).toBe("Hello");
  });

  it("removes a language-tagged code fence", () => {
    expect(postProcess("simplify", "```markdown\nPlain text.\n```")).toBe("Plain text.");
  });

  it("strips a conversational preamble", () => {
    expect(postProcess("summarize", "Sure, here is the summary:\n\n- one\n- two")).toBe(
      "- one\n- two",
    );
  });

  it("strips a kind label such as a translation heading", () => {
    expect(postProcess("translate", "Translation: Bonjour le monde")).toBe("Bonjour le monde");
  });

  it("unwraps quotes around a translation", () => {
    expect(postProcess("translate", '"Bonjour le monde"')).toBe("Bonjour le monde");
  });

  it("returns an empty string for blank output", () => {
    expect(postProcess("continue", "   \n  ")).toBe("");
  });
});

describe("SKILL_CATALOG", () => {
  const kinds: AiWritingKind[] = ["summarize", "translate", "continue", "simplify", "explain"];

  it("describes every writing skill exactly once", () => {
    expect(SKILL_CATALOG.map((skill) => skill.id)).toEqual(kinds);
    expect(new Set(SKILL_CATALOG.map((skill) => skill.id)).size).toBe(kinds.length);
  });

  it("carries a label, hint and the default params for each skill", () => {
    for (const skill of SKILL_CATALOG) {
      expect(skill.label.length).toBeGreaterThan(0);
      expect(skill.hint.length).toBeGreaterThan(0);
      expect(skill.params).toEqual(SKILL_DEFAULT_PARAMS[skill.id]);
    }
  });

  it("reuses the existing registry wording for overlapping skills", () => {
    for (const id of ["summarize", "translate", "explain"] as const) {
      expect(SKILL_CATALOG.find((skill) => skill.id === id)?.label).toBe(aiSkill(id)?.label);
    }
    expect(SKILL_CATALOG.find((skill) => skill.id === "summarize")?.replacesSelection).toBe(false);
    expect(SKILL_CATALOG.find((skill) => skill.id === "simplify")?.replacesSelection).toBe(true);
  });
});

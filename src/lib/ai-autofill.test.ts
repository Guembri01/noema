import { describe, expect, it } from "vitest";
import {
  AI_AUTOFILL_LIMITS,
  DEFAULT_AI_MAX_TOKENS,
  DEFAULT_AI_TEMPERATURE,
  describeAiAutofill,
  normalizeAiAutofillConfig,
  parseAiAutofillConfig,
  validateAiAutofillConfig,
  type AiAutofillParseResult,
} from "@/lib/ai-autofill";

/**
 * AI-autofill property configuration (the `AI_AUTOFILL` property type's
 * `Property.config`).
 *
 * The config is the persisted prompt an AI-autofill column runs when a row is
 * created, plus the optional `targetPropertyId` it writes into and the sampling
 * knobs (`maxTokens`, `temperature`). Like every other `src/lib` config helper
 * it round-trips through the DB as untrusted JSON, so this module owns the
 * *shape* of that config: a strict `parse` (structure), a fail-safe `normalize`
 * (repair), a `validate` that reports every bounds problem at once, and a
 * human-readable `describe`.
 *
 * Red-first: this file failed to import (`@/lib/ai-autofill` did not exist)
 * before the implementation landed. Every case is deterministic — no clock, no
 * network, no DB.
 */

const codesOf = (config: unknown): string[] =>
  validateAiAutofillConfig(config).map((issue) => issue.code);

const ok = (result: AiAutofillParseResult) => {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.config;
};

describe("parseAiAutofillConfig", () => {
  it("parses a full object, trimming the prompt and target id", () => {
    expect(
      ok(
        parseAiAutofillConfig({
          prompt: "  Summarize the page.  ",
          targetPropertyId: "  prop1  ",
          maxTokens: 256,
          temperature: 0.2,
        }),
      ),
    ).toEqual({
      prompt: "Summarize the page.",
      targetPropertyId: "prop1",
      maxTokens: 256,
      temperature: 0.2,
    });
  });

  it("parses a JSON string the same way it parses an object", () => {
    expect(
      ok(
        parseAiAutofillConfig(
          '{"prompt":"Draft a title","targetPropertyId":"p2","maxTokens":128,"temperature":0.9}',
        ),
      ),
    ).toEqual({
      prompt: "Draft a title",
      targetPropertyId: "p2",
      maxTokens: 128,
      temperature: 0.9,
    });
  });

  it("omits absent optional fields and defaults a missing prompt to an empty string", () => {
    expect(ok(parseAiAutofillConfig({ prompt: "Hi" }))).toEqual({ prompt: "Hi" });
    expect(ok(parseAiAutofillConfig({}))).toEqual({ prompt: "" });
  });

  it("treats null and undefined optional fields as absent", () => {
    expect(
      ok(
        parseAiAutofillConfig({
          prompt: "Hi",
          targetPropertyId: null,
          maxTokens: undefined,
          temperature: null,
        }),
      ),
    ).toEqual({ prompt: "Hi" });
  });

  it("drops a blank target id rather than keeping whitespace", () => {
    expect(ok(parseAiAutofillConfig({ prompt: "Hi", targetPropertyId: "   " }))).toEqual({
      prompt: "Hi",
    });
  });

  it("lets structurally-valid but out-of-range numbers through for validate to flag", () => {
    expect(
      ok(parseAiAutofillConfig({ prompt: "Hi", temperature: 5, maxTokens: 999999 })),
    ).toEqual({ prompt: "Hi", temperature: 5, maxTokens: 999999 });
  });

  it("reports malformed JSON as an error instead of throwing", () => {
    const result = parseAiAutofillConfig("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toBe("");
  });

  it("reports a non-object (null, number, array, boolean) as an error", () => {
    for (const raw of [null, undefined, 42, true, [1, 2, 3]]) {
      const result = parseAiAutofillConfig(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toBe("");
    }
  });

  it("reports a JSON string that is not an object as an error", () => {
    expect(parseAiAutofillConfig('"just a string"').ok).toBe(false);
    expect(parseAiAutofillConfig("123").ok).toBe(false);
  });

  it("reports wrong-typed fields as an error", () => {
    expect(parseAiAutofillConfig({ prompt: 7 }).ok).toBe(false);
    expect(parseAiAutofillConfig({ prompt: "Hi", targetPropertyId: 9 }).ok).toBe(false);
    expect(parseAiAutofillConfig({ prompt: "Hi", temperature: "warm" }).ok).toBe(false);
    expect(parseAiAutofillConfig({ prompt: "Hi", maxTokens: "lots" }).ok).toBe(false);
  });
});

describe("normalizeAiAutofillConfig", () => {
  it("coerces a raw config into the canonical shape, trimming strings", () => {
    expect(
      normalizeAiAutofillConfig({
        prompt: "  Summarize.  ",
        targetPropertyId: " prop1 ",
        maxTokens: 256,
        temperature: 0.2,
      }),
    ).toEqual({
      prompt: "Summarize.",
      targetPropertyId: "prop1",
      maxTokens: 256,
      temperature: 0.2,
    });
  });

  it("defaults a missing prompt to an empty string and drops a blank target", () => {
    expect(normalizeAiAutofillConfig({})).toEqual({ prompt: "" });
    expect(normalizeAiAutofillConfig({ prompt: "Hi", targetPropertyId: "   " })).toEqual({
      prompt: "Hi",
    });
  });

  it("clamps temperature into 0..2", () => {
    expect(normalizeAiAutofillConfig({ prompt: "Hi", temperature: -1 }).temperature).toBe(0);
    expect(normalizeAiAutofillConfig({ prompt: "Hi", temperature: 5 }).temperature).toBe(2);
  });

  it("rounds maxTokens to a whole number and clamps it to the bounds", () => {
    expect(normalizeAiAutofillConfig({ prompt: "Hi", maxTokens: 0 }).maxTokens).toBe(
      AI_AUTOFILL_LIMITS.minTokens,
    );
    expect(normalizeAiAutofillConfig({ prompt: "Hi", maxTokens: 999999 }).maxTokens).toBe(
      AI_AUTOFILL_LIMITS.maxTokens,
    );
    expect(normalizeAiAutofillConfig({ prompt: "Hi", maxTokens: 3.6 }).maxTokens).toBe(4);
  });

  it("drops non-numeric and non-finite numbers instead of inventing one", () => {
    expect(normalizeAiAutofillConfig({ prompt: "Hi", temperature: "0.5" })).toEqual({ prompt: "Hi" });
    expect(normalizeAiAutofillConfig({ prompt: "Hi", maxTokens: NaN })).toEqual({ prompt: "Hi" });
    expect(normalizeAiAutofillConfig({ prompt: "Hi", temperature: Infinity })).toEqual({
      prompt: "Hi",
    });
  });

  it("tolerates a JSON string, null, primitives and arrays without throwing", () => {
    expect(normalizeAiAutofillConfig('{"prompt":"Hi","temperature":0.5}')).toEqual({
      prompt: "Hi",
      temperature: 0.5,
    });
    expect(normalizeAiAutofillConfig("not json")).toEqual({ prompt: "" });
    expect(normalizeAiAutofillConfig(null)).toEqual({ prompt: "" });
    expect(normalizeAiAutofillConfig(42)).toEqual({ prompt: "" });
    expect(normalizeAiAutofillConfig([1, 2])).toEqual({ prompt: "" });
  });

  it("is idempotent", () => {
    const once = normalizeAiAutofillConfig({
      prompt: "Summarize.",
      targetPropertyId: "p1",
      maxTokens: 999999,
      temperature: -3,
    });
    expect(normalizeAiAutofillConfig(once)).toEqual(once);
  });
});

describe("validateAiAutofillConfig", () => {
  it("accepts a well-formed configuration", () => {
    expect(
      validateAiAutofillConfig({
        prompt: "Summarize the page.",
        targetPropertyId: "p1",
        temperature: 0.4,
        maxTokens: 256,
      }),
    ).toEqual([]);
  });

  it("accepts the inclusive boundaries", () => {
    expect(
      validateAiAutofillConfig({
        prompt: "a".repeat(AI_AUTOFILL_LIMITS.maxPromptLength),
        temperature: AI_AUTOFILL_LIMITS.minTemperature,
        maxTokens: AI_AUTOFILL_LIMITS.minTokens,
      }),
    ).toEqual([]);
    expect(
      validateAiAutofillConfig({
        prompt: "a",
        temperature: AI_AUTOFILL_LIMITS.maxTemperature,
        maxTokens: AI_AUTOFILL_LIMITS.maxTokens,
      }),
    ).toEqual([]);
  });

  it("flags a missing, empty or non-string prompt", () => {
    expect(codesOf({})).toContain("EMPTY_PROMPT");
    expect(codesOf({ prompt: "   " })).toContain("EMPTY_PROMPT");
    expect(codesOf({ prompt: 7 })).toContain("EMPTY_PROMPT");
    expect(codesOf(null)).toContain("EMPTY_PROMPT");
  });

  it("flags a prompt longer than the limit, and only that", () => {
    const codes = codesOf({ prompt: "a".repeat(AI_AUTOFILL_LIMITS.maxPromptLength + 1) });
    expect(codes).toContain("PROMPT_TOO_LONG");
    expect(codes).not.toContain("EMPTY_PROMPT");
  });

  it("flags a temperature outside 0..2 (including NaN and a string)", () => {
    expect(codesOf({ prompt: "Hi", temperature: -0.1 })).toContain("TEMPERATURE_OUT_OF_RANGE");
    expect(codesOf({ prompt: "Hi", temperature: 2.5 })).toContain("TEMPERATURE_OUT_OF_RANGE");
    expect(codesOf({ prompt: "Hi", temperature: NaN })).toContain("TEMPERATURE_OUT_OF_RANGE");
    expect(codesOf({ prompt: "Hi", temperature: "0.5" })).toContain("TEMPERATURE_OUT_OF_RANGE");
  });

  it("accepts temperature 0 and 2 as in range", () => {
    expect(codesOf({ prompt: "Hi", temperature: 0 })).toEqual([]);
    expect(codesOf({ prompt: "Hi", temperature: 2 })).toEqual([]);
  });

  it("flags maxTokens outside its bounds and any non-integer", () => {
    expect(codesOf({ prompt: "Hi", maxTokens: 0 })).toContain("TOKENS_OUT_OF_RANGE");
    expect(codesOf({ prompt: "Hi", maxTokens: AI_AUTOFILL_LIMITS.maxTokens + 1 })).toContain(
      "TOKENS_OUT_OF_RANGE",
    );
    expect(codesOf({ prompt: "Hi", maxTokens: 12.5 })).toContain("TOKENS_OUT_OF_RANGE");
    expect(codesOf({ prompt: "Hi", maxTokens: "many" })).toContain("TOKENS_OUT_OF_RANGE");
  });

  it("collects every issue at once, in a stable order", () => {
    expect(
      codesOf({ prompt: "", temperature: 9, maxTokens: 0 }),
    ).toEqual(["EMPTY_PROMPT", "TEMPERATURE_OUT_OF_RANGE", "TOKENS_OUT_OF_RANGE"]);
  });

  it("reads a JSON string and never throws on exotic input", () => {
    expect(codesOf('{"prompt":"Hi","temperature":0.5}')).toEqual([]);
    expect(codesOf("not json")).toContain("EMPTY_PROMPT");
    expect(codesOf(42)).toContain("EMPTY_PROMPT");
    expect(codesOf([1, 2, 3])).toContain("EMPTY_PROMPT");
  });
});

describe("describeAiAutofill", () => {
  it("uses the default sampling knobs when none are set", () => {
    expect(describeAiAutofill({ prompt: "Summarize the page." })).toBe(
      `AI autofill "Summarize the page." (temperature ${DEFAULT_AI_TEMPERATURE}, max ${DEFAULT_AI_MAX_TOKENS} tokens)`,
    );
  });

  it("names the target property when one is configured", () => {
    expect(describeAiAutofill({ prompt: "Summarize.", targetPropertyId: "prop1" })).toBe(
      `AI autofill "Summarize." → prop1 (temperature ${DEFAULT_AI_TEMPERATURE}, max ${DEFAULT_AI_MAX_TOKENS} tokens)`,
    );
  });

  it("reflects explicit temperature and maxTokens", () => {
    expect(
      describeAiAutofill({ prompt: "Summarize.", temperature: 1, maxTokens: 256 }),
    ).toBe('AI autofill "Summarize." (temperature 1, max 256 tokens)');
  });

  it("truncates a very long prompt with an ellipsis", () => {
    const long = "x".repeat(80);
    expect(describeAiAutofill({ prompt: long })).toContain(`${"x".repeat(60)}…`);
  });

  it("describes missing or unreadable input with a placeholder prompt", () => {
    expect(describeAiAutofill(null)).toBe(
      `AI autofill "(no prompt)" (temperature ${DEFAULT_AI_TEMPERATURE}, max ${DEFAULT_AI_MAX_TOKENS} tokens)`,
    );
    expect(describeAiAutofill("not json")).toBe(
      `AI autofill "(no prompt)" (temperature ${DEFAULT_AI_TEMPERATURE}, max ${DEFAULT_AI_MAX_TOKENS} tokens)`,
    );
  });
});

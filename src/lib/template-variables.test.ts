import { describe, expect, it } from "vitest";
import {
  availableVariables,
  extractVariables,
  interpolate,
  interpolateBlocks,
  renderBuiltins,
  validateTemplate,
} from "./template-variables";

describe("interpolate", () => {
  it("replaces a known token", () => {
    expect(interpolate("Hi {{name}}!", { name: "Ada" })).toBe("Hi Ada!");
  });

  it("substitutes a fallback for a missing variable", () => {
    expect(interpolate("{{name|friend}}", {})).toBe("friend");
  });

  it("prefers a present value over the fallback", () => {
    expect(interpolate("{{name|friend}}", { name: "Ada" })).toBe("Ada");
  });

  it("replaces a missing variable with an empty string when there is no fallback", () => {
    expect(interpolate("a{{ghost}}b", {})).toBe("ab");
  });

  it("treats an empty-string value as present, so the fallback is ignored", () => {
    expect(interpolate("{{name|fb}}", { name: "" })).toBe("");
  });

  it("treats null and undefined values as missing", () => {
    expect(interpolate("{{a|fb}}/{{b|fb}}", { a: null, b: undefined })).toBe("fb/fb");
  });

  it("coerces numbers and booleans to strings", () => {
    expect(interpolate("{{n}} {{flag}}", { n: 3, flag: true })).toBe("3 true");
  });

  it("tolerates whitespace inside a token", () => {
    expect(interpolate("{{ name }} {{ x | fallback }}", { name: "Ada" })).toBe("Ada fallback");
  });

  it("trims surrounding whitespace from the fallback", () => {
    expect(interpolate("{{x|  spaced  }}", {})).toBe("spaced");
  });

  it("supports an empty fallback", () => {
    expect(interpolate("a{{x|}}b", {})).toBe("ab");
  });

  it("leaves malformed tokens verbatim", () => {
    expect(interpolate("{{}} {{unclosed", {})).toBe("{{}} {{unclosed");
  });

  it("repeats and mixes tokens deterministically", () => {
    expect(interpolate("{{a}}-{{b|z}}-{{a}}", { a: "1" })).toBe("1-z-1");
  });
});

describe("extractVariables", () => {
  it("returns deduped names in first-appearance order", () => {
    expect(extractVariables("{{b}} {{a}} {{b|c}}")).toEqual(["b", "a"]);
  });

  it("ignores fallback text", () => {
    expect(extractVariables("{{a|{{b}}}}")).toEqual(["a"]);
  });

  it("returns an empty list when there are no tokens", () => {
    expect(extractVariables("plain text")).toEqual([]);
  });

  it("trims whitespace around names", () => {
    expect(extractVariables("{{ a }}\n{{b}}")).toEqual(["a", "b"]);
  });
});

describe("availableVariables", () => {
  it("lists defined keys sorted, dropping nullish values", () => {
    expect(availableVariables({ b: "2", a: "1", c: null, d: undefined })).toEqual(["a", "b"]);
  });

  it("returns an empty list for an empty context", () => {
    expect(availableVariables()).toEqual([]);
  });
});

describe("validateTemplate", () => {
  it("reports nothing when no known variables are supplied", () => {
    expect(validateTemplate("{{ghost}}")).toEqual([]);
  });

  it("flags each unknown variable once, with token and index", () => {
    expect(validateTemplate("{{known}} {{oops}} {{oops}}", { knownVars: ["known"] })).toEqual([
      { code: "unknown_variable", name: "oops", token: "{{oops}}", index: 10 },
    ]);
  });

  it("passes when every variable is known", () => {
    expect(validateTemplate("{{a}} {{b|c}}", { knownVars: ["a", "b"] })).toEqual([]);
  });

  it("accepts any iterable of known variables, such as a Set", () => {
    expect(validateTemplate("{{a}} {{x}}", { knownVars: new Set(["a"]) })).toHaveLength(1);
  });
});

describe("interpolateBlocks", () => {
  const source = [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Hi {{name}}" }],
    },
  ];

  it("interpolates text deeply without mutating the source", () => {
    const out = interpolateBlocks(source, { name: "Ada" });
    expect(out[0].content?.[0].text).toBe("Hi Ada");
    expect(source[0].content?.[0].text).toBe("Hi {{name}}");
    expect(out[0]).not.toBe(source[0]);
  });

  it("preserves non-text fields", () => {
    const out = interpolateBlocks(source, { name: "Ada" });
    expect(out[0].type).toBe("heading");
    expect(out[0].attrs).toEqual({ level: 1 });
  });

  it("handles empty input and text-less nodes", () => {
    expect(interpolateBlocks([])).toEqual([]);
    expect(interpolateBlocks([{ type: "paragraph" }])).toEqual([{ type: "paragraph" }]);
  });
});

describe("renderBuiltins", () => {
  it("derives {{date}} from today", () => {
    expect(renderBuiltins({ today: new Date("2026-10-15T12:00:00Z") })).toEqual({
      date: "2026-10-15",
    });
  });

  it("derives {{title}} from the run instant (now)", () => {
    expect(renderBuiltins({ now: new Date("2026-10-20T09:00:00Z") }).title).toBe("2026-10-20");
  });

  it("keeps date and title from their distinct sources", () => {
    expect(
      renderBuiltins({
        today: new Date("2026-10-15T23:00:00Z"),
        now: new Date("2026-10-20T01:00:00Z"),
      }),
    ).toEqual({ date: "2026-10-15", title: "2026-10-20" });
  });

  it("includes the user name when given", () => {
    expect(renderBuiltins({ user: "Ada" }).user).toBe("Ada");
  });

  it("omits builtins with no source", () => {
    expect(renderBuiltins()).toEqual({});
  });

  it("ignores invalid dates", () => {
    expect(renderBuiltins({ today: new Date("nope") })).toEqual({});
  });

  it("falls the date back to now when today is absent", () => {
    expect(renderBuiltins({ now: new Date("2026-10-20T09:00:00Z") }).date).toBe("2026-10-20");
  });

  it("composes with interpolate", () => {
    expect(
      interpolate("{{date}} by {{user}}", renderBuiltins({ today: new Date("2026-10-15T12:00:00Z"), user: "Ada" })),
    ).toBe("2026-10-15 by Ada");
  });
});

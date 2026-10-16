import { describe, expect, it } from "vitest";
import {
  PROMPT_LIMITS,
  PromptRenderError,
  clonePrompt,
  createPrompt,
  createPromptLibrary,
  deletePrompt,
  describePrompt,
  extractVariables,
  listPrompts,
  renderPrompt,
  updatePrompt,
  validatePrompt,
  type PromptTemplate,
} from "./ai-prompt-library";

const ISO = "2026-01-01T00:00:00.000Z";
const ISO2 = "2026-02-01T00:00:00.000Z";

/** A valid template whose fields a test can override. */
function tpl(over: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: "t1",
    name: "Summarize",
    body: "Summarize {{text}}",
    variables: ["text"],
    scope: "workspace",
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

/** Run `fn`, returning whatever it threw (or `undefined`). */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("extractVariables", () => {
  it("dedupes and sorts the {{name}} tokens", () => {
    expect(extractVariables("{{b}} {{a}} {{b}}")).toEqual(["a", "b"]);
  });

  it("ignores a token escaped with a backslash", () => {
    expect(extractVariables("\\{{a}} {{b}}")).toEqual(["b"]);
  });

  it("returns an empty list when every token is escaped", () => {
    expect(extractVariables("\\{{a}} \\{{b}}")).toEqual([]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(extractVariables("{{ a }}\n{{b}}\t{{ c }}")).toEqual(["a", "b", "c"]);
  });

  it("accepts dots, dashes and underscores in a name", () => {
    expect(extractVariables("{{user.name}} {{first-name}} {{a_b}}")).toEqual([
      "a_b",
      "first-name",
      "user.name",
    ]);
  });

  it("ignores malformed and unclosed braces", () => {
    expect(extractVariables("{{}} {{unclosed {{a|b}} {single}")).toEqual([]);
  });

  it("returns an empty list for plain text", () => {
    expect(extractVariables("no tokens here")).toEqual([]);
  });

  it("never throws on empty or non-string input", () => {
    expect(extractVariables("")).toEqual([]);
    expect(extractVariables(null as unknown as string)).toEqual([]);
  });
});

describe("renderPrompt", () => {
  it("substitutes every referenced variable", () => {
    const t = tpl({ body: "Hello {{name}}, welcome {{name}}!", variables: ["name"] });
    expect(renderPrompt(t, { name: "Ada" })).toBe("Hello Ada, welcome Ada!");
  });

  it("coerces numbers and booleans to strings", () => {
    const t = tpl({ body: "{{n}} of {{flag}}", variables: ["n", "flag"] });
    expect(renderPrompt(t, { n: 3, flag: true })).toBe("3 of true");
  });

  it("treats an empty string as a present value", () => {
    const t = tpl({ body: "[{{x}}]", variables: ["x"] });
    expect(renderPrompt(t, { x: "" })).toBe("[]");
  });

  it("throws a PromptRenderError for a missing variable", () => {
    const t = tpl({ body: "Hi {{name}} from {{place}}", variables: ["name", "place"] });
    const error = capture(() => renderPrompt(t, { name: "Ada" }));
    expect(error).toBeInstanceOf(PromptRenderError);
    expect((error as PromptRenderError).missing).toEqual(["place"]);
  });

  it("lists every missing variable sorted and deduped", () => {
    const t = tpl({ body: "{{b}} {{a}} {{b}}", variables: ["a", "b"] });
    const error = capture(() => renderPrompt(t, {}));
    expect((error as PromptRenderError).missing).toEqual(["a", "b"]);
  });

  it("ignores declared-but-unused variables", () => {
    const t = tpl({ body: "Hi {{name}}", variables: ["name", "unused"] });
    expect(renderPrompt(t, { name: "Ada" })).toBe("Hi Ada");
  });

  it("preserves literal braces that are not tokens", () => {
    const t = tpl({ body: 'Keep {"json":true} and {{}} and {single}', variables: [] });
    expect(renderPrompt(t)).toBe('Keep {"json":true} and {{}} and {single}');
  });

  it("renders an escaped token literally without a value", () => {
    const t = tpl({ body: "Use \\{{name}} literally and {{name}} again", variables: ["name"] });
    expect(renderPrompt(t, { name: "Ada" })).toBe("Use {{name}} literally and Ada again");
  });

  it("ignores extra values that the body never references", () => {
    const t = tpl({ body: "Hi {{name}}", variables: ["name"] });
    expect(renderPrompt(t, { name: "Ada", extra: "x" })).toBe("Hi Ada");
  });
});

describe("validatePrompt", () => {
  it("accepts a well-formed template", () => {
    expect(validatePrompt(tpl(), [])).toEqual([]);
  });

  it("flags an empty name", () => {
    const codes = validatePrompt(tpl({ name: "   " }), []).map((issue) => issue.code);
    expect(codes).toContain("EMPTY_NAME");
  });

  it("flags an empty body", () => {
    const codes = validatePrompt(tpl({ body: "   " }), []).map((issue) => issue.code);
    expect(codes).toContain("EMPTY_BODY");
  });

  it("caps the name length", () => {
    const name = "x".repeat(PROMPT_LIMITS.maxNameLength + 1);
    const codes = validatePrompt(tpl({ name }), []).map((issue) => issue.code);
    expect(codes).toContain("NAME_TOO_LONG");
  });

  it("caps the body length", () => {
    const body = "y".repeat(PROMPT_LIMITS.maxBodyLength + 1);
    const codes = validatePrompt(tpl({ body, variables: [] }), []).map((issue) => issue.code);
    expect(codes).toContain("BODY_TOO_LONG");
  });

  it("flags a duplicate name within the same scope, case-insensitively", () => {
    const existing = [tpl({ id: "t2", name: "summarize" })];
    const codes = validatePrompt(tpl({ id: "t1", name: "Summarize" }), existing).map(
      (issue) => issue.code,
    );
    expect(codes).toContain("DUPLICATE_NAME");
  });

  it("allows the same name across scopes", () => {
    const existing = [tpl({ id: "t2", name: "Summarize", scope: "personal" })];
    const codes = validatePrompt(tpl({ id: "t1", name: "Summarize" }), existing).map(
      (issue) => issue.code,
    );
    expect(codes).not.toContain("DUPLICATE_NAME");
  });

  it("does not flag a template against its own stored copy", () => {
    const existing = [tpl({ id: "t1", name: "Summarize" })];
    const codes = validatePrompt(tpl({ id: "t1", name: "Summarize" }), existing).map(
      (issue) => issue.code,
    );
    expect(codes).not.toContain("DUPLICATE_NAME");
  });

  it("flags a body token that is not declared as a variable", () => {
    const t = tpl({ body: "Summarize {{text}} for {{audience}}", variables: ["text"] });
    const issues = validatePrompt(t, []);
    expect(issues.map((issue) => issue.code)).toContain("UNKNOWN_VARIABLE");
    expect(issues.find((issue) => issue.code === "UNKNOWN_VARIABLE")?.variable).toBe("audience");
  });

  it("flags a declared variable the body never uses", () => {
    const t = tpl({ body: "Summarize {{text}}", variables: ["text", "tone"] });
    const issues = validatePrompt(t, []);
    expect(issues.map((issue) => issue.code)).toContain("UNUSED_VARIABLE");
    expect(issues.find((issue) => issue.code === "UNUSED_VARIABLE")?.variable).toBe("tone");
  });

  it("caps the number of variables", () => {
    const variables = Array.from({ length: PROMPT_LIMITS.maxVariables + 1 }, (_, i) => `v${i}`);
    const body = variables.map((name) => `{{${name}}}`).join(" ");
    const codes = validatePrompt(tpl({ variables, body }), []).map((issue) => issue.code);
    expect(codes).toContain("TOO_MANY_VARIABLES");
  });
});

describe("createPrompt / updatePrompt / deletePrompt", () => {
  it("creates a template, deriving its variables and timestamps", () => {
    const empty = createPromptLibrary();
    const next = createPrompt(empty, {
      name: "Summarize",
      body: "Summarize {{text}}",
      scope: "workspace",
      now: ISO,
    });
    expect(empty.prompts).toHaveLength(0);
    expect(next).not.toBe(empty);
    const prompt = next.prompts[0];
    expect(prompt.id).toBe("summarize");
    expect(prompt.name).toBe("Summarize");
    expect(prompt.body).toBe("Summarize {{text}}");
    expect(prompt.variables).toEqual(["text"]);
    expect(prompt.scope).toBe("workspace");
    expect(prompt.createdAt).toBe(ISO);
    expect(prompt.updatedAt).toBe(ISO);
  });

  it("respects an explicit id and normalizes tags", () => {
    const next = createPrompt(createPromptLibrary(), {
      id: "custom",
      name: "X",
      body: "{{a}}",
      scope: "personal",
      tags: [" one ", "", "one", "Two"],
      now: ISO,
    });
    expect(next.prompts[0].id).toBe("custom");
    expect(next.prompts[0].tags).toEqual(["one", "Two"]);
  });

  it("derives a unique id when a name is reused", () => {
    let state = createPrompt(createPromptLibrary(), {
      name: "Summarize",
      body: "{{text}}",
      scope: "workspace",
      now: ISO,
    });
    state = createPrompt(state, {
      name: "Summarize",
      body: "{{text}}",
      scope: "workspace",
      now: ISO,
    });
    expect(state.prompts.map((prompt) => prompt.id)).toEqual(["summarize", "summarize-2"]);
  });

  it("is a no-op for a blank name or body, returning the same state", () => {
    const empty = createPromptLibrary();
    expect(createPrompt(empty, { name: "", body: "x", scope: "personal" })).toBe(empty);
    expect(createPrompt(empty, { name: "x", body: "   ", scope: "personal" })).toBe(empty);
  });

  it("updates a template without mutating the state and bumps updatedAt", () => {
    const base = createPrompt(createPromptLibrary(), {
      id: "p1",
      name: "Summarize",
      body: "Summarize {{text}}",
      scope: "workspace",
      now: ISO,
    });
    const next = updatePrompt(base, "p1", {
      body: "Summarize {{text}} in {{tone}}",
      now: ISO2,
    });
    expect(base.prompts[0].variables).toEqual(["text"]);
    const prompt = next.prompts[0];
    expect(prompt.id).toBe("p1");
    expect(prompt.createdAt).toBe(ISO);
    expect(prompt.updatedAt).toBe(ISO2);
    expect(prompt.variables).toEqual(["text", "tone"]);
    expect(next).not.toBe(base);
  });

  it("updates name, scope and tags independently", () => {
    const base = createPrompt(createPromptLibrary(), {
      id: "p1",
      name: "Summarize",
      body: "Summarize {{text}}",
      scope: "workspace",
      now: ISO,
    });
    const next = updatePrompt(base, "p1", {
      name: " Recap ",
      tags: ["x"],
      scope: "personal",
      now: ISO2,
    });
    const prompt = next.prompts[0];
    expect(prompt.name).toBe("Recap");
    expect(prompt.tags).toEqual(["x"]);
    expect(prompt.scope).toBe("personal");
    expect(prompt.body).toBe("Summarize {{text}}");
  });

  it("ignores an update to an unknown id", () => {
    const base = createPrompt(createPromptLibrary(), {
      id: "p1",
      name: "Summarize",
      body: "{{text}}",
      scope: "workspace",
      now: ISO,
    });
    expect(updatePrompt(base, "nope", { name: "x" })).toBe(base);
  });

  it("deletes a template without mutating the state", () => {
    const base = createPrompt(createPromptLibrary(), {
      id: "p1",
      name: "Summarize",
      body: "{{text}}",
      scope: "workspace",
      now: ISO,
    });
    const next = deletePrompt(base, "p1");
    expect(next.prompts).toHaveLength(0);
    expect(base.prompts).toHaveLength(1);
    expect(next).not.toBe(base);
    expect(deletePrompt(base, "nope")).toBe(base);
  });
});

describe("listPrompts", () => {
  it("ranks an exact name above prefix, substring, tag and body hits", () => {
    const state = createPromptLibrary([
      tpl({ id: "body", name: "Recap", body: "produce a summary", variables: [], updatedAt: ISO }),
      tpl({ id: "tag", name: "Digest", body: "collect items", variables: [], tags: ["summary"], updatedAt: ISO }),
      tpl({ id: "sub", name: "weekly summary", body: "x", variables: [], updatedAt: ISO }),
      tpl({ id: "prefix", name: "summary report", body: "x", variables: [], updatedAt: ISO }),
      tpl({ id: "exact", name: "summary", body: "x", variables: [], updatedAt: ISO }),
    ]);
    expect(listPrompts(state, { query: "summary" }).map((prompt) => prompt.id)).toEqual([
      "exact",
      "prefix",
      "sub",
      "tag",
      "body",
    ]);
  });

  it("excludes templates the query does not match", () => {
    const state = createPromptLibrary([tpl({ id: "a", name: "Notes", body: "plain" })]);
    expect(listPrompts(state, { query: "zzz" })).toEqual([]);
  });

  it("filters by scope", () => {
    const state = createPromptLibrary([
      tpl({ id: "p", scope: "personal", name: "P" }),
      tpl({ id: "w", scope: "workspace", name: "W" }),
    ]);
    expect(listPrompts(state, { scope: "workspace" }).map((prompt) => prompt.id)).toEqual(["w"]);
  });

  it("filters by tag case-insensitively", () => {
    const state = createPromptLibrary([
      tpl({ id: "a", name: "A", tags: ["Meeting"] }),
      tpl({ id: "b", name: "B" }),
    ]);
    expect(listPrompts(state, { tag: "meeting" }).map((prompt) => prompt.id)).toEqual(["a"]);
  });

  it("orders an unfiltered list by most recently updated", () => {
    const state = createPromptLibrary([
      tpl({ id: "old", name: "Alpha", updatedAt: "2026-01-01T00:00:00.000Z" }),
      tpl({ id: "new", name: "Beta", updatedAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(listPrompts(state).map((prompt) => prompt.id)).toEqual(["new", "old"]);
  });

  it("combines a scope filter with a query", () => {
    const state = createPromptLibrary([
      tpl({ id: "wp", scope: "workspace", name: "summarize weekly" }),
      tpl({ id: "pp", scope: "personal", name: "summarize daily" }),
    ]);
    expect(
      listPrompts(state, { scope: "workspace", query: "summarize" }).map((prompt) => prompt.id),
    ).toEqual(["wp"]);
  });

  it("returns an empty list for an empty library", () => {
    expect(listPrompts(createPromptLibrary())).toEqual([]);
  });
});

describe("clonePrompt", () => {
  it("copies content under a new id and scope", () => {
    const source = tpl({ tags: ["meeting"], variables: ["text"] });
    const clone = clonePrompt(source, { newId: "c1", scope: "personal", now: ISO2 });
    expect(clone.id).toBe("c1");
    expect(clone.scope).toBe("personal");
    expect(clone.name).toBe("Summarize (copy)");
    expect(clone.body).toBe(source.body);
    expect(clone.variables).toEqual(source.variables);
    expect(clone.tags).toEqual(source.tags);
    expect(clone.createdAt).toBe(ISO2);
    expect(clone.updatedAt).toBe(ISO2);
  });

  it("defaults the id and name and never mutates the source", () => {
    const source = tpl();
    const clone = clonePrompt(source);
    expect(clone.id).toBe("t1-copy");
    expect(clone.name).toBe("Summarize (copy)");
    expect(clone.scope).toBe(source.scope);
    expect(source.id).toBe("t1");
    expect(source.name).toBe("Summarize");
  });

  it("deep-copies the mutable arrays", () => {
    const source = tpl({ tags: ["a"], variables: ["text"] });
    const clone = clonePrompt(source, { newId: "c1" });
    expect(clone.variables).not.toBe(source.variables);
    expect(clone.tags).not.toBe(source.tags);
  });
});

describe("describePrompt", () => {
  it("names the template and its scope", () => {
    expect(describePrompt(tpl({ name: "Summarize", scope: "workspace", variables: [] }))).toBe(
      '"Summarize" (workspace) — no variables',
    );
  });

  it("lists tags and variables", () => {
    const text = describePrompt(
      tpl({ name: "Notes", scope: "personal", tags: ["meeting", "weekly"], variables: ["text", "tone"] }),
    );
    expect(text).toBe('"Notes" (personal) [meeting, weekly] — variables: text, tone');
  });
});

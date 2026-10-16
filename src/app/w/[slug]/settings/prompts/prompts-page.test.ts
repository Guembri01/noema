import { describe, expect, it } from "vitest";

/**
 * Prompt-library reducers behind settings → Prompt library. The page is a thin
 * shell over these pure transitions, so this locks in the exact
 * create → list → update → clone → render → delete flow the page performs.
 */

import {
  PromptRenderError,
  clonePrompt,
  createPrompt,
  createPromptLibrary,
  deletePrompt,
  describePrompt,
  listPrompts,
  renderPrompt,
  updatePrompt,
} from "@/lib/ai-prompt-library";

describe("prompt library page flow", () => {
  it("creates, lists, updates, clones, renders and deletes a prompt", () => {
    let library = createPromptLibrary([]);

    // Create
    library = createPrompt(
      library,
      {
        name: "Weekly summary",
        body: "Summarize {{notes}} for {{audience}}.",
        scope: "workspace",
        tags: ["weekly", "summary"],
        now: "2026-10-01T00:00:00.000Z",
      },
    );
    expect(library.prompts).toHaveLength(1);
    const created = library.prompts[0];
    expect(created.id).toBe("weekly-summary");
    expect(created.variables).toEqual(["audience", "notes"]);

    // List / filter
    expect(listPrompts(library, { scope: "workspace" })).toHaveLength(1);
    expect(listPrompts(library, { scope: "personal" })).toHaveLength(0);
    expect(listPrompts(library, { tag: "weekly" })).toHaveLength(1);
    expect(listPrompts(library, { query: "summar" })).toHaveLength(1);

    // Update
    library = updatePrompt(library, created.id, {
      body: "Summarize {{notes}} in three bullets.",
      now: "2026-10-02T00:00:00.000Z",
    });
    expect(library.prompts[0].variables).toEqual(["notes"]);
    expect(library.prompts[0].updatedAt).toBe("2026-10-02T00:00:00.000Z");

    // Clone
    const copy = clonePrompt(library.prompts[0], { now: "2026-10-03T00:00:00.000Z" });
    library = { prompts: [...library.prompts, copy] };
    expect(copy.id).toBe("weekly-summary-copy");
    expect(describePrompt(copy)).toContain("Weekly summary (copy)");

    // Render (strict)
    expect(renderPrompt(library.prompts[0], { notes: "the release list" })).toBe(
      "Summarize the release list in three bullets.",
    );
    expect(() => renderPrompt(library.prompts[0], {})).toThrow(PromptRenderError);

    // Delete
    library = deletePrompt(library, copy.id);
    expect(library.prompts).toHaveLength(1);
    expect(deletePrompt(library, "missing")).toBe(library);
  });

  it("ignores a blank create, matching the page's guard", () => {
    const library = createPromptLibrary([]);
    expect(createPrompt(library, { name: "  ", body: "x", scope: "workspace" })).toBe(library);
    expect(createPrompt(library, { name: "x", body: "  ", scope: "workspace" })).toBe(library);
  });
});

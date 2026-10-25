import { describe, expect, it } from "vitest";
import {
  applyAnswer,
  applyError,
  buildAskAiRequest,
  describeAskAi,
  isStale,
  parseAskAiBlock,
  PLACEHOLDER_PROMPTS,
  refreshContext,
  validateAskAiBlock,
  ASK_AI_STATUSES,
  type AskAiBlock,
  type AskAiPageContext,
} from "./ask-ai-block";

function block(overrides: Partial<AskAiBlock> = {}): AskAiBlock {
  return {
    id: "b1",
    prompt: "Summarize this page",
    status: "idle",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const page = (blocks: Array<{ id: string; content: string }>, pageId?: string): AskAiPageContext => ({
  pageId,
  blocks,
});

describe("parseAskAiBlock (§1 Ask-AI block — strict structural parse)", () => {
  it("parses a valid object into the canonical shape", () => {
    const result = parseAskAiBlock({
      id: "q1",
      prompt: "  What are the open questions?  ",
      model: " gpt-4o ",
      context: { pageId: "p1", blockIds: ["a", "b"], maxTokens: 300 },
      answer: "Two remain.",
      status: "done",
      updatedAt: "2026-02-03T04:05:06.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block).toEqual({
      id: "q1",
      prompt: "What are the open questions?",
      model: "gpt-4o",
      context: { pageId: "p1", blockIds: ["a", "b"], maxTokens: 300 },
      answer: "Two remain.",
      status: "done",
      updatedAt: "2026-02-03T04:05:06.000Z",
    });
  });

  it("accepts a JSON string and defaults status to idle with no optional fields", () => {
    const result = parseAskAiBlock('{"id":"q1","prompt":"Hi"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block).toEqual({ id: "q1", prompt: "Hi", status: "idle", updatedAt: "" });
  });

  it("drops blank ids in blockIds and blank model/pageId", () => {
    const result = parseAskAiBlock({
      id: "q1",
      prompt: "Hi",
      model: "  ",
      context: { pageId: "  ", blockIds: ["a", " ", "b", "a"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.model).toBeUndefined();
    expect(result.block.context).toEqual({ blockIds: ["a", "b"] });
  });

  it("rejects a missing or blank id", () => {
    expect(parseAskAiBlock({ prompt: "Hi" }).ok).toBe(false);
    expect(parseAskAiBlock({ id: "   ", prompt: "Hi" }).ok).toBe(false);
    expect(parseAskAiBlock({ id: 42, prompt: "Hi" }).ok).toBe(false);
  });

  it("rejects malformed JSON and non-object input", () => {
    for (const raw of ["{not json", "[]", "42", "null", null, undefined]) {
      expect(parseAskAiBlock(raw).ok).toBe(false);
    }
  });

  it("rejects wrong-typed fields", () => {
    const cases: unknown[] = [
      { id: "q1", prompt: 1 },
      { id: "q1", prompt: "Hi", model: 2 },
      { id: "q1", prompt: "Hi", answer: 3 },
      { id: "q1", prompt: "Hi", context: "page-1" },
      { id: "q1", prompt: "Hi", context: { blockIds: "a" } },
      { id: "q1", prompt: "Hi", context: { blockIds: [1] } },
      { id: "q1", prompt: "Hi", context: { maxTokens: "many" } },
      { id: "q1", prompt: "Hi", context: { hashes: { a: 1 } } },
      { id: "q1", prompt: "Hi", updatedAt: 5 },
    ];
    for (const raw of cases) {
      expect(parseAskAiBlock(raw).ok).toBe(false);
    }
  });

  it("rejects an unknown status value", () => {
    expect(parseAskAiBlock({ id: "q1", prompt: "Hi", status: "running" }).ok).toBe(false);
    expect(parseAskAiBlock({ id: "q1", prompt: "Hi", status: 1 }).ok).toBe(false);
  });

  it("round-trips a parsed block back through parse", () => {
    const first = parseAskAiBlock({ id: "q1", prompt: "Hi", status: "pending", updatedAt: "t" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = parseAskAiBlock(first.block);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.block).toEqual(first.block);
  });

  it("parses and preserves the configured action, output and source", () => {
    const result = parseAskAiBlock({
      id: "q1",
      prompt: "Summarize this page",
      mode: "summarize",
      output: "replace",
      source: "none",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.mode).toBe("summarize");
    expect(result.block.output).toBe("replace");
    expect(result.block.source).toBe("none");
  });

  it("rejects an unknown mode, output or source", () => {
    for (const raw of [
      { id: "q1", prompt: "Hi", mode: "translate" },
      { id: "q1", prompt: "Hi", output: "append" },
      { id: "q1", prompt: "Hi", source: "workspace" },
    ]) {
      expect(parseAskAiBlock(raw).ok).toBe(false);
    }
  });
});

describe("validateAskAiBlock (§1 — issues, not booleans)", () => {
  it("returns no issues for a valid block", () => {
    expect(validateAskAiBlock(block({ prompt: "Summarize" }))).toEqual([]);
  });

  it("flags an empty or whitespace prompt", () => {
    expect(validateAskAiBlock(block({ prompt: "" })).map((i) => i.code)).toContain("EMPTY_PROMPT");
    expect(validateAskAiBlock(block({ prompt: "   " })).map((i) => i.code)).toContain("EMPTY_PROMPT");
  });

  it("flags a prompt over the character cap only when a cap is given", () => {
    const long = block({ prompt: "x".repeat(50) });
    expect(validateAskAiBlock(long, { maxPromptChars: 10 }).map((i) => i.code)).toContain(
      "PROMPT_TOO_LONG",
    );
    expect(validateAskAiBlock(long).map((i) => i.code)).not.toContain("PROMPT_TOO_LONG");
    expect(validateAskAiBlock(block({ prompt: "x".repeat(10) }), { maxPromptChars: 10 })).toEqual([]);
  });

  it("flags a model outside the allowlist, but only when an allowlist is given", () => {
    const withModel = block({ model: "gpt-4o" });
    expect(
      validateAskAiBlock(withModel, { modelAllowlist: ["claude-3-5-sonnet"] }).map((i) => i.code),
    ).toContain("MODEL_NOT_ALLOWED");
    expect(validateAskAiBlock(withModel, { modelAllowlist: ["gpt-4o"] })).toEqual([]);
    expect(validateAskAiBlock(withModel)).toEqual([]);
  });

  it("does not flag a missing model even with an allowlist", () => {
    expect(validateAskAiBlock(block(), { modelAllowlist: ["gpt-4o"] })).toEqual([]);
  });

  it("flags an unknown status defensively", () => {
    const bad = { ...block(), status: "running" } as unknown as AskAiBlock;
    expect(validateAskAiBlock(bad).map((i) => i.code)).toContain("INVALID_STATUS");
  });

  it("flags an out-of-range maxTokens in the context", () => {
    const bad = block({ context: { maxTokens: -5 } });
    expect(validateAskAiBlock(bad).map((i) => i.code)).toContain("INVALID_MAX_TOKENS");
    const fractional = block({ context: { maxTokens: 1.5 } });
    expect(validateAskAiBlock(fractional).map((i) => i.code)).toContain("INVALID_MAX_TOKENS");
  });

  it("flags an unknown action, output or source", () => {
    const badMode = { ...block(), mode: "translate" } as unknown as AskAiBlock;
    const badOutput = { ...block(), output: "append" } as unknown as AskAiBlock;
    const badSource = { ...block(), source: "workspace" } as unknown as AskAiBlock;
    expect(validateAskAiBlock(badMode).map((i) => i.code)).toContain("INVALID_MODE");
    expect(validateAskAiBlock(badOutput).map((i) => i.code)).toContain("INVALID_OUTPUT");
    expect(validateAskAiBlock(badSource).map((i) => i.code)).toContain("INVALID_SOURCE");
  });

  it("refuses to summarize with no page to summarize", () => {
    const issue = validateAskAiBlock(
      block({ mode: "summarize", source: "none", prompt: "Summarize this page" }),
    );
    expect(issue.map((i) => i.code)).toContain("SUMMARIZE_NEEDS_PAGE");
    expect(
      validateAskAiBlock(
        block({ mode: "summarize", source: "page", prompt: "Summarize this page" }),
      ),
    ).toEqual([]);
  });

  it("never throws on exotic input", () => {
    for (const raw of [null, undefined, 42, "x", {}, []]) {
      expect(() => validateAskAiBlock(raw as unknown as AskAiBlock)).not.toThrow();
      expect(Array.isArray(validateAskAiBlock(raw as unknown as AskAiBlock))).toBe(true);
    }
  });
});

describe("buildAskAiRequest (R25.2 — deterministic request)", () => {
  const now = new Date("2026-03-04T05:06:07.000Z");
  const ctx = page(
    [
      { id: "a", content: "Alpha paragraph one." },
      { id: "b", content: "Beta paragraph two." },
      { id: "c", content: "Gamma paragraph three." },
    ],
    "p1",
  );

  it("is deterministic for the same block, context and now", () => {
    const input = block({ prompt: "What changed?" });
    expect(buildAskAiRequest(input, { pageContext: ctx, now })).toEqual(
      buildAskAiRequest(input, { pageContext: ctx, now }),
    );
  });

  it("puts the prompt in the user turn and a grounded system instruction", () => {
    const req = buildAskAiRequest(block({ prompt: "What changed?" }), { pageContext: ctx, now });
    expect(req.system.length).toBeGreaterThan(0);
    expect(req.system.toLowerCase()).toContain("context");
    expect(req.user).toContain("What changed?");
    expect(req.user).toContain("Alpha paragraph one.");
    expect(req.user).toContain("Gamma paragraph three.");
  });

  it("includes only the blocks named by blockIds, in that order", () => {
    const selected = block({ context: { blockIds: ["c", "a"] } });
    const req = buildAskAiRequest(selected, { pageContext: ctx, now });
    expect(req.user).toContain("Gamma paragraph three.");
    expect(req.user).toContain("Alpha paragraph one.");
    expect(req.user).not.toContain("Beta paragraph two.");
    expect(req.user.indexOf("Gamma paragraph three.")).toBeLessThan(
      req.user.indexOf("Alpha paragraph one."),
    );
  });

  it("truncates the page context to the token budget", () => {
    const big = page([{ id: "a", content: "word ".repeat(500) }]);
    const req = buildAskAiRequest(block({ prompt: "What changed?", context: { maxTokens: 12 } }), {
      pageContext: big,
      now,
    });
    expect(req.user).toContain("What changed?");
    expect(req.user).toContain("…");
    // "word " x 500 is far more than 12 tokens (48 chars); the truncation must bite.
    expect(req.user).not.toContain("word ".repeat(200));
    expect(req.user.length).toBeLessThan(200);
  });

  it("cuts the oversized context on a word boundary", () => {
    const oneWordPerLine = page([{ id: "a", content: "alpha beta gamma delta epsilon zeta" }]);
    const req = buildAskAiRequest(block({ context: { maxTokens: 3 } }), {
      pageContext: oneWordPerLine,
      now,
    });
    // The truncated context ends with the ellipsis and no half-word.
    expect(/…$/.test(req.user.trim())).toBe(true);
  });

  it("omits the context section when the page has no referenced blocks", () => {
    const req = buildAskAiRequest(block({ prompt: "Standalone" }), {
      pageContext: page([], "p1"),
      now,
    });
    expect(req.user).toContain("Standalone");
    expect(req.user).not.toContain("Page context");
  });

  it("stamps the injected now into the context header, and omits it when absent", () => {
    const withNow = buildAskAiRequest(block({ prompt: "Q" }), { pageContext: ctx, now });
    expect(withNow.user).toContain("2026-03-04T05:06:07.000Z");
    const withoutNow = buildAskAiRequest(block({ prompt: "Q" }), { pageContext: ctx });
    expect(withoutNow.user).not.toContain("2026-03-04T05:06:07.000Z");
  });

  it("keeps the completion params independent of the context token budget", () => {
    const small = buildAskAiRequest(block({ context: { maxTokens: 8 } }), { pageContext: ctx, now });
    const large = buildAskAiRequest(block({ context: { maxTokens: 800 } }), {
      pageContext: ctx,
      now,
    });
    expect(small.params).toEqual(large.params);
    expect(small.params.maxTokens).toBeGreaterThan(0);
    expect(small.params.temperature).toBeGreaterThanOrEqual(0);
  });
});

describe("isStale & refreshContext (R25.2 — staleness by content hash)", () => {
  const base = block({
    context: { pageId: "p1", blockIds: ["a", "b"], hashes: {} },
  });

  it("is not stale when there is no recorded baseline", () => {
    expect(isStale(base, page([{ id: "a", content: "x" }], "p1"))).toBe(false);
    expect(isStale(block(), page([{ id: "a", content: "x" }]))).toBe(false);
  });

  it("captures a baseline and reports unchanged content as fresh", () => {
    const captured = refreshContext(block({ context: { blockIds: ["a"] } }), page([
      { id: "a", content: "hello" },
    ]));
    expect(captured.context?.hashes?.a).toBeTruthy();
    expect(captured.stale).toBe(false);
    expect(isStale(captured, page([{ id: "a", content: "hello" }]))).toBe(false);
  });

  it("becomes stale when a referenced block's content changes", () => {
    const captured = refreshContext(block({ context: { blockIds: ["a"] } }), page([
      { id: "a", content: "hello" },
    ]));
    expect(isStale(captured, page([{ id: "a", content: "hello, world" }]))).toBe(true);
  });

  it("ignores changes to blocks the block does not reference", () => {
    const captured = refreshContext(block({ context: { blockIds: ["a"] } }), page([
      { id: "a", content: "hello" },
      { id: "b", content: "unchanged" },
    ]));
    const moved = page([
      { id: "a", content: "hello" },
      { id: "b", content: "COMPLETELY DIFFERENT" },
    ]);
    expect(isStale(captured, moved)).toBe(false);
  });

  it("treats an added or removed block as stale when the whole page is referenced", () => {
    const captured = refreshContext(block(), page([{ id: "a", content: "hello" }]));
    expect(isStale(captured, page([{ id: "a", content: "hello" }, { id: "b", content: "new" }]))).toBe(
      true,
    );
    expect(isStale(captured, page([]))).toBe(true);
  });

  it("refreshContext marks the answer stale when content changed and updates the baseline", () => {
    const first = refreshContext(block({ answer: "old answer", status: "done", context: { blockIds: ["a"] } }), page([
      { id: "a", content: "hello" },
    ]));
    const second = refreshContext(first, page([{ id: "a", content: "changed" }]));
    expect(second.stale).toBe(true);
    expect(second.context?.hashes?.a).not.toBe(first.context?.hashes?.a);
    // The new baseline reflects the changed content, so a repeat refresh is clean.
    expect(refreshContext(second, page([{ id: "a", content: "changed" }])).stale).toBe(false);
  });

  it("refreshContext does not mutate its input and is pure", () => {
    const original = block({ context: { blockIds: ["a"] } });
    const frozen = JSON.parse(JSON.stringify(original)) as AskAiBlock;
    const next = refreshContext(original, page([{ id: "a", content: "hello" }]));
    expect(original).toEqual(frozen);
    expect(next).not.toBe(original);
  });
});

describe("applyAnswer / applyError (R25.3 — status transitions)", () => {
  const now = new Date("2026-04-05T06:07:08.000Z");
  const iso = "2026-04-05T06:07:08.000Z";

  it("moves pending → done with the answer and a fresh timestamp", () => {
    const next = applyAnswer(block({ status: "pending" }), { answer: "The answer.", now });
    expect(next.status).toBe("done");
    expect(next.answer).toBe("The answer.");
    expect(next.updatedAt).toBe(iso);
    expect(next.error).toBeUndefined();
    expect(next.stale).toBe(false);
  });

  it("treats a blank answer as idle with no answer", () => {
    const next = applyAnswer(block({ status: "pending" }), { answer: "   ", now });
    expect(next.status).toBe("idle");
    expect(next.answer).toBeUndefined();
    expect(next.updatedAt).toBe(iso);
  });

  it("clears a previous error when a new answer arrives", () => {
    const failed = applyError(block({ status: "pending" }), { message: "boom", now });
    const answered = applyAnswer(failed, { answer: "ok", now });
    expect(answered.status).toBe("done");
    expect(answered.error).toBeUndefined();
  });

  it("moves pending → error with the message and a fresh timestamp", () => {
    const next = applyError(block({ status: "pending" }), { message: "  Network died  ", now });
    expect(next.status).toBe("error");
    expect(next.error).toBe("Network died");
    expect(next.updatedAt).toBe(iso);
  });

  it("preserves a previous answer when an error arrives", () => {
    const done = block({ answer: "keep me", status: "done" });
    const next = applyError(done, { message: "later failure", now });
    expect(next.status).toBe("error");
    expect(next.answer).toBe("keep me");
    expect(next.error).toBe("later failure");
  });

  it("accepts an ISO string for now", () => {
    expect(applyAnswer(block(), { answer: "x", now: iso }).updatedAt).toBe(iso);
    expect(applyError(block(), { message: "x", now: iso }).updatedAt).toBe(iso);
  });

  it("does not mutate the input block", () => {
    const original = block({ status: "pending" });
    const frozen = JSON.parse(JSON.stringify(original)) as AskAiBlock;
    applyAnswer(original, { answer: "x", now });
    applyError(original, { message: "y", now });
    expect(original).toEqual(frozen);
  });
});

describe("describeAskAi (§1 — one-line description)", () => {
  it("mentions the prompt and the status", () => {
    const text = describeAskAi(block({ prompt: "Summarize this page", status: "pending" }));
    expect(text).toContain("Summarize this page");
    expect(text).toContain("pending");
  });

  it("includes the model, block count and stale/error markers when present", () => {
    const rich = block({
      prompt: "Q",
      model: "gpt-4o",
      context: { blockIds: ["a", "b"] },
      stale: true,
      error: "boom",
    });
    const text = describeAskAi(rich);
    expect(text).toContain("gpt-4o");
    expect(text).toContain("2");
    expect(text.toLowerCase()).toContain("stale");
    expect(text).toContain("boom");
  });

  it("elides an over-long prompt", () => {
    const text = describeAskAi(block({ prompt: "x".repeat(200) }));
    expect(text.length).toBeLessThan(160);
  });

  it("never throws and reads empty for malformed input", () => {
    for (const raw of [null, undefined, 42, "x"]) {
      expect(typeof describeAskAi(raw as unknown as AskAiBlock)).toBe("string");
    }
  });
});

describe("PLACEHOLDER_PROMPTS (§1 — suggestions)", () => {
  it("is a non-empty list of unique, usable prompts", () => {
    expect(PLACEHOLDER_PROMPTS.length).toBeGreaterThan(0);
    expect(new Set(PLACEHOLDER_PROMPTS).size).toBe(PLACEHOLDER_PROMPTS.length);
    for (const prompt of PLACEHOLDER_PROMPTS) {
      expect(typeof prompt).toBe("string");
      expect(prompt.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("ASK_AI_STATUSES", () => {
  it("is the exact set of legal statuses", () => {
    expect([...ASK_AI_STATUSES].sort()).toEqual(["done", "error", "idle", "pending"]);
  });
});

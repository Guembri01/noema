import { describe, expect, it } from "vitest";
import { hashContent, type AskAiBlock } from "@/lib/ask-ai-block";
import {
  ASK_AI_PROMPT_MAX_CHARS,
  ASK_AI_SUMMARIZE_PROMPT,
  askAiAnsweredAttrs,
  askAiAnswerContent,
  askAiAttrsFromBlock,
  askAiBlockFromAttrs,
  askAiFailedAttrs,
  askAiInsertionFor,
  askAiIsStale,
  askAiPageContext,
  planAskAiRequest,
} from "./ask-ai";

/*
 * The engine→renderer seam for the Ask-AI block. The node view is out of scope
 * (it needs a DOM); these tests pin the pure adapter: stored attrs → the block
 * engine (`buildAskAiRequest` / `refreshContext` / `applyAnswer` / `applyError` /
 * `validateAskAiBlock`) → the `/api/ai` body and the next set of attributes.
 */

const nodeAttrs = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "q1",
  prompt: "What changed?",
  mode: "ask",
  output: "answer",
  source: "page",
  answer: "",
  model: null,
  context: null,
  status: "idle",
  updatedAt: "",
  stale: false,
  error: "",
  ...overrides,
});

const pageContext = () =>
  askAiPageContext({
    pageId: "p1",
    blocks: [
      { id: "a", text: "Alpha one." },
      { id: "b", text: "Beta two." },
    ],
  });

describe("askAiBlockFromAttrs / askAiAttrsFromBlock (attrs ⇄ engine)", () => {
  it("reads a canonical block out of node attributes", () => {
    const block = askAiBlockFromAttrs(
      nodeAttrs({ model: "gpt-4o", context: { pageId: "p1", blockIds: ["a"] }, answer: "A", status: "done" }),
    );
    expect(block).toEqual({
      id: "q1",
      prompt: "What changed?",
      mode: "ask",
      output: "answer",
      source: "page",
      model: "gpt-4o",
      context: { pageId: "p1", blockIds: ["a"] },
      answer: "A",
      status: "done",
      updatedAt: "",
    });
  });

  it("round-trips through askAiAttrsFromBlock", () => {
    const block = askAiBlockFromAttrs(nodeAttrs({ status: "pending" }));
    const round = askAiBlockFromAttrs(askAiAttrsFromBlock(block));
    expect(round).toEqual(block);
  });

  it("mints an id when a node has never persisted one", () => {
    const block = askAiBlockFromAttrs(nodeAttrs({ id: null }));
    expect(block.id).not.toBe("");
  });
});

describe("planAskAiRequest (engine in → route body out)", () => {
  it("builds the /api/ai body from the deterministic request", () => {
    const block = askAiBlockFromAttrs(nodeAttrs());
    const plan = planAskAiRequest({
      block,
      pageContext: pageContext(),
      workspaceId: "ws1",
      now: new Date("2026-03-04T05:06:07.000Z"),
    });
    expect(plan.issues).toEqual([]);
    expect(plan.body.prompt).toBe("What changed?");
    expect(plan.body.workspaceId).toBe("ws1");
    expect(plan.body.mode).toBe("ask");
    expect(plan.body.maxTokens).toBe(plan.request.params.maxTokens);
    expect(plan.body.context).toContain("Alpha one.");
    expect(plan.body.context).toContain("Beta two.");
    // The user turn's "Question:" header is not duplicated into the context.
    expect(plan.body.context.startsWith("Question:")).toBe(false);
  });

  it("refreshes and persists the context hashes on the returned block", () => {
    const block = askAiBlockFromAttrs(nodeAttrs());
    const plan = planAskAiRequest({ block, pageContext: pageContext(), workspaceId: "ws1" });
    expect(plan.block.context?.hashes).toEqual({
      a: hashContent("Alpha one."),
      b: hashContent("Beta two."),
    });
  });

  it("flags an empty prompt via validateAskAiBlock", () => {
    const plan = planAskAiRequest({
      block: askAiBlockFromAttrs(nodeAttrs({ prompt: "   " })),
      pageContext: pageContext(),
      workspaceId: "ws1",
    });
    expect(plan.issues.map((issue) => issue.code)).toContain("EMPTY_PROMPT");
  });

  it("flags a prompt over the editor cap", () => {
    const plan = planAskAiRequest({
      block: askAiBlockFromAttrs(nodeAttrs({ prompt: "x".repeat(ASK_AI_PROMPT_MAX_CHARS + 1) })),
      pageContext: pageContext(),
      workspaceId: "ws1",
    });
    expect(plan.issues.map((issue) => issue.code)).toContain("PROMPT_TOO_LONG");
  });

  it("reports staleness from the previous baseline before refreshing", () => {
    const withBaseline = askAiBlockFromAttrs(
      nodeAttrs({
        answer: "old",
        status: "done",
        context: { blockIds: ["a"], hashes: { a: hashContent("Alpha CHANGED.") } },
      }),
    );
    const plan = planAskAiRequest({ block: withBaseline, pageContext: pageContext(), workspaceId: "ws1" });
    expect(plan.stale).toBe(true);
    expect(plan.block.stale).toBe(true);
    expect(askAiIsStale(plan.block, pageContext())).toBe(false);
  });

  it("is deterministic for the same inputs and injected now", () => {
    const now = new Date("2026-03-04T05:06:07.000Z");
    const run = () =>
      planAskAiRequest({
        block: askAiBlockFromAttrs(nodeAttrs()),
        pageContext: pageContext(),
        workspaceId: "ws1",
        now,
      });
    expect(run().request).toEqual(run().request);
  });

  it("uses the summarize prompt when a summarize request has none", () => {
    const plan = planAskAiRequest({
      block: askAiBlockFromAttrs(nodeAttrs({ prompt: ASK_AI_SUMMARIZE_PROMPT })),
      pageContext: pageContext(),
      workspaceId: "ws1",
      mode: "summarize",
    });
    expect(plan.body.mode).toBe("summarize");
  });
});

describe("askAiAnsweredAttrs / askAiFailedAttrs (applyAnswer / applyError)", () => {
  const base = askAiBlockFromAttrs(nodeAttrs({ status: "pending" })) as AskAiBlock;

  it("folds a successful answer into attributes", () => {
    const attrs = askAiAnsweredAttrs(base, "The answer.", new Date("2026-04-05T06:07:08.000Z"));
    expect(attrs.status).toBe("done");
    expect(attrs.answer).toBe("The answer.");
    expect(attrs.updatedAt).toBe("2026-04-05T06:07:08.000Z");
    expect(attrs.error).toBe("");
    expect(attrs.stale).toBe(false);
  });

  it("folds a failure into attributes", () => {
    const attrs = askAiFailedAttrs(base, "  Network died  ", "2026-04-05T06:07:08.000Z");
    expect(attrs.status).toBe("error");
    expect(attrs.error).toBe("Network died");
    expect(attrs.updatedAt).toBe("2026-04-05T06:07:08.000Z");
  });

  it("treats a blank answer as idle via applyAnswer", () => {
    const attrs = askAiAnsweredAttrs(base, "   ");
    expect(attrs.status).toBe("idle");
    expect(attrs.answer).toBe("");
  });
});

describe("persisted action, output and source", () => {
  it("round-trips the configured action through the node attributes", () => {
    const attrs = nodeAttrs({ mode: "summarize", output: "replace", source: "none" });
    const block = askAiBlockFromAttrs(attrs);
    expect(block.mode).toBe("summarize");
    expect(block.output).toBe("replace");
    expect(block.source).toBe("none");
    const round = askAiAttrsFromBlock(block);
    expect(round.mode).toBe("summarize");
    expect(round.output).toBe("replace");
    expect(round.source).toBe("none");
  });

  it("defaults a legacy node (no action attrs) to ask / answer / page", () => {
    const block = askAiBlockFromAttrs({
      id: "legacy",
      prompt: "What changed?",
      status: "idle",
    });
    expect(block.mode).toBe("ask");
    expect(block.output).toBe("answer");
    expect(block.source).toBe("page");
  });

  it("uses the stored mode without an explicit run argument", () => {
    const plan = planAskAiRequest({
      block: askAiBlockFromAttrs(
        nodeAttrs({ prompt: ASK_AI_SUMMARIZE_PROMPT, mode: "summarize" }),
      ),
      pageContext: pageContext(),
      workspaceId: "ws1",
    });
    expect(plan.body.mode).toBe("summarize");
    expect(plan.issues).toEqual([]);
  });

  it("fills the summarize prompt when the stored prompt is blank", () => {
    const plan = planAskAiRequest({
      block: askAiBlockFromAttrs(nodeAttrs({ prompt: "   ", mode: "summarize" })),
      pageContext: pageContext(),
      workspaceId: "ws1",
    });
    expect(plan.body.prompt).toBe(ASK_AI_SUMMARIZE_PROMPT);
    expect(plan.issues).toEqual([]);
  });

  it("sends the pageId from the editor, never from block attributes", () => {
    const plan = planAskAiRequest({
      block: askAiBlockFromAttrs(nodeAttrs()),
      pageContext: pageContext(),
      workspaceId: "ws1",
      pageId: "p1",
    });
    expect(plan.body.pageId).toBe("p1");
    const withoutPage = planAskAiRequest({
      block: askAiBlockFromAttrs(nodeAttrs()),
      pageContext: pageContext(),
      workspaceId: "ws1",
    });
    expect(withoutPage.body.pageId).toBeUndefined();
  });

  it("ignores workspaceId/pageId smuggled into the block's stored attrs", () => {
    const block = askAiBlockFromAttrs({
      ...nodeAttrs(),
      workspaceId: "foreign-workspace",
      pageId: "foreign-page",
    });
    expect(block).not.toHaveProperty("workspaceId");
    expect(block).not.toHaveProperty("pageId");
    const plan = planAskAiRequest({
      block,
      pageContext: pageContext(),
      workspaceId: "ws1",
      pageId: "p1",
    });
    expect(plan.body.workspaceId).toBe("ws1");
    expect(plan.body.pageId).toBe("p1");
  });

  it("sends no context when the author turned page grounding off", () => {
    const plan = planAskAiRequest({
      block: askAiBlockFromAttrs(nodeAttrs({ source: "none" })),
      pageContext: pageContext(),
      workspaceId: "ws1",
      pageId: "p1",
    });
    expect(plan.body.context).toBe("");
    expect(plan.body.prompt).toBe("What changed?");
  });
});

describe("askAiInsertionFor / askAiAnswerContent (output insertion)", () => {
  it("keeps the answer in the card for output=answer", () => {
    expect(askAiInsertionFor(10, 5, "answer")).toBeNull();
  });

  it("inserts below the block for output=insert", () => {
    expect(askAiInsertionFor(10, 5, "insert")).toEqual({ from: 15 });
  });

  it("replaces the block for output=replace", () => {
    expect(askAiInsertionFor(10, 5, "replace")).toEqual({ from: 10, to: 15 });
  });

  it("never inserts into a detached or malformed position", () => {
    expect(askAiInsertionFor(undefined, 5, "insert")).toBeNull();
    expect(askAiInsertionFor(Number.NaN, 5, "insert")).toBeNull();
    expect(askAiInsertionFor(-1, 5, "insert")).toBeNull();
    expect(askAiInsertionFor(10, 0, "replace")).toBeNull();
  });

  it("turns a plain answer into paragraphs and Markdown into real blocks", () => {
    const plain = askAiAnswerContent("First line\nSecond line");
    expect(plain).toHaveLength(2);
    expect(plain[0]).toMatchObject({ type: "paragraph" });
    const markdown = askAiAnswerContent("## Heading\n\n- one\n- two");
    expect(markdown.some((node) => node.type === "heading")).toBe(true);
    expect(askAiAnswerContent("   ")).toEqual([]);
  });
});

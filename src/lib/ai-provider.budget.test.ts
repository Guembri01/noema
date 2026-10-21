import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI cost enforcement in `@/lib/ai-provider` (docs/specs/ai-surface.md §14).
 *
 * `chatComplete` must consult `checkBudget` before the call and `recordUsage`
 * afterwards so the token ceiling is real — and so must `chatCompleteStream`:
 * the streaming transport is the path the chat panel uses *first*, so a gate
 * that only the single-shot transport carried would not hold on the ordinary
 * one. The database is mocked and `fetch` is stubbed; the budget engine and
 * the provider's own gating run for real.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  AI_BUDGET_EXCEEDED,
  aiBudgetLimitTokens,
  budgetPeriod,
  chatComplete,
  chatCompleteStream,
  providerClass,
  ProviderClassError,
  resetAiBudgetLedger,
} from "@/lib/ai-provider";

const CONFIG = {
  provider: "mock",
  baseUrl: "http://localhost:1/v1",
  model: "gpt-4o",
  apiKey: "k",
  source: "workspace" as const,
  workspaceId: "ws-1",
};

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A streamed answer: the frames, then the usage frame, then the sentinel. */
function streamResponse(
  frames: unknown[],
  usage?: { prompt_tokens: number; completion_tokens: number },
): Response {
  const lines = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  if (usage) lines.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  lines.push("data: [DONE]\n\n");
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** The text a stream carried. */
async function drain(stream: AsyncGenerator<string, void, unknown>): Promise<string> {
  let text = "";
  for await (const delta of stream) text += delta;
  return text;
}

/** One delta frame with the given content. */
function delta(content: string): unknown {
  return { choices: [{ delta: { content } }] };
}

beforeEach(() => {
  delete process.env.AI_BUDGET_TOKENS;
  resetAiBudgetLedger();
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete process.env.AI_BUDGET_TOKENS;
  resetAiBudgetLedger();
  vi.unstubAllGlobals();
});

describe("budget configuration", () => {
  it("reads the monthly ceiling from AI_BUDGET_TOKENS", () => {
    expect(aiBudgetLimitTokens()).toBe(0);
    process.env.AI_BUDGET_TOKENS = "1000";
    expect(aiBudgetLimitTokens()).toBe(1000);
    process.env.AI_BUDGET_TOKENS = "-5";
    expect(aiBudgetLimitTokens()).toBe(0);
    process.env.AI_BUDGET_TOKENS = "many";
    expect(aiBudgetLimitTokens()).toBe(0);
  });

  it("derives the period as a UTC calendar month", () => {
    expect(budgetPeriod(new Date("2026-10-15T23:59:00Z"))).toBe("2026-10");
    expect(budgetPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

describe("chatComplete budget enforcement", () => {
  it("does not gate calls when no budget is configured", async () => {
    const fetchMock = vi.fn(async () => respond({ choices: [{ message: { content: "hi" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await chatComplete({ system: "s", user: "u" }, CONFIG);
    const second = await chatComplete({ system: "s", user: "u" }, CONFIG);

    expect(first).toEqual({ ok: true, text: "hi" });
    expect(second).toEqual({ ok: true, text: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records usage and refuses the next call once the ceiling is reached", async () => {
    process.env.AI_BUDGET_TOKENS = "100";
    const fetchMock = vi.fn(async () =>
      respond({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 80, completion_tokens: 20 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await chatComplete({ system: "s", user: "u", maxTokens: 10 }, CONFIG);
    expect(first.ok).toBe(true);

    const second = await chatComplete({ system: "s", user: "u", maxTokens: 10 }, CONFIG);
    expect(second).toEqual({ ok: false, status: 429, error: AI_BUDGET_EXCEEDED });
    // The refused call never reached the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("meters with the chars/4 estimate when the provider reports no usage", async () => {
    process.env.AI_BUDGET_TOKENS = "30";
    const fetchMock = vi.fn(async () =>
      respond({ choices: [{ message: { content: "x".repeat(400) } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Prompt "s\nu" ≈ 1 token; output 400 chars ≈ 100 tokens → over the 30 cap.
    const first = await chatComplete({ system: "s", user: "u", maxTokens: 1 }, CONFIG);
    expect(first.ok).toBe(true);

    const second = await chatComplete({ system: "s", user: "u", maxTokens: 1 }, CONFIG);
    expect(second.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps separate ledgers per workspace", async () => {
    process.env.AI_BUDGET_TOKENS = "100";
    const fetchMock = vi.fn(async () =>
      respond({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 100, completion_tokens: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect((await chatComplete({ system: "s", user: "u" }, CONFIG)).ok).toBe(true);
    const other = { ...CONFIG, workspaceId: "ws-2" };
    expect((await chatComplete({ system: "s", user: "u" }, other)).ok).toBe(true);
  });
});

describe("chatCompleteStream budget enforcement", () => {
  it("does not gate the stream when no budget is configured", async () => {
    const fetchMock = vi.fn(async () => streamResponse([delta("hi")]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await drain(chatCompleteStream({ system: "s", user: "u" }, CONFIG))).toBe("hi");
    expect(await drain(chatCompleteStream({ system: "s", user: "u" }, CONFIG))).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses the stream before the request once the ceiling is reached", async () => {
    process.env.AI_BUDGET_TOKENS = "100";
    const fetchMock = vi.fn(async () =>
      streamResponse([delta("hi")], { prompt_tokens: 80, completion_tokens: 20 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await drain(chatCompleteStream({ system: "s", user: "u", maxTokens: 10 }, CONFIG)),
    ).toBe("hi");

    await expect(
      drain(chatCompleteStream({ system: "s", user: "u", maxTokens: 10 }, CONFIG)),
    ).rejects.toThrow(AI_BUDGET_EXCEEDED);
    // The refused stream never reached the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the refusal as a class, so the stream's in-band failure shows it", async () => {
    // The stream route reduces a failure to a class and writes it in-band; a
    // refusal that is not a class would travel as a transport error instead.
    process.env.AI_BUDGET_TOKENS = "1";
    const fetchMock = vi.fn(async () => streamResponse([delta("hi")]));
    vi.stubGlobal("fetch", fetchMock);

    const error = await drain(
      chatCompleteStream({ system: "s", user: "u", maxTokens: 5 }, CONFIG),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderClassError);
    expect(providerClass(error)).toBe(AI_BUDGET_EXCEEDED);
    // The provider was never asked.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the provider for the usage of the stream", async () => {
    // The provider reports the usage of a streamed call in a final frame —
    // but only when it is asked for it.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => streamResponse([delta("hi")]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await drain(chatCompleteStream({ system: "s", user: "u" }, CONFIG));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      stream?: boolean;
      stream_options?: unknown;
    };
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("meters the stream with the usage the provider reported", async () => {
    process.env.AI_BUDGET_TOKENS = "100";
    const fetchMock = vi.fn(async () =>
      streamResponse([delta("hi")], { prompt_tokens: 80, completion_tokens: 20 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await drain(chatCompleteStream({ system: "s", user: "u", maxTokens: 10 }, CONFIG)),
    ).toBe("hi");

    // The stream's usage lands in the ledger the single-shot transport reads:
    // the reported 100 tokens are booked, so the next call is refused.
    const next = await chatComplete({ system: "s", user: "u", maxTokens: 10 }, CONFIG);
    expect(next).toEqual({ ok: false, status: 429, error: AI_BUDGET_EXCEEDED });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("meters the stream with the chars/4 estimate when the provider reports no usage", async () => {
    process.env.AI_BUDGET_TOKENS = "30";
    const fetchMock = vi.fn(async () => streamResponse([delta("x".repeat(400))]));
    vi.stubGlobal("fetch", fetchMock);

    // Prompt "s\nu" ≈ 1 token; output 400 chars ≈ 100 tokens → over the 30 cap.
    expect(
      await drain(chatCompleteStream({ system: "s", user: "u", maxTokens: 1 }, CONFIG)),
    ).toHaveLength(400);

    await expect(
      drain(chatCompleteStream({ system: "s", user: "u", maxTokens: 1 }, CONFIG)),
    ).rejects.toThrow(AI_BUDGET_EXCEEDED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI cost enforcement in `@/lib/ai-provider` (docs/specs/ai-surface.md §14).
 *
 * `chatComplete` must consult `checkBudget` before the call and `recordUsage`
 * afterwards so the token ceiling is real. The database is mocked and `fetch`
 * is stubbed; the budget engine and the provider's own gating run for real.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  AI_BUDGET_EXCEEDED,
  aiBudgetLimitTokens,
  budgetPeriod,
  chatComplete,
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

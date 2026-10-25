import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R25.12/R25.13 — usage capture and the transport guard.
 *
 * The database is an in-memory `AiBudget`/`AiUsage` stand-in; `fetch` is
 * stubbed. The provider client, the budget math and the SSE parser run for
 * real, so these cases prove the guard refuses before the network and that a
 * provider response (JSON or the final stream `usage` frame) reaches the
 * durable counter.
 */

type BudgetRow = { monthlyTokenLimit: number; warnPercent: number; hardStop: boolean };
type UsageRow = {
  workspaceId: string;
  period: string;
  surface: string;
  tokensIn: number;
  tokensOut: number;
  requests: number;
  failures: number;
};

const { state, prisma } = vi.hoisted(() => {
  const state = {
    budgets: new Map<string, BudgetRow>(),
    usage: [] as UsageRow[],
  };

  const prisma = {
    aiBudget: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId: string } }) => {
        return state.budgets.get(where.workspaceId) ?? null;
      }),
    },
    aiUsage: {
      aggregate: vi.fn(async ({
        where,
      }: {
        where: { workspaceId: string; period: string };
      }) => {
        const rows = state.usage.filter(
          (row) => row.workspaceId === where.workspaceId && row.period === where.period,
        );
        return {
          _sum: {
            tokensIn: rows.reduce((sum, row) => sum + row.tokensIn, 0),
            tokensOut: rows.reduce((sum, row) => sum + row.tokensOut, 0),
            requests: rows.reduce((sum, row) => sum + row.requests, 0),
          },
        };
      }),
      upsert: vi.fn(async ({
        where,
        create,
        update,
      }: {
        where: {
          workspaceId_period_surface: {
            workspaceId: string;
            period: string;
            surface: string;
          };
        };
        create: UsageRow;
        update: {
          tokensIn?: { increment: number };
          tokensOut?: { increment: number };
          requests?: { increment: number };
          failures?: { increment: number };
        };
      }) => {
        const key = where.workspaceId_period_surface;
        let row = state.usage.find(
          (entry) =>
            entry.workspaceId === key.workspaceId &&
            entry.period === key.period &&
            entry.surface === key.surface,
        );
        if (!row) {
          row = {
            ...create,
            workspaceId: key.workspaceId,
            period: key.period,
            surface: key.surface,
          };
          state.usage.push(row);
          return row;
        }
        row.tokensIn += update.tokensIn?.increment ?? 0;
        row.tokensOut += update.tokensOut?.increment ?? 0;
        row.requests += update.requests?.increment ?? 0;
        row.failures += update.failures?.increment ?? 0;
        return row;
      }),
    },
  };

  return { state, prisma };
});

vi.mock("@/lib/db", () => ({ prisma }));

import {
  AI_BUDGET_EXCEEDED,
  budgetPeriod,
  chatComplete,
  chatCompleteStream,
  resetAiBudgetLedger,
  type AiCallUsage,
} from "@/lib/ai-provider";

const WORKSPACE = "clx1a2b3c4d5e6f7g8h9i0jkl";
const PERIOD = budgetPeriod();

const CONFIG = {
  provider: "mock",
  baseUrl: "http://localhost:1/v1",
  model: "gpt-4o",
  apiKey: "k",
  source: "workspace" as const,
  workspaceId: WORKSPACE,
};

function setBudget(overrides: Partial<BudgetRow> = {}) {
  state.budgets.set(WORKSPACE, {
    monthlyTokenLimit: 1000,
    warnPercent: 80,
    hardStop: true,
    ...overrides,
  });
}

function addUsage(tokensIn: number, tokensOut: number, surface = "chat") {
  state.usage.push({
    workspaceId: WORKSPACE,
    period: PERIOD,
    surface,
    tokensIn,
    tokensOut,
    requests: 1,
    failures: 0,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: string[], chunkSize = 17): Response {
  const encoder = new TextEncoder();
  const body = frames.map((frame) => `data: ${frame}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < body.length; index += chunkSize) {
        controller.enqueue(encoder.encode(body.slice(index, index + chunkSize)));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_BUDGET_TOKENS;
  state.budgets.clear();
  state.usage.length = 0;
  resetAiBudgetLedger();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.AI_BUDGET_TOKENS;
  resetAiBudgetLedger();
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

describe("chatComplete — durable usage capture", () => {
  it("records the provider's token counts under the requested surface", async () => {
    setBudget();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        }),
      ),
    );

    const result = await chatComplete(
      { system: "hello", user: "world" },
      CONFIG,
      { surface: "ask" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful answer");
    expect(result.usage).toMatchObject({
      model: "gpt-4o",
      inputTokens: 12,
      outputTokens: 5,
      estimated: false,
    });
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      workspaceId: WORKSPACE,
      period: PERIOD,
      surface: "ask",
      tokensIn: 12,
      tokensOut: 5,
      requests: 1,
      failures: 0,
    });
  });

  it("estimates when a provider reports no usage", async () => {
    setBudget();
    const answer = "x".repeat(400);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: answer } }] })),
    );

    const result = await chatComplete({ system: "s", user: "u" }, CONFIG, { surface: "skill" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful answer");
    expect(result.usage?.estimated).toBe(true);
    expect(result.usage?.outputTokens).toBe(100);
    expect(state.usage[0]).toMatchObject({ surface: "skill", tokensOut: 100 });
  });

  it("records a provider failure with zero tokens and one failure", async () => {
    setBudget();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream exploded", { status: 500 })),
    );

    const result = await chatComplete({ system: "s", user: "u" }, CONFIG, { surface: "chat" });

    expect(result.ok).toBe(false);
    expect(state.usage[0]).toMatchObject({
      surface: "chat",
      tokensIn: 0,
      tokensOut: 0,
      requests: 1,
      failures: 1,
    });
  });
});

describe("chatComplete — pre-dispatch budget guard", () => {
  it("refuses an over-budget call without issuing a fetch", async () => {
    setBudget({ monthlyTokenLimit: 10 });
    addUsage(10, 0);
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatComplete({ system: "hello", user: "world" }, CONFIG);

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: AI_BUDGET_EXCEEDED,
      code: "AI_BUDGET_EXCEEDED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // A refused dispatch is not a request: it is not metered.
    expect(prisma.aiUsage.upsert).not.toHaveBeenCalled();
  });

  it("allows the settings connection test over budget but still records it", async () => {
    setBudget({ monthlyTokenLimit: 10 });
    addUsage(10, 0);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatComplete(
      { system: "ping", user: "ping" },
      CONFIG,
      { surface: "test", bypassBudget: true },
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.usage.find((row) => row.surface === "test")).toMatchObject({
      tokensIn: 1,
      tokensOut: 1,
      requests: 1,
    });
  });
});

describe("chatCompleteStream — final usage frame", () => {
  it("reads usage from the final SSE frame and reports it once", async () => {
    setBudget();
    const fetchMock = vi.fn(async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
        "[DONE]",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    let text = "";
    let captured: AiCallUsage | null = null;
    for await (const delta of chatCompleteStream(
      { system: "s", user: "u" },
      CONFIG,
      {
        surface: "chat-stream",
        onUsage: (usage) => {
          captured = usage;
        },
      },
    )) {
      text += delta;
    }

    expect(text).toBe("Hello");
    expect(captured).toMatchObject({ inputTokens: 7, outputTokens: 2, estimated: false });
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      surface: "chat-stream",
      tokensIn: 7,
      tokensOut: 2,
      requests: 1,
      failures: 0,
    });

    // The request asks the provider for the usage frame.
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as {
      stream_options?: { include_usage?: boolean };
    };
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("estimates the output when the provider omits the usage frame", async () => {
    setBudget();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
          "[DONE]",
        ]),
      ),
    );

    let captured: AiCallUsage | null = null;
    const stream = chatCompleteStream({ system: "s", user: "u" }, CONFIG, {
      surface: "chat-stream",
      onUsage: (usage) => {
        captured = usage;
      },
    });
    while (!(await stream.next()).done) {
      // consume the deltas
    }

    const usage = captured as AiCallUsage | null;
    expect(usage?.estimated).toBe(true);
    expect(usage?.outputTokens).toBe(2);
    expect(state.usage[0]).toMatchObject({ tokensOut: 2, failures: 0 });
  });

  it("refuses an over-budget stream before the fetch", async () => {
    setBudget({ monthlyTokenLimit: 10 });
    addUsage(10, 0);
    const fetchMock = vi.fn(async () => sseResponse(["[DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    const stream = chatCompleteStream({ system: "hello", user: "world" }, CONFIG);
    await expect(stream.next()).rejects.toMatchObject({
      message: AI_BUDGET_EXCEEDED,
      code: "budget_exceeded",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rates a provider failure as a failed request", async () => {
    setBudget();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const stream = chatCompleteStream({ system: "s", user: "u" }, CONFIG, {
      surface: "chat-stream",
    });
    await expect(stream.next()).rejects.toBeInstanceOf(Error);
    expect(state.usage[0]).toMatchObject({
      surface: "chat-stream",
      tokensIn: 0,
      tokensOut: 0,
      requests: 1,
      failures: 1,
    });
  });
});

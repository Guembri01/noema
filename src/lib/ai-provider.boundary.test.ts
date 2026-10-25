import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R25.15 — the training boundary is enforced by the transport, not only by the
 * exported guard. A provider the operator declares as training must not
 * receive a request unless they explicitly opt in.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { chatComplete, chatCompleteStream, ProviderClassError } from "@/lib/ai-provider";

const CONFIG = {
  provider: "trainer",
  baseUrl: "https://trainer.example/v1",
  model: "m",
  apiKey: "sk-key",
  source: "workspace" as const,
};

beforeEach(() => {
  delete process.env.AI_BUDGET_TOKENS;
  delete process.env.AI_PROVIDER_TRAINS_ON_DATA;
  delete process.env.AI_ALLOW_PROVIDER_TRAINING;
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete process.env.AI_BUDGET_TOKENS;
  delete process.env.AI_PROVIDER_TRAINS_ON_DATA;
  delete process.env.AI_ALLOW_PROVIDER_TRAINING;
  vi.unstubAllGlobals();
});

describe("chatComplete training boundary", () => {
  it("issues no request to a declared training provider by default", async () => {
    process.env.AI_PROVIDER_TRAINS_ON_DATA = "true";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatComplete({ system: "s", user: "private" }, CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/trains on submitted content/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the request only with the explicit opt-in", async () => {
    process.env.AI_PROVIDER_TRAINS_ON_DATA = "true";
    process.env.AI_ALLOW_PROVIDER_TRAINING = "true";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatComplete({ system: "s", user: "private" }, CONFIG);

    expect(result).toMatchObject({ ok: true, text: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("chatCompleteStream training boundary", () => {
  it("throws a classified refusal before opening the stream", async () => {
    process.env.AI_PROVIDER_TRAINS_ON_DATA = "true";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const stream = chatCompleteStream({ system: "s", user: "private" }, CONFIG);

    await expect(
      (async () => {
        for await (const _delta of stream) void _delta;
      })(),
    ).rejects.toBeInstanceOf(ProviderClassError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

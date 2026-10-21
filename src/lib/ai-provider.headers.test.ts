import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A provider should be able to tell *who* is calling it (#271).
 *
 * OpenCode Go asks its clients for two headers
 * (https://opencode.ai/v2/docs/console/go/):
 *
 * - a user agent of the client's own, such as `my-coding-agent/1.0`, rather
 *   than a generic SDK or HTTP-library name. Without one the runtime fills the
 *   header in with its own name — `node` — which says nothing about the
 *   application;
 * - a stable session id in `x-opencode-session` for each conversation, so the
 *   provider can route and cache per conversation.
 *
 * The session id names an internal object, so it travels to OpenCode Go only:
 * no other provider has any use for it.
 *
 * The database is mocked and `fetch` is stubbed; the provider client runs for
 * real.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  chatComplete,
  listProviderModels,
  providerRequestHeaders,
  providerUserAgent,
} from "@/lib/ai-provider";
import { conversationSessionId, workspaceSessionId } from "@/lib/ai-session";

const API_KEY = "sk-live-abcdef1234567890";

/** A Go endpoint — the one that asks for the session header. */
const GO_CONFIG = {
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/inference/go/openai/v1",
  model: "glm-5.3-flash",
  apiKey: API_KEY,
  source: "workspace" as const,
  workspaceId: "cm5wq2k3l4k5b6c7d8e9f0g1h",
  sessionId: workspaceSessionId("cm5wq2k3l4k5b6c7d8e9f0g1h"),
};

/** Any other provider — the session id must not reach it. */
const OTHER_CONFIG = {
  ...GO_CONFIG,
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
};

/** The headers of the last stubbed request. */
function lastHeaders(): Record<string, string> {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const init = calls[calls.length - 1]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

/** The URL of the last stubbed request. */
function lastUrl(): string {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return String(calls[calls.length - 1]?.[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_BUDGET_TOKENS;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  delete process.env.AI_BUDGET_TOKENS;
  vi.unstubAllGlobals();
});

describe("the user agent", () => {
  it("names the application and its version, not the runtime", () => {
    expect(providerUserAgent()).toMatch(/^noema\/\d+\.\d+\.\d+/);
    expect(providerUserAgent()).not.toContain("node");
  });

  it("travels with every provider request", async () => {
    await chatComplete({ system: "s", user: "u" }, OTHER_CONFIG);

    expect(lastHeaders()["user-agent"]).toBe(providerUserAgent());
  });

  it("does not replace the key on the way", async () => {
    await chatComplete({ system: "s", user: "u" }, OTHER_CONFIG);

    expect(lastHeaders().authorization).toBe(`Bearer ${API_KEY}`);
    expect(lastHeaders()["content-type"]).toBe("application/json");
  });
});

describe("the session header", () => {
  it("names the session to OpenCode Go", async () => {
    await chatComplete({ system: "s", user: "u" }, GO_CONFIG);

    expect(lastHeaders()["x-opencode-session"]).toBe(GO_CONFIG.sessionId);
  });

  it("stays stable across the requests of one conversation", async () => {
    const conversation = conversationSessionId("t1");

    await chatComplete({ system: "s", user: "u" }, { ...GO_CONFIG, sessionId: conversation });
    await chatComplete({ system: "s", user: "u" }, { ...GO_CONFIG, sessionId: conversation });

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const first = (calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const second = (calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(first["x-opencode-session"]).toBe(conversation);
    expect(second["x-opencode-session"]).toBe(conversation);
  });

  it("names a conversation and a workspace differently", () => {
    expect(conversationSessionId("t1")).not.toBe(workspaceSessionId("t1"));
    expect(conversationSessionId("t1")).toContain("t1");
    expect(conversationSessionId("t1")).toBe(conversationSessionId("t1"));
  });

  it("does not travel to another provider: the id names an internal object", async () => {
    await chatComplete({ system: "s", user: "u" }, OTHER_CONFIG);

    expect(lastHeaders()["x-opencode-session"]).toBeUndefined();
  });

  it("never reaches a look-alike host", async () => {
    await chatComplete({ system: "s", user: "u" }, {
      ...GO_CONFIG,
      baseUrl: "https://opencode.ai.evil.example/inference/go/openai/v1",
    });

    expect(lastHeaders()["x-opencode-session"]).toBeUndefined();
  });

  it("is sent even when the config names no session", async () => {
    const { sessionId: _dropped, ...withoutSession } = GO_CONFIG;

    await chatComplete({ system: "s", user: "u" }, withoutSession);

    expect(lastHeaders()["x-opencode-session"]).toMatch(/^noema:deployment:/);
  });
});

describe("the model list", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: "glm-5.3" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  it("is read from the provider's own catalogue URL", async () => {
    const result = await listProviderModels({
      baseUrl: GO_CONFIG.baseUrl,
      apiKey: API_KEY,
      modelsUrl: "https://opencode.ai/inference/go/v1/models",
    });

    expect(result.ok).toBe(true);
    expect(lastUrl()).toBe("https://opencode.ai/inference/go/v1/models");
  });

  it("falls back to the base URL's own path", async () => {
    await listProviderModels({ baseUrl: "https://api.openai.com/v1", apiKey: API_KEY });

    expect(lastUrl()).toBe("https://api.openai.com/v1/models");
  });
});

describe("the header builder", () => {
  it("carries the key and the user agent, and nothing else by default", () => {
    const headers = providerRequestHeaders({ apiKey: API_KEY, baseUrl: "https://api.openai.com/v1" });

    expect(headers).toEqual({
      authorization: `Bearer ${API_KEY}`,
      "user-agent": providerUserAgent(),
    });
  });

  it("adds the session only to an OpenCode Go endpoint", () => {
    const go = providerRequestHeaders({
      apiKey: API_KEY,
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      sessionId: "s1",
    });
    const other = providerRequestHeaders({
      apiKey: API_KEY,
      baseUrl: "https://api.deepseek.com",
      sessionId: "s1",
    });

    expect(go["x-opencode-session"]).toBe("s1");
    expect(other["x-opencode-session"]).toBeUndefined();
  });
});

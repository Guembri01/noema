import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * `/api/ai` must not hand a provider's error body to the client (B19).
 *
 * OpenAI-compatible gateways echo the API key back in their error body. The
 * provider client reduces such a failure to its status plus a stable code, and
 * the route forwards only that. The transport edges — auth, rate limiting and
 * the database — are mocked; the provider client and the route's own error
 * handling run for real.
 */

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));

import { POST } from "./route";

/** The key the workspace sent to the provider — the thing that must not leak. */
const API_KEY = "sk-live-abcdef1234567890";

/** A provider body that echoes the key back, the way a gateway does. */
const LEAKY_BODY = JSON.stringify({
  error: {
    message: `Incorrect API key provided: ${API_KEY}.`,
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
});

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AI_API_KEY", API_KEY);
  vi.stubEnv("AI_BASE_URL", "http://localhost:1/v1");
  vi.stubEnv("AI_MODEL", "gpt-4o-mini");
  auth.getCurrentUser.mockResolvedValue({ id: "u1" });
  guard.rateLimit.mockReturnValue(null);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

describe("provider failures", () => {
  it("does not forward the provider body to the client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(LEAKY_BODY, {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const response = await post({ prompt: "hello" });
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain("Incorrect API key provided");
    const body = JSON.parse(raw) as { error?: string };
    expect(body.error).toBe("AI provider error (401): invalid_api_key");
  });

  it("keeps the key out of the log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(LEAKY_BODY, {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await post({ prompt: "hello" });

    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain(API_KEY);
  });

  it("keeps the key out of the log when the model is the key", async () => {
    // The model is free text, and a deployment can point it at the very key
    // it sends (AI_MODEL = the key). The model is then the key — and a key in
    // a format the scrubber does not know survives the shape check, so only
    // the comparison against the key itself keeps it out of the log.
    const hexKey = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    vi.stubEnv("AI_API_KEY", hexKey);
    vi.stubEnv("AI_MODEL", hexKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(LEAKY_BODY, {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const response = await post({ prompt: "hello" });
    const raw = await response.text();

    // The answer carries a class, as ever.
    expect(response.status).toBe(502);
    expect(raw).not.toContain(hexKey);
    // And the log carries neither the key nor a fragment of it — the model
    // field is simply not there.
    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain(hexKey);
    expect(logged).not.toContain(hexKey.slice(0, 8));
    expect(logged).not.toContain("model");
    // The line keeps its anchor.
    expect(logged).toContain("invalid_api_key");
  });
});

describe("successful calls", () => {
  it("still returns the model text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const response = await post({ prompt: "hello" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { text?: string }).text).toBe("hi");
  });
});

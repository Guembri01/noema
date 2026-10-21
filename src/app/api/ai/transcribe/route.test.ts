import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * `/api/ai/transcribe` must not hand a provider's error body to the client
 * (B19).
 *
 * The transcription endpoint talks to an OpenAI-compatible gateway, and those
 * echo the API key back in their error body. The failure is reduced to its
 * status plus a stable code; the body itself reaches neither the client nor
 * the log.
 *
 * The transport edges — auth, rate limiting and the database — are mocked; the
 * route's own error handling runs for real.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));

import { PROVIDER_UNREACHABLE, TRANSPORT_ERROR } from "@/lib/ai-provider";

/** The key the server sent to the provider — the thing that must not leak. */
const API_KEY = "sk-transcribe-abcdef1234567890";

/** A provider body that echoes the key back, the way a gateway does. */
const LEAKY_BODY = JSON.stringify({
  error: {
    message: `Incorrect API key provided: ${API_KEY}.`,
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
});

/**
 * The route reads its key at module scope, so the module is re-imported after
 * the environment has been stubbed.
 */
async function loadPost(key = API_KEY) {
  vi.resetModules();
  vi.stubEnv("AI_TRANSCRIBE_API_KEY", key);
  const mod = await import("./route");
  return mod.POST;
}

function transcriptionRequest(): Request {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array([1, 2, 3])], "clip.wav", { type: "audio/wav" }),
  );
  return new Request("http://test/api/ai/transcribe", { method: "POST", body: form });
}

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
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
    const POST = await loadPost();
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

    const response = await POST(transcriptionRequest());
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain("Incorrect API key provided");
    const body = JSON.parse(raw) as { error?: string };
    expect(body.error).toBe("Transcription failed (401): invalid_api_key");
  });

  it("keeps the key out of the log", async () => {
    const POST = await loadPost();
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

    await POST(transcriptionRequest());

    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain("Incorrect API key provided");
    // The stable code stays: it is the grep anchor for the log — without it
    // the failure would be invisible to the operator.
    expect(logged).toContain("invalid_api_key");
  });

  it("does not forward a truncated echo of the key either", async () => {
    // A provider may echo the key in the machine field ("code") instead of
    // the human one ("message") — whole, masked, truncated or re-cased. None
    // of those spellings is something the provider chooses freely, and none
    // of them may reach the client: a truncated key is not the key, so a
    // comparison that only knows the whole key would take it over as the
    // provider's code.
    //
    // The key is a plain hex one on purpose: a truncated `sk-…` key is caught
    // by the credential *shape* anyway, so only a key the scrubber does not
    // know proves that the comparison against the key itself works.
    const hexKey = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const truncated = hexKey.slice(0, 24);
    const POST = await loadPost(hexKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: truncated } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const response = await POST(transcriptionRequest());
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain(truncated);
    expect(raw).not.toContain(hexKey);
    const body = JSON.parse(raw) as { error?: string };
    expect(body.error).toBe("Transcription failed (401): authentication_failed");
  });
});

describe("transport failures", () => {
  it("reports a transport error as a class, not as its message", async () => {
    // The runtime rejects an invalid header value with the *whole* header in
    // its message — and that header is the `Authorization` header we sent:
    //   Headers.append: "Bearer <key>" is an invalid header value.
    //
    // A scrubber knows a fixed set of credential *shapes*: the `Bearer` shape
    // covers "sk-transcribe-abc" and stops at the newline, so the tail
    // "def-tail-9x" survives it. Only a class is safe whatever the key looks
    // like.
    const key = "sk-transcribe-abc\ndef-tail-9x";
    const POST = await loadPost(key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          `Headers.append: "Bearer ${key}" is an invalid header value.`,
        );
      }),
    );

    const response = await POST(transcriptionRequest());
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain("sk-transcribe-abc");
    expect(raw).not.toContain("def-tail-9x");
    const body = JSON.parse(raw) as { error?: string };
    expect(body.error).toBe(PROVIDER_UNREACHABLE);

    // The log carries the class and no runtime text.
    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain("sk-transcribe-abc");
    expect(logged).not.toContain("def-tail-9x");
    expect(logged).toContain(TRANSPORT_ERROR);
  });
});

describe("successful calls", () => {
  it("still returns the transcript", async () => {
    const POST = await loadPost();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ text: "hello there" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const response = await POST(transcriptionRequest());
    expect(response.status).toBe(200);
    expect(((await response.json()) as { text?: string }).text).toBe("hello there");
  });
});

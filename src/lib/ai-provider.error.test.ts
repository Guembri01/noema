import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * Provider failures must never carry the provider's body (B19).
 *
 * Several OpenAI-compatible gateways (vLLM, LiteLLM, Ollama, Azure API
 * Management) echo the API key back in their error body — "Incorrect API key
 * provided: sk-live-…". A failure is therefore reduced to a class: the
 * upstream status plus a stable code. The body reaches neither the client nor
 * the server-side log — not even as a redacted excerpt.
 *
 * The database is mocked and `fetch` is stubbed; the provider's own
 * classification runs for real.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  chatComplete,
  chatCompleteStream,
  listProviderModels,
  providerFailure,
  PROVIDER_UNREACHABLE,
  TRANSPORT_ERROR,
} from "@/lib/ai-provider";

/** The key the workspace sent to the provider — the thing that must not leak. */
const API_KEY = "sk-live-abcdef1234567890";

const CONFIG = {
  provider: "mock",
  baseUrl: "http://localhost:1/v1",
  model: "gpt-4o",
  apiKey: API_KEY,
  source: "workspace" as const,
  /** A workspace id of the app's own shape — the log carries such an id. */
  workspaceId: "cm5wq2k3l4k5b6c7d8e9f0g1h",
};

/** A provider body that echoes the key back, the way a gateway does. */
const LEAKY_BODY = JSON.stringify({
  error: {
    message: `Incorrect API key provided: ${API_KEY}. You can find your API key at https://example.invalid/keys.`,
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
});

function providerError(body: string, status = 401): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  delete process.env.AI_BUDGET_TOKENS;
  vi.unstubAllGlobals();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.AI_BUDGET_TOKENS;
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

describe("provider failure classification", () => {
  it("keeps the status and the provider's own code", () => {
    const failure = providerFailure(401, LEAKY_BODY, API_KEY);
    expect(failure.status).toBe(401);
    expect(failure.code).toBe("invalid_api_key");
    expect(failure.message).toBe("AI provider error (401): invalid_api_key");
  });

  it("never puts body text into the message", () => {
    const failure = providerFailure(401, LEAKY_BODY, API_KEY);
    expect(failure.message).not.toContain(API_KEY);
    expect(failure.message).not.toContain("Incorrect API key provided");
    expect(failure.message).not.toContain("example.invalid");
  });

  it("falls back to the status class when the body carries no code", () => {
    expect(providerFailure(401, "", API_KEY).code).toBe("authentication_failed");
    expect(providerFailure(429, "too many requests", API_KEY).code).toBe(
      "rate_limited",
    );
    expect(providerFailure(500, "boom", API_KEY).code).toBe("provider_error");
    expect(providerFailure(404, "nope", API_KEY).code).toBe("not_found");
  });

  it("ignores a code that is credential-shaped or carries the key we sent", () => {
    // A credential shape that is *not* the key we sent — the form check has
    // to catch it on its own. It shares no run of eight characters with the
    // key either, so only the *form* can refuse it.
    const credentialShaped = JSON.stringify({
      error: { code: "sk-proj-zzzzzzzzzzzzzzzz" },
    });
    expect(providerFailure(401, credentialShaped, API_KEY).code).toBe(
      "authentication_failed",
    );

    const echoesTheKey = JSON.stringify({
      error: { code: "key-abcdef1234567890" },
    });
    expect(providerFailure(401, echoesTheKey, "key-abcdef1234567890").code).toBe(
      "authentication_failed",
    );
  });

  it("never takes over a foreign credential-shaped code", () => {
    // A code that is shaped like a secret is no code at all — whoever owns
    // the secret, it must not travel to the client in the answer.
    //
    // None of these shapes shares a run of eight characters with the key we
    // sent, so the *form* alone has to refuse every one of them: each shape
    // pins the credential-shape guard on its own.
    const shapes = [
      "sk-proj-zzzzzzzzzzzzzzzz",
      "ghp_abcdefghijklmnopqrstuvwx",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123signature",
    ];
    for (const shape of shapes) {
      const body = JSON.stringify({ error: { code: shape } });
      const failure = providerFailure(401, body, API_KEY);
      expect(failure.code).toBe("authentication_failed");
      expect(failure.message).not.toContain(shape);
    }
  });

  it("never takes over a code that carries markup", () => {
    // The whitelist is all that stands between a provider body and the
    // client: a code must look like an identifier, so no markup can ride
    // along in it.
    const markup = JSON.stringify({
      error: { code: "<script>alert(1)</script>" },
    });
    const markupFailure = providerFailure(400, markup, API_KEY);
    expect(markupFailure.code).toBe("invalid_request");
    expect(markupFailure.message).not.toContain("<script>");

    // The same payload in the `type` field — the second candidate the body
    // is read for.
    const markupAsType = JSON.stringify({
      error: { type: "<script>alert(1)</script>" },
    });
    expect(providerFailure(400, markupAsType, API_KEY).code).toBe(
      "invalid_request",
    );

    // A control character is no identifier either — and it would forge a
    // line in the log.
    const controlCharacter = JSON.stringify({
      error: { code: "invalid\ncode" },
    });
    expect(providerFailure(400, controlCharacter, API_KEY).code).toBe(
      "invalid_request",
    );
  });

  it("never lets a short key come back as the provider's code", () => {
    // A key shorter than eight characters used to switch the poison check
    // off entirely — the provider's own code then *was* the key.
    const shortKey = "abc123";
    const echoed = JSON.stringify({
      error: { code: shortKey, type: shortKey },
    });

    const failure = providerFailure(401, echoed, shortKey);

    expect(failure.code).toBe("authentication_failed");
    expect(failure.message).not.toContain(shortKey);
  });

  it("never takes over a code that carries a part of the key", () => {
    // The provider does not choose the spelling of its echo freely: a code
    // that keeps a run of the key's characters is the key, however it is
    // written. A containment check that only knows the *whole* key would
    // take these over as the provider's code — and they would leave the
    // server, in the answer and in the persisted chat row.
    const hexKey = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const echoes = [
      ["masked", "a1b2c3d4...c5d6"],
      ["truncated", hexKey.slice(0, 31)],
      ["re-cased", hexKey.toUpperCase()],
    ] as const;

    for (const [label, echo] of echoes) {
      const body = JSON.stringify({ error: { code: echo } });
      const failure = providerFailure(401, body, hexKey);

      expect(failure.code, `${label} echo`).toBe("authentication_failed");
      expect(failure.message, `${label} echo`).not.toContain(echo);
    }

    // A piece of the key is poison as well — the part behind the prefix is
    // a run of the key's characters like any other.
    const tail = API_KEY.slice("sk-live-".length);
    const tailBody = JSON.stringify({ error: { code: tail } });
    expect(providerFailure(401, tailBody, API_KEY).code).toBe(
      "authentication_failed",
    );

    // A legitimate code still is taken over — the check fails closed, it
    // does not reject every code.
    const legitimate = JSON.stringify({ error: { code: "invalid_api_key" } });
    expect(providerFailure(401, legitimate, hexKey).code).toBe(
      "invalid_api_key",
    );

    // And a short, common fragment of the key is no leak either: the
    // fingerprint is eight characters, so an ordinary code that happens to
    // share a few characters with the key keeps being a code.
    for (const code of ["live", "1234", "sk"]) {
      const body = JSON.stringify({ error: { code } });
      expect(providerFailure(401, body, API_KEY).code).toBe(code);
    }
  });

  it("ignores a code that is not an identifier", () => {
    const hostile = JSON.stringify({
      error: { code: "bad code\nwith <html> & secrets" },
    });
    expect(providerFailure(400, hostile, API_KEY).code).toBe("invalid_request");
  });
});

describe("chatComplete failures", () => {
  it("does not forward the provider body to the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerError(LEAKY_BODY)),
    );

    const result = await chatComplete({ system: "s", user: "u" }, CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.status).toBe(502);
    expect(result.error).not.toContain(API_KEY);
    expect(result.error).not.toContain("Incorrect API key provided");
    expect(result.error).toBe("AI provider error (401): invalid_api_key");
  });

  it("keeps the key out of the log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerError(LEAKY_BODY)),
    );

    await chatComplete({ system: "s", user: "u" }, CONFIG);

    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain("Incorrect API key provided");
    // The log carries the class and nothing of the body: no excerpt, not even
    // a redacted one — a body may hold other secrets than the key.
    expect(logged).not.toContain("example.invalid");
    // The stable code stays: it is the grep anchor for the log.
    expect(logged).toContain("invalid_api_key");
    // The line says whose call failed — in an installation with several
    // workspaces a line without that is unattributable.
    expect(logged).toContain(CONFIG.workspaceId);
    expect(logged).toContain("mock");
    expect(logged).toContain("gpt-4o");
    // The endpoint never does: it can carry a credential in its user info.
    expect(logged).not.toContain("localhost:1");
  });
});

/**
 * The attribution the log carries: the workspace, the provider and the model.
 *
 * The values come from the workspace's own settings — and on two of the AI
 * routes from the request body — so they are untrusted like every other input.
 * A value may only be written when it is safe to write: never a credential,
 * never the key we sent, never a string the client chose, and never longer
 * than a log line can hold.
 */
describe("the log attribution", () => {
  /**
   * Let one provider call fail and return the line that was logged.
   *
   * The line is an object, so a value that is dropped leaves no trace behind:
   * the field is simply not there.
   */
  async function logLine(overrides: Partial<typeof CONFIG>): Promise<{
    fields: Record<string, string>;
    text: string;
  }> {
    errorSpy.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerError(LEAKY_BODY)),
    );

    await chatComplete({ system: "s", user: "u" }, { ...CONFIG, ...overrides });

    const call = errorSpy.mock.calls.findLast(
      (entry) => entry[0] === "ai provider error",
    );
    return {
      fields: (call?.[1] ?? {}) as Record<string, string>,
      text: errorSpy.mock.calls.map((entry) => JSON.stringify(entry)).join("\n"),
    };
  }

  it("leaves the model out when it is the key we sent", async () => {
    // The model is free text — in the AI form, in the environment and in the
    // chat request — and a deployment can point it at the very key it sends
    // (AI_MODEL = the key). The model is then the key, and a key in a format
    // the scrubber does not know survives the shape check: only the
    // comparison against the key itself stops it.
    const hexKey = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

    const whole = await logLine({ apiKey: hexKey, model: hexKey });
    expect("model" in whole.fields).toBe(false);
    expect(whole.text).not.toContain(hexKey);

    // Eight characters of the key are its fingerprint — enough of it to be
    // used against the provider.
    const fragment = await logLine({ apiKey: hexKey, model: hexKey.slice(0, 8) });
    expect("model" in fragment.fields).toBe(false);
    expect(fragment.text).not.toContain(hexKey.slice(0, 8));

    // A key in a known shape is caught by the shape check.
    const shaped = await logLine({ model: API_KEY });
    expect("model" in shaped.fields).toBe(false);
    expect(shaped.text).not.toContain(API_KEY);

    // An ordinary model stays: the guard must not swallow the attribution.
    const ordinary = await logLine({ model: "gpt-4o-mini" });
    expect(ordinary.fields.model).toBe("gpt-4o-mini");
  });

  it("leaves the model out when it is credential-shaped", async () => {
    // A value that looks like a credential is no attribution at all: it is
    // dropped, not scrubbed — a scrubbed value would still say something about
    // a secret that does not belong in the line.
    for (const shaped of [
      "sk-live-abcdef1234567890",
      "ghp_abcdefghijklmnopqrstuvwx",
    ]) {
      const { fields, text } = await logLine({ model: shaped });
      expect("model" in fields, shaped).toBe(false);
      expect(text, shaped).not.toContain(shaped);
    }
  });

  it("cuts a long model down to a length a log line can hold", async () => {
    const { fields } = await logLine({ model: "m".repeat(200) });
    expect(fields.model).toBe("m".repeat(64));
  });

  it("leaves out a workspace id that is not an id of the app's own shape", async () => {
    // Two of the AI routes take the workspace id from the request body, so
    // the value is chosen by the client. Only an id the app hands out may be
    // written: a client cannot put an arbitrary string into the operator's
    // log, and a value that is not an id is left out rather than guessed.
    const spoofed = await logLine({ workspaceId: "spoofed-workspace" });
    expect("workspaceId" in spoofed.fields).toBe(false);
    expect(spoofed.text).not.toContain("spoofed-workspace");

    // An id of the app's own shape stays — the attribution is the point of
    // the line.
    const real = await logLine({ workspaceId: "cm5wq2k3l4k5b6c7d8e9f0g1h" });
    expect(real.fields.workspaceId).toBe("cm5wq2k3l4k5b6c7d8e9f0g1h");
  });
});

describe("chatCompleteStream failures", () => {
  it("does not forward the provider body through the thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => providerError(LEAKY_BODY)),
    );

    const stream = chatCompleteStream({ system: "s", user: "u" }, CONFIG);
    await expect(
      (async () => {
        for await (const _delta of stream) void _delta;
      })(),
    ).rejects.toThrow(/AI provider error \(401\): invalid_api_key/);

    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain(API_KEY);
  });
});

describe("listProviderModels failures", () => {
  it("reports a transport error as a class, not as its message", async () => {
    // The runtime rejects an invalid header value with the *whole* header in
    // its message — the key we sent included:
    //   Headers.append: "Bearer <key>" is an invalid header value.
    const key = "sk-live-abc\ndef";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          `Headers.append: "Bearer ${key}" is an invalid header value.`,
        );
      }),
    );

    const result = await listProviderModels({
      baseUrl: "http://localhost:1/v1",
      apiKey: key,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).not.toContain(key);
    expect(result.error).not.toContain("sk-live-abc");
    expect(result.error).toBe(PROVIDER_UNREACHABLE);

    // And it is not logged raw either: the log keeps the class and no runtime
    // text, so the operator sees the failure without the key.
    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain("sk-live-abc");
    expect(logged).not.toContain("def");
    expect(logged).toContain(TRANSPORT_ERROR);
  });
});

describe("chatComplete transport failures", () => {
  it("reports a transport error as a class, not as its message", async () => {
    // The runtime rejects an invalid header value with the *whole* header in
    // its message — and that header is the `Authorization` header we sent:
    //   Headers.append: "Bearer <key>" is an invalid header value.
    //
    // A scrubber knows a fixed set of credential *shapes*: the `Bearer` shape
    // covers "sk-live-abc" and stops at the newline, so the tail "def-tail-9x"
    // survives it. Only a class is safe whatever the key looks like.
    const key = "sk-live-abc\ndef-tail-9x";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          `Headers.append: "Bearer ${key}" is an invalid header value.`,
        );
      }),
    );

    const result = await chatComplete(
      { system: "s", user: "u" },
      { ...CONFIG, apiKey: key },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.status).toBe(502);
    // The answer is a class — no key, not even its tail.
    expect(result.error).toBe(PROVIDER_UNREACHABLE);
    expect(result.error).not.toContain("sk-live-abc");
    expect(result.error).not.toContain("def-tail-9x");

    // The log carries the class and no runtime text.
    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain("sk-live-abc");
    expect(logged).not.toContain("def-tail-9x");
    expect(logged).toContain(TRANSPORT_ERROR);
    // A transport failure is attributable as well.
    expect(logged).toContain(CONFIG.workspaceId);
    expect(logged).not.toContain("localhost:1");
  });
});

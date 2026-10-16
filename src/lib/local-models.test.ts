import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  PROVIDER_IDS,
  describeProvider,
  estimateContextFit,
  findProvider,
  isLocal,
  parseProviderConfig,
  pickProvider,
  resolveChatEndpoint,
  validateProviderConfig,
  type ProviderDescriptor,
} from "@/lib/local-models";

/**
 * Local-model provider support engine (docs/specs/ai-surface.md §14 Local model
 * support, R25.8 keyless local providers).
 *
 * Pure and provider-free: a static registry of runtimes (`ollama`, `lmstudio`,
 * `llama.cpp`, `vllm`, `openai`, `anthropic`), config parsing/validation, the
 * endpoint shape per API flavor, a context-window fit check and a deterministic
 * provider preference picker. No network, no DB, no clock, no `any`.
 *
 * Red-first: this file failed to import (`@/lib/local-models` did not exist)
 * before the implementation landed.
 */

const descriptor = (overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor => ({
  id: "custom-local",
  label: "Custom Local",
  kind: "openai-compatible",
  baseUrl: "http://localhost:4321/v1",
  defaultModel: "local-model",
  requiresApiKey: false,
  models: [{ id: "local-model", label: "Local Model" }],
  supportsStreaming: true,
  contextWindow: 4096,
  ...overrides,
});

describe("PROVIDERS registry", () => {
  it("lists exactly the six supported providers", () => {
    expect(PROVIDER_IDS).toEqual([
      "ollama",
      "lmstudio",
      "llama.cpp",
      "vllm",
      "openai",
      "anthropic",
    ]);
    expect(PROVIDERS.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it("has unique provider ids", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every descriptor a complete, well-formed shape", () => {
    for (const provider of PROVIDERS) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.baseUrl.length).toBeGreaterThan(0);
      expect(provider.defaultModel.length).toBeGreaterThan(0);
      expect(provider.contextWindow).toBeGreaterThan(0);
      expect(typeof provider.supportsStreaming).toBe("boolean");
      expect(Array.isArray(provider.models)).toBe(true);
      expect(provider.models.length).toBeGreaterThan(0);
      for (const model of provider.models) {
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses only the supported API kinds", () => {
    const kinds = new Set(PROVIDERS.map((p) => p.kind));
    for (const kind of kinds) {
      expect(["openai-compatible", "ollama", "llamacpp", "anthropic"]).toContain(kind);
    }
  });

  it("marks cloud providers as key-requiring and local ones as keyless", () => {
    expect(findProvider("openai")?.requiresApiKey).toBe(true);
    expect(findProvider("anthropic")?.requiresApiKey).toBe(true);
    for (const id of ["ollama", "lmstudio", "llama.cpp", "vllm"]) {
      expect(findProvider(id)?.requiresApiKey).toBe(false);
    }
  });

  it("gives every local runtime a loopback base URL", () => {
    for (const id of ["ollama", "lmstudio", "llama.cpp", "vllm"]) {
      const provider = findProvider(id);
      expect(provider).toBeDefined();
      expect(isLocal(provider as ProviderDescriptor)).toBe(true);
    }
  });

  it("returns undefined for an unknown or empty id", () => {
    expect(findProvider("nope")).toBeUndefined();
    expect(findProvider("")).toBeUndefined();
    expect(findProvider(undefined)).toBeUndefined();
  });

  it("keeps the default model among the advertised models", () => {
    for (const provider of PROVIDERS) {
      expect(provider.models.map((m) => m.id)).toContain(provider.defaultModel);
    }
  });
});

describe("isLocal", () => {
  it("treats loopback and private hosts as local", () => {
    expect(isLocal(descriptor({ baseUrl: "http://127.0.0.1:1234/v1" }))).toBe(true);
    expect(isLocal(descriptor({ baseUrl: "http://192.168.1.20:8000/v1" }))).toBe(true);
    expect(isLocal(descriptor({ baseUrl: "http://10.0.0.5:11434" }))).toBe(true);
    expect(isLocal(descriptor({ baseUrl: "http://172.16.4.2:8080" }))).toBe(true);
    expect(isLocal(descriptor({ baseUrl: "http://box.local:8080/v1" }))).toBe(true);
  });

  it("treats public HTTPS hosts as remote", () => {
    expect(isLocal(descriptor({ baseUrl: "https://api.openai.com/v1" }))).toBe(false);
    expect(isLocal(descriptor({ baseUrl: "https://api.anthropic.com/v1" }))).toBe(false);
  });

  it("treats the ollama and llama.cpp runtimes as local even off-loopback", () => {
    expect(isLocal(descriptor({ kind: "ollama", baseUrl: "https://gpu.internal.example" }))).toBe(
      true,
    );
    expect(isLocal(descriptor({ kind: "llamacpp", baseUrl: "https://gpu.internal.example" }))).toBe(
      true,
    );
  });

  it("returns false for an unparseable URL", () => {
    expect(isLocal(descriptor({ baseUrl: "not a url" }))).toBe(false);
  });
});

describe("resolveChatEndpoint", () => {
  it("builds the OpenAI-compatible URL with a Bearer key", () => {
    const endpoint = resolveChatEndpoint(findProvider("openai") as ProviderDescriptor, {
      model: "gpt-4o-mini",
      apiKey: "sk-test",
    });
    expect(endpoint.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(endpoint.bodyShape).toBe("openai");
    expect(endpoint.headers["content-type"]).toBe("application/json");
    expect(endpoint.headers.authorization).toBe("Bearer sk-test");
  });

  it("omits the auth header when no key is supplied", () => {
    const endpoint = resolveChatEndpoint(findProvider("lmstudio") as ProviderDescriptor, {
      model: "local",
    });
    expect(endpoint.headers.authorization).toBeUndefined();
    expect(endpoint.headers["x-api-key"]).toBeUndefined();
  });

  it("builds the Ollama native chat URL", () => {
    const endpoint = resolveChatEndpoint(findProvider("ollama") as ProviderDescriptor, {
      model: "llama3.1",
    });
    expect(endpoint.url).toBe("http://localhost:11434/api/chat");
    expect(endpoint.bodyShape).toBe("ollama");
    expect(endpoint.headers["content-type"]).toBe("application/json");
  });

  it("uses the OpenAI shape for the llama.cpp server", () => {
    const endpoint = resolveChatEndpoint(findProvider("llama.cpp") as ProviderDescriptor, {
      model: "local-model",
    });
    expect(endpoint.url).toBe("http://localhost:8080/v1/chat/completions");
    expect(endpoint.bodyShape).toBe("openai");
  });

  it("builds the Anthropic messages URL with its own auth headers", () => {
    const endpoint = resolveChatEndpoint(findProvider("anthropic") as ProviderDescriptor, {
      model: "claude-3-5-sonnet",
      apiKey: "sk-ant",
    });
    expect(endpoint.url).toBe("https://api.anthropic.com/v1/messages");
    expect(endpoint.bodyShape).toBe("anthropic");
    expect(endpoint.headers["x-api-key"]).toBe("sk-ant");
    expect(endpoint.headers["anthropic-version"]).toBe("2023-06-01");
    expect(endpoint.headers.authorization).toBeUndefined();
  });

  it("never doubles the slash when the base URL has a trailing slash", () => {
    const endpoint = resolveChatEndpoint(
      descriptor({ kind: "openai-compatible", baseUrl: "http://localhost:8000/v1/" }),
      { model: "m" },
    );
    expect(endpoint.url).toBe("http://localhost:8000/v1/chat/completions");
  });

  it("passes a Bearer key through for Ollama when one is configured", () => {
    const endpoint = resolveChatEndpoint(findProvider("ollama") as ProviderDescriptor, {
      model: "llama3.1",
      apiKey: "token",
    });
    expect(endpoint.headers.authorization).toBe("Bearer token");
  });
});

describe("estimateContextFit", () => {
  it("fits when the request is under the context window", () => {
    const fit = estimateContextFit(findProvider("ollama") as ProviderDescriptor, {
      promptTokens: 100,
      maxTokens: 100,
    });
    expect(fit.fits).toBe(true);
    expect(fit.reason).toBe("ok");
    expect(fit.requested).toBe(200);
    expect(fit.contextWindow).toBe(8192);
    expect(fit.remaining).toBe(7992);
  });

  it("fits exactly on the boundary", () => {
    const fit = estimateContextFit(findProvider("llama.cpp") as ProviderDescriptor, {
      promptTokens: 4000,
      maxTokens: 96,
    });
    expect(fit.fits).toBe(true);
    expect(fit.remaining).toBe(0);
  });

  it("refuses one token over the context window", () => {
    const fit = estimateContextFit(findProvider("llama.cpp") as ProviderDescriptor, {
      promptTokens: 4000,
      maxTokens: 97,
    });
    expect(fit.fits).toBe(false);
    expect(fit.reason).toBe("over_context");
    expect(fit.remaining).toBe(0);
  });

  it("refuses a prompt that alone exceeds the window", () => {
    const fit = estimateContextFit(findProvider("llama.cpp") as ProviderDescriptor, {
      promptTokens: 5000,
      maxTokens: 10,
    });
    expect(fit.fits).toBe(false);
    expect(fit.reason).toBe("over_context");
  });

  it("coerces missing, negative and non-finite counts to zero", () => {
    const fit = estimateContextFit(findProvider("ollama") as ProviderDescriptor, {
      promptTokens: Number.NaN,
      maxTokens: -50,
    });
    expect(fit.requested).toBe(0);
    expect(fit.fits).toBe(true);
    expect(fit.remaining).toBe(8192);
  });
});

describe("validateProviderConfig", () => {
  it("accepts a keyless local config", () => {
    const result = validateProviderConfig({
      providerId: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a cloud config that carries a key", () => {
    const result = validateProviderConfig({
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "sk-test",
    });
    expect(result.ok).toBe(true);
  });

  it("requires a key for a cloud provider that omits one", () => {
    const result = validateProviderConfig({
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("api_key_required");
  });

  it("rejects plain http on a public host", () => {
    const result = validateProviderConfig({
      providerId: "openai",
      baseUrl: "http://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "sk-test",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("insecure_url");
  });

  it("rejects a non-http(s) base URL", () => {
    const result = validateProviderConfig({
      providerId: "openai",
      baseUrl: "ftp://example.com/v1",
      model: "gpt-4o",
      apiKey: "sk-test",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("invalid_url");
  });

  it("rejects a missing model", () => {
    const result = validateProviderConfig({
      providerId: "ollama",
      baseUrl: "http://localhost:11434",
      model: "",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("model_required");
  });

  it("rejects an unknown provider id", () => {
    const result = validateProviderConfig({
      providerId: "wyoming",
      baseUrl: "https://example.com/v1",
      model: "m",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("unknown_provider");
  });

  it("rejects an empty base URL", () => {
    const result = validateProviderConfig({
      providerId: "ollama",
      baseUrl: "",
      model: "llama3.1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("invalid_url");
  });

  it("collects every error at once", () => {
    const result = validateProviderConfig({
      providerId: "openai",
      baseUrl: "",
      model: "",
    });
    expect(result.ok).toBe(false);
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("invalid_url");
    expect(codes).toContain("model_required");
    expect(codes).toContain("api_key_required");
  });
});

describe("parseProviderConfig", () => {
  it("returns null for non-object input", () => {
    expect(parseProviderConfig(null)).toBeNull();
    expect(parseProviderConfig("ollama")).toBeNull();
    expect(parseProviderConfig(42)).toBeNull();
    expect(parseProviderConfig([1, 2])).toBeNull();
  });

  it("reads the documented field aliases", () => {
    const parsed = parseProviderConfig({
      provider: "ollama",
      url: "http://localhost:11434",
      defaultModel: "llama3.1",
      key: "token",
    });
    expect(parsed).toEqual({
      providerId: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
      apiKey: "token",
    });
  });

  it("backfills the provider default model when none is given", () => {
    const parsed = parseProviderConfig({
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(parsed?.model).toBe(findProvider("openai")?.defaultModel);
    expect(parsed?.apiKey).toBe("");
  });

  it("normalizes a trailing slash and surrounding whitespace", () => {
    const parsed = parseProviderConfig({
      providerId: " vllm ",
      baseUrl: " http://localhost:8000/v1/ ",
      model: " m ",
      apiKey: "  k  ",
    });
    expect(parsed).toEqual({
      providerId: "vllm",
      baseUrl: "http://localhost:8000/v1",
      model: "m",
      apiKey: "k",
    });
  });
});

describe("describeProvider", () => {
  it("names the provider and its posture for a local runtime", () => {
    const text = describeProvider(findProvider("ollama") as ProviderDescriptor);
    expect(text).toContain("Ollama");
    expect(text).toContain("ollama");
    expect(text).toContain("local");
    expect(text).toContain("keyless");
    expect(text).toContain("8,192");
  });

  it("marks a cloud provider as remote and key-requiring", () => {
    const text = describeProvider(findProvider("openai") as ProviderDescriptor);
    expect(text).toContain("cloud");
    expect(text).toContain("API key required");
  });

  it("is deterministic for the same descriptor", () => {
    const provider = descriptor();
    expect(describeProvider(provider)).toBe(describeProvider(provider));
  });
});

describe("pickProvider", () => {
  it("picks the first preferred provider that is available", () => {
    expect(pickProvider(["anthropic", "ollama"], { available: ["ollama", "openai"] })).toEqual({
      id: "ollama",
      source: "preference",
    });
  });

  it("preserves the preference order", () => {
    expect(pickProvider(["ollama", "anthropic"], { available: ["anthropic", "ollama"] })).toEqual({
      id: "ollama",
      source: "preference",
    });
  });

  it("falls back to registry order when no preference is available", () => {
    expect(pickProvider([], { available: ["anthropic", "openai"] })).toEqual({
      id: "openai",
      source: "fallback",
    });
  });

  it("honours an explicit fallback list", () => {
    expect(
      pickProvider(["anthropic"], {
        available: ["ollama", "openai"],
        fallback: ["openai", "ollama"],
      }),
    ).toEqual({ id: "openai", source: "fallback" });
  });

  it("returns null when nothing is available", () => {
    expect(pickProvider(["ollama"], { available: [] })).toBeNull();
  });

  it("defaults to the whole registry when no availability is given", () => {
    expect(pickProvider([], {})).toEqual({ id: PROVIDER_IDS[0], source: "fallback" });
  });

  it("ignores duplicate and blank preferences", () => {
    expect(pickProvider(["", "ollama", "ollama"], { available: ["ollama"] })).toEqual({
      id: "ollama",
      source: "preference",
    });
  });
});

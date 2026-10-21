import { describe, expect, it } from "vitest";
import {
  isOpenCodeGoEndpoint,
  providerDefinition,
  providerForBaseUrl,
  providerDefaultBaseUrl,
  providerModelsUrl,
} from "./ai-providers";

/**
 * Provider inference from a base URL.
 *
 * The case that matters is the one this repo actually runs in: `.env` sets
 * `AI_BASE_URL` (and `AI_MODEL`) with no `AI_PROVIDER`, so the resolved provider is
 * `custom` — whose catalogue is deliberately empty. Unless the host is
 * recognised, the assistant's model picker offers a single entry and nothing to
 * switch to, which is exactly the complaint it exists to answer.
 */
describe("providerForBaseUrl", () => {
  it("recognises the documented endpoints", () => {
    expect(providerForBaseUrl("https://api.deepseek.com")).toBe("deepseek");
    expect(providerForBaseUrl("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(providerForBaseUrl("https://api.openai.com/v1")).toBe("openai");
    expect(providerForBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(
      "gemini",
    );
  });

  it("ignores case, trailing slashes and noise around the URL", () => {
    expect(providerForBaseUrl("  HTTPS://API.DeepSeek.COM/  ")).toBe("deepseek");
    expect(providerForBaseUrl("api.deepseek.com")).toBeNull(); // no scheme: not a URL
  });

  it("recognises a regional subdomain of a documented host", () => {
    expect(providerForBaseUrl("https://eu.api.openai.com/v1")).toBe("openai");
  });

  it("recognises an apex the deployment might have configured instead", () => {
    expect(providerForBaseUrl("https://openai.com/v1")).toBe("openai");
    expect(providerForBaseUrl("https://deepseek.com")).toBe("deepseek");
  });

  it("never matches a look-alike host", () => {
    expect(providerForBaseUrl("https://api.deepseek.com.evil.example/v1")).toBeNull();
    expect(providerForBaseUrl("https://evil.example/api.openai.com")).toBeNull();
    expect(providerForBaseUrl("https://notopenai.com/v1")).toBeNull();
  });

  it("returns null for the empty and unusable cases, rather than a wrong provider", () => {
    expect(providerForBaseUrl("")).toBeNull();
    expect(providerForBaseUrl("   ")).toBeNull();
    expect(providerForBaseUrl(null)).toBeNull();
    expect(providerForBaseUrl(undefined)).toBeNull();
    expect(providerForBaseUrl("not a url")).toBeNull();
    expect(providerForBaseUrl("http://localhost:11434/v1")).toBeNull();
  });

  it("never returns the providerless catalogue entry", () => {
    // `custom` is the fallback *for transport*, not a catalogue to offer.
    expect(providerForBaseUrl("https://api.deepseek.com")).not.toBe("custom");
    expect(providerDefinition("custom")?.models).toEqual([]);
  });
});

describe("providerDefinition", () => {
  it("resolves the catalogue and its default endpoint", () => {
    expect(providerDefinition("deepseek")?.label).toBe("DeepSeek");
    expect(providerDefaultBaseUrl("deepseek")).toBe("https://api.deepseek.com");
  });

  it("is undefined for anything unknown, so callers must handle \"no provider\"", () => {
    expect(providerDefinition("nope")).toBeUndefined();
    expect(providerDefinition("")).toBeUndefined();
    expect(providerDefinition(null)).toBeUndefined();
    expect(providerDefaultBaseUrl("nope")).toBe("");
  });
});

/**
 * OpenCode Go (#271).
 *
 * Go is reached through its OpenAI-compatible surface, so it looks like every
 * other provider — except for the two things it asks its clients for: a user
 * agent of their own and a stable session id. The catalogue is what makes the
 * endpoint reachable at all: without it the picker offers nothing and the
 * model list is asked of the wrong path.
 */
describe("the OpenCode Go provider", () => {
  it("is recognised by its host", () => {
    expect(providerForBaseUrl("https://opencode.ai/inference/go/openai/v1")).toBe("opencode-go");
    expect(providerForBaseUrl("https://opencode.ai/inference/go/openai/v1/")).toBe("opencode-go");
  });

  it("offers the models behind the OpenAI-compatible surface", () => {
    const models = providerDefinition("opencode-go")?.models.map((model) => model.id) ?? [];

    expect(models).toContain("glm-5.3-flash");
    expect(models).toContain("kimi-k3");
    expect(models).toContain("minimax-m3.1-flash-free");
    // The Anthropic, Google and Responses models need a transport Noema does
    // not speak, so they are not offered.
    expect(models).not.toContain("claude-haiku-5-5");
    expect(models).not.toContain("gemini-4-argon-contributor");
    expect(models).not.toContain("grok-4.7");
  });

  it("publishes its catalogue under a path of its own", () => {
    expect(providerModelsUrl("opencode-go", "https://opencode.ai/inference/go/openai/v1")).toBe(
      "https://opencode.ai/inference/go/v1/models",
    );
  });

  it("reads every other catalogue from the base URL's own path", () => {
    expect(providerModelsUrl("openai", "https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(providerModelsUrl("custom", "https://ollama.example/v1")).toBe(
      "https://ollama.example/v1/models",
    );
  });
});

describe("isOpenCodeGoEndpoint", () => {
  it("recognises the Go host and its subdomains", () => {
    expect(isOpenCodeGoEndpoint("https://opencode.ai/inference/go/openai/v1")).toBe(true);
    expect(isOpenCodeGoEndpoint("https://inference.opencode.ai/v1")).toBe(true);
  });

  it("never matches a look-alike host", () => {
    expect(isOpenCodeGoEndpoint("https://opencode.ai.evil.example/v1")).toBe(false);
    expect(isOpenCodeGoEndpoint("https://notopencode.ai/v1")).toBe(false);
    expect(isOpenCodeGoEndpoint("https://api.openai.com/v1")).toBe(false);
  });

  it("is false for anything that is not a URL", () => {
    expect(isOpenCodeGoEndpoint("")).toBe(false);
    expect(isOpenCodeGoEndpoint(null)).toBe(false);
    expect(isOpenCodeGoEndpoint("not a url")).toBe(false);
  });
});

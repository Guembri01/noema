import { describe, expect, it } from "vitest";
import { providerDefinition, providerForBaseUrl, providerDefaultBaseUrl } from "./ai-providers";

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

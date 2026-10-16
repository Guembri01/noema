import { describe, expect, it } from "vitest";

/**
 * Local-provider configuration used by `ai-settings.tsx`. The panel builds its
 * runtime list with `isLocal`, parses the form with `parseProviderConfig`,
 * gates the save on `validateProviderConfig` and renders a summary with
 * `describeProvider`; this pins those exact combinations.
 */

import {
  PROVIDERS,
  describeProvider,
  findProvider,
  isLocal,
  parseProviderConfig,
  validateProviderConfig,
} from "@/lib/local-models";

describe("local runtime list", () => {
  it("offers the self-hosted runtimes and no cloud APIs", () => {
    const local = PROVIDERS.filter((provider) => isLocal(provider)).map((provider) => provider.id);
    expect(local).toEqual(expect.arrayContaining(["ollama", "lmstudio", "llama.cpp", "vllm"]));
    expect(local).not.toContain("openai");
    expect(local).not.toContain("anthropic");
  });
});

describe("endpoint validation", () => {
  it("accepts a keyless loopback endpoint for a local runtime", () => {
    const config = parseProviderConfig({
      providerId: "ollama",
      baseUrl: "http://localhost:11434",
      model: "",
      apiKey: "",
    });
    expect(config).not.toBeNull();
    expect(config?.model).toBe("llama3.1"); // backfilled default
    expect(validateProviderConfig(config).ok).toBe(true);
  });

  it("rejects plain http for a cloud host", () => {
    const config = parseProviderConfig({
      providerId: "openai",
      baseUrl: "http://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "sk-test",
    });
    const codes = validateProviderConfig(config).errors.map((error) => error.code);
    expect(codes).toContain("insecure_url");
  });

  it("requires a key for a keyed provider", () => {
    const config = parseProviderConfig({
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-3-5-sonnet",
      apiKey: "",
    });
    expect(validateProviderConfig(config).errors.map((error) => error.code)).toContain(
      "api_key_required",
    );
  });
});

describe("provider description", () => {
  it("summarizes a local provider in one line", () => {
    const descriptor = findProvider("ollama");
    expect(descriptor).toBeDefined();
    if (!descriptor) return;
    expect(describeProvider(descriptor)).toContain("local");
    expect(describeProvider(descriptor)).toContain("keyless");
  });
});

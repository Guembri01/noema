import { describe, expect, it } from "vitest";
import {
  CHAT_MODEL_PREFERENCE_PREFIX,
  chatModelInfo,
  chatModelLabel,
  chatModelNote,
  chatModelOptions,
  chatModelOverride,
  chatModelPreferenceKey,
  effectiveChatModel,
  readChatModelPreference,
  writeChatModelPreference,
} from "./chat-model";

/**
 * The model contract shared by the server layout, the composer's picker and the
 * streaming route.
 *
 * Two failures this guards against:
 *
 * - a picker that shows a model *and* offers a list that cannot express it
 *   (custom endpoints, models newer than this build);
 * - a session that says "use this model" and is believed — the model id is the
 *   only part of the AI configuration a browser may influence, so it is validated
 *   on both sides of the wire by the same function.
 */
describe("chatModelLabel", () => {
  it("prefers the curated label", () => {
    expect(chatModelLabel("deepseek", "deepseek-flash")).toBe("DeepSeek Flash");
    expect(chatModelLabel("openai", "gpt-4o-mini")).toBe("GPT-4o mini (fast, cheap)");
  });

  it("falls back to the id itself for models the catalogue does not know", () => {
    expect(chatModelLabel("custom", "my-local-model")).toBe("my-local-model");
    expect(chatModelLabel("deepseek", "deepseek-v5-turbo")).toBe("deepseek-v5-turbo");
  });

  it("is empty for an empty model, so the UI can render a real empty state", () => {
    expect(chatModelLabel("openai", "   ")).toBe("");
  });
});

describe("chatModelOptions", () => {
  it("lists the provider's catalogue", () => {
    expect(chatModelOptions("deepseek", "deepseek-chat").map((option) => option.id)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-flash",
    ]);
  });

  it("includes the current model when the catalogue is silent — a custom endpoint", () => {
    expect(chatModelOptions("custom", "llama-3-70b")).toEqual([
      { id: "llama-3-70b", label: "llama-3-70b" },
    ]);
  });

  it("does not duplicate a model the catalogue already lists", () => {
    const options = chatModelOptions("openai", "gpt-4o");
    expect(options.filter((option) => option.id === "gpt-4o")).toHaveLength(1);
  });

  it("offers nothing when nothing is configured", () => {
    expect(chatModelOptions("", "")).toEqual([]);
    expect(chatModelOptions("none", "")).toEqual([]);
  });
});

describe("chatModelInfo", () => {
  it("resolves the provider label from the catalogue", () => {
    const info = chatModelInfo({
      provider: "deepseek",
      model: "deepseek-flash",
      source: "workspace",
    });
    expect(info.providerLabel).toBe("DeepSeek");
    expect(info.model).toBe("deepseek-flash");
    expect(info.options).toHaveLength(3);
  });

  it("recovers the catalogue for a deployment that named only a base URL", () => {
    // The shipped `.env` resolves to `custom`; without the host the picker would
    // offer a single entry (the current model) and nothing to switch to.
    const info = chatModelInfo({
      provider: "custom",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      source: "env",
    });
    expect(info.provider).toBe("deepseek");
    expect(info.providerLabel).toBe("DeepSeek");
    expect(info.options.map((option) => option.id)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-flash",
    ]);
    expect(chatModelLabel(info.provider, info.model)).toBe("DeepSeek Flash");
  });

  it("keeps a custom endpoint custom, offering only the model in use", () => {
    const info = chatModelInfo({
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "llama-3-70b",
      source: "workspace",
    });
    expect(info.provider).toBe("custom");
    expect(info.options).toEqual([{ id: "llama-3-70b", label: "llama-3-70b" }]);
  });

  it("survives an unconfigured workspace without inventing values", () => {
    const info = chatModelInfo({ provider: null, model: null, source: "none" });
    expect(info).toMatchObject({ model: "", provider: "", providerLabel: "", source: "none" });
    expect(info.options).toEqual([]);
  });
});

describe("chatModelNote", () => {
  it("says nothing when the workspace owns an ordinary provider", () => {
    expect(
      chatModelNote({ source: "workspace", options: [{ id: "gpt-4o", label: "GPT-4o" }] }),
    ).toBeNull();
  });

  it("explains an empty list before anything else", () => {
    expect(chatModelNote({ source: "none", options: [] })).toBe("chatModelNotConfigured");
    expect(chatModelNote({ source: "env", options: [] })).toBe("chatModelNotConfigured");
  });

  it("names the environment as the source when choices exist", () => {
    expect(
      chatModelNote({ source: "env", options: [{ id: "deepseek-flash", label: "DeepSeek Flash" }] }),
    ).toBe("chatModelFromEnv");
  });
});

describe("chatModelOverride — the wire boundary", () => {
  it("accepts the ids providers actually use", () => {
    expect(chatModelOverride("deepseek-flash")).toBe("deepseek-flash");
    expect(chatModelOverride("gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(chatModelOverride("openai/gpt-4o")).toBe("openai/gpt-4o");
    expect(chatModelOverride("accounts/fireworks/models/llama-v3")).toBe(
      "accounts/fireworks/models/llama-v3",
    );
    expect(chatModelOverride("  gpt-4o  ")).toBe("gpt-4o");
  });

  it("refuses anything that is not a bare model id", () => {
    // Empty, whitespace, and a newline that would split a header if it travelled.
    expect(chatModelOverride("")).toBeNull();
    expect(chatModelOverride("   ")).toBeNull();
    expect(chatModelOverride("gpt-4o\nX-Injected: 1")).toBeNull();
    // No scheme, no host, no query: a model id cannot become another endpoint.
    expect(chatModelOverride("https://evil.example/v1")).toBeNull();
    expect(chatModelOverride("javascript:alert(1)")).toBeNull();
    expect(chatModelOverride("gpt-4o?url=http://evil")).toBeNull();
    expect(chatModelOverride("../../etc/passwd")).toBeNull();
    expect(chatModelOverride("model with spaces")).toBeNull();
    expect(chatModelOverride("-leading-dash")).toBeNull();
  });

  it("refuses non-strings and over-long ids", () => {
    expect(chatModelOverride(null)).toBeNull();
    expect(chatModelOverride(undefined)).toBeNull();
    expect(chatModelOverride(42)).toBeNull();
    expect(chatModelOverride({ id: "gpt-4o" })).toBeNull();
    expect(chatModelOverride(["gpt-4o"])).toBeNull();
    expect(chatModelOverride("a".repeat(120))).toBe("a".repeat(120));
    expect(chatModelOverride("a".repeat(121))).toBeNull();
  });
});

describe("effectiveChatModel", () => {
  it("uses the chosen model when it is well-formed", () => {
    expect(effectiveChatModel("deepseek-flash", "deepseek-chat")).toBe("deepseek-chat");
  });

  it("falls back to the configured model for a missing or unusable choice", () => {
    expect(effectiveChatModel("deepseek-flash", undefined)).toBe("deepseek-flash");
    expect(effectiveChatModel("deepseek-flash", null)).toBe("deepseek-flash");
    expect(effectiveChatModel("deepseek-flash", "https://evil.example")).toBe("deepseek-flash");
    expect(effectiveChatModel("  deepseek-flash  ", "")).toBe("deepseek-flash");
  });
});

/** A `localStorage` stand-in: only the two methods the preference needs. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    dump: () => data,
  };
}

describe("remembering the choice", () => {
  it("namespaces the key per workspace, so two workspaces keep two choices", () => {
    expect(chatModelPreferenceKey("ws_1")).toBe(`${CHAT_MODEL_PREFERENCE_PREFIX}ws_1`);
    expect(chatModelPreferenceKey("ws_1")).not.toBe(chatModelPreferenceKey("ws_2"));
  });

  it("round-trips a choice", () => {
    const storage = fakeStorage();
    writeChatModelPreference(storage, "ws_1", "deepseek-reasoner");
    expect(readChatModelPreference(storage, "ws_1")).toBe("deepseek-reasoner");
  });

  it("reads nothing when there is no choice, and keeps workspaces apart", () => {
    const storage = fakeStorage();
    expect(readChatModelPreference(storage, "ws_1")).toBeNull();
    writeChatModelPreference(storage, "ws_1", "gpt-4o");
    expect(readChatModelPreference(storage, "ws_2")).toBeNull();
  });

  it("ignores an unusable value instead of storing it", () => {
    const storage = fakeStorage();
    writeChatModelPreference(storage, "ws_1", "https://evil.example");
    expect(storage.dump()).toEqual({});
    expect(readChatModelPreference(storage, "ws_1")).toBeNull();
  });

  it("ignores a corrupted entry written by an older build", () => {
    const storage = fakeStorage({ [chatModelPreferenceKey("ws_1")]: "model with spaces" });
    expect(readChatModelPreference(storage, "ws_1")).toBeNull();
  });

  it("survives storage being unavailable or throwing (Safari private mode)", () => {
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readChatModelPreference(null, "ws_1")).toBeNull();
    expect(readChatModelPreference(hostile, "ws_1")).toBeNull();
    expect(() => writeChatModelPreference(hostile, "ws_1", "gpt-4o")).not.toThrow();
    expect(() => writeChatModelPreference(null, "ws_1", "gpt-4o")).not.toThrow();
  });
});

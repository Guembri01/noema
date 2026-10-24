import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R25.8 + D3 — keyless local providers and workspace → env precedence.
 *
 * `resolveAiConfig` must accept a local workspace row with no key, while a
 * remote workspace row without a key is not ready and falls through to the
 * environment defaults. `resolveAiConfigForUser` keeps the B13 access gate in
 * front of that resolution.
 */

const db = vi.hoisted(() => ({
  aiProviderConfig: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

import {
  providerRequestHeaders,
  resolveAiConfig,
  resolveAiConfigForUser,
} from "@/lib/ai-provider";
import { encryptSecret } from "@/lib/secrets";

const WORKSPACE_ID = "clx1a2b3c4d5e6f7g8h9i0jkl";

const ENV_KEYS = [
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AUTH_SECRET",
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function storedLocal(apiKeyEncrypted: string | null = null) {
  return {
    provider: "custom",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
    apiKeyEncrypted,
    enabled: true,
  };
}

function storedRemote(apiKeyEncrypted: string | null) {
  return {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyEncrypted,
    enabled: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret-for-the-ai-route-suite";
  delete process.env.AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_BASE_URL;
  delete process.env.AI_MODEL;
  db.aiProviderConfig.findUnique.mockResolvedValue(null);
  db.workspaceMember.findUnique.mockResolvedValue(null);
  db.workspace.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveAiConfig — keyless local workspace", () => {
  it("resolves an enabled local workspace row without a key", async () => {
    db.aiProviderConfig.findUnique.mockResolvedValue(storedLocal());

    const config = await resolveAiConfig(WORKSPACE_ID);

    expect(config?.source).toBe("workspace");
    expect(config?.workspaceId).toBe(WORKSPACE_ID);
    expect(config?.apiKey).toBe("");
    expect(config?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("resolves a local workspace row with an encrypted optional token", async () => {
    db.aiProviderConfig.findUnique.mockResolvedValue(storedLocal(encryptSecret("local-token")));

    const config = await resolveAiConfig(WORKSPACE_ID);

    expect(config?.source).toBe("workspace");
    expect(config?.apiKey).toBe("local-token");
  });
});

describe("resolveAiConfig — remote readiness and precedence", () => {
  it("does not treat a keyless remote workspace as ready", async () => {
    process.env.AI_API_KEY = "env-key";
    process.env.AI_BASE_URL = "https://env.example/v1";
    process.env.AI_MODEL = "env-model";
    db.aiProviderConfig.findUnique.mockResolvedValue(storedRemote(null));

    const config = await resolveAiConfig(WORKSPACE_ID);

    expect(config?.source).toBe("env");
    expect(config?.apiKey).toBe("env-key");
    expect(config?.baseUrl).toBe("https://env.example/v1");
  });

  it("prefers a working local workspace over the env defaults", async () => {
    process.env.AI_API_KEY = "env-key";
    process.env.AI_BASE_URL = "https://env.example/v1";
    process.env.AI_MODEL = "env-model";
    db.aiProviderConfig.findUnique.mockResolvedValue(storedLocal());

    const config = await resolveAiConfig(WORKSPACE_ID);

    expect(config?.source).toBe("workspace");
    expect(config?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("falls back to env when the local row is disabled", async () => {
    process.env.AI_API_KEY = "env-key";
    process.env.AI_BASE_URL = "https://env.example/v1";
    process.env.AI_MODEL = "env-model";
    db.aiProviderConfig.findUnique.mockResolvedValue({ ...storedLocal(), enabled: false });

    const config = await resolveAiConfig(WORKSPACE_ID);

    expect(config?.source).toBe("env");
  });

  it("falls back to env when the local row has no model", async () => {
    process.env.AI_API_KEY = "env-key";
    process.env.AI_BASE_URL = "https://env.example/v1";
    process.env.AI_MODEL = "env-model";
    db.aiProviderConfig.findUnique.mockResolvedValue({ ...storedLocal(), model: null });

    const config = await resolveAiConfig(WORKSPACE_ID);

    expect(config?.source).toBe("env");
  });
});

describe("resolveAiConfig — environment keyless local", () => {
  it("accepts a keyless local env endpoint", async () => {
    process.env.AI_BASE_URL = "http://localhost:11434/v1";
    process.env.AI_MODEL = "llama3.1";

    const config = await resolveAiConfig();

    expect(config?.source).toBe("env");
    expect(config?.apiKey).toBe("");
    expect(config?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("still refuses a keyless remote env endpoint", async () => {
    process.env.AI_BASE_URL = "https://api.example.com/v1";
    process.env.AI_MODEL = "gpt-4o-mini";

    expect(await resolveAiConfig()).toBeNull();
  });
});

describe("resolveAiConfigForUser — access before local precedence", () => {
  it("uses the workspace local config for a member", async () => {
    db.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedLocal());

    const config = await resolveAiConfigForUser("u1", WORKSPACE_ID);

    expect(config?.source).toBe("workspace");
    expect(config?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("never uses another workspace's local provider", async () => {
    process.env.AI_API_KEY = "env-key";
    process.env.AI_BASE_URL = "https://env.example/v1";
    process.env.AI_MODEL = "env-model";
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue({ ownerId: "someone-else" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedLocal());

    const config = await resolveAiConfigForUser("u1", WORKSPACE_ID);

    expect(config?.source).toBe("env");
    expect(db.aiProviderConfig.findUnique).not.toHaveBeenCalled();
  });
});

describe("providerRequestHeaders — keyless requests", () => {
  it("omits Authorization when there is no key", () => {
    const headers = providerRequestHeaders({
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
    });

    expect(headers.authorization).toBeUndefined();
    expect(headers["user-agent"]).toMatch(/^noema\//);
  });

  it("keeps Authorization when a key is present", () => {
    const headers = providerRequestHeaders({
      apiKey: "sk-live",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(headers.authorization).toBe("Bearer sk-live");
  });
});

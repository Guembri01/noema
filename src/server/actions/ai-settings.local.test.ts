import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R25.8 — save/test/enable a keyless local provider, never weaken a remote one.
 *
 * The auth, permission, database and transport edges are mocked; the action's
 * URL validation, key policy and encryption run for real.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const permissions = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canManageMembers: vi.fn(),
}));
const db = vi.hoisted(() => ({
  prisma: {
    aiProviderConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));
const ai = vi.hoisted(() => ({
  chatComplete: vi.fn(),
  listProviderModels: vi.fn(),
  resolveAiConfig: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: permissions.getWorkspaceAccess,
  canManageMembers: permissions.canManageMembers,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ai-provider", () => ({
  chatComplete: ai.chatComplete,
  listProviderModels: ai.listProviderModels,
  resolveAiConfig: ai.resolveAiConfig,
}));

import {
  getAiProviderSummary,
  listAiModelsAction,
  saveAiProviderAction,
  testAiProviderAction,
} from "@/server/actions/ai-settings";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

const WORKSPACE_ID = "clx1a2b3c4d5e6f7g8h9i0jkl";
const AUTH_SECRET = "test-secret-for-the-ai-route-suite";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = AUTH_SECRET;
  auth.requireUser.mockResolvedValue({ id: "u1" });
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "OWNER" });
  permissions.canManageMembers.mockReturnValue(true);
  db.prisma.aiProviderConfig.findUnique.mockResolvedValue(null);
  db.prisma.aiProviderConfig.upsert.mockResolvedValue({});
  ai.chatComplete.mockResolvedValue({ ok: true, text: "OK" });
  ai.listProviderModels.mockResolvedValue({ ok: true, models: ["llama3.1"] });
});

afterEach(() => {
  delete process.env.AUTH_SECRET;
  vi.unstubAllGlobals();
});

describe("saveAiProviderAction — keyless local endpoints", () => {
  it("saves and enables a loopback endpoint without an API key", async () => {
    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.1",
      enabled: true,
    });

    expect(result).toEqual({ ok: true });
    expect(db.prisma.aiProviderConfig.upsert).toHaveBeenCalledTimes(1);
    const create = db.prisma.aiProviderConfig.upsert.mock.calls[0]?.[0]?.create;
    expect(create.apiKeyEncrypted).toBeNull();
    expect(create.enabled).toBe(true);
    expect(create.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("saves a private RFC1918 endpoint keylessly", async () => {
    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "http://192.168.1.20:8000/v1",
      model: "local-model",
      enabled: true,
    });

    expect(result).toEqual({ ok: true });
  });

  it("encrypts a local token when one is supplied", async () => {
    await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.1",
      apiKey: "local-token",
      enabled: true,
    });

    const create = db.prisma.aiProviderConfig.upsert.mock.calls[0]?.[0]?.create;
    expect(create.apiKeyEncrypted).not.toBe("local-token");
    expect(decryptSecret(create.apiKeyEncrypted)).toBe("local-token");
  });

  it("does not carry a stored remote key onto a local endpoint", async () => {
    db.prisma.aiProviderConfig.findUnique.mockResolvedValue({
      provider: "custom",
      baseUrl: "https://remote.example/v1",
      apiKeyEncrypted: encryptSecret("sk-remote"),
    });

    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.1",
      enabled: true,
    });

    expect(result).toEqual({ ok: true });
    const update = db.prisma.aiProviderConfig.upsert.mock.calls[0]?.[0]?.update;
    expect(update.apiKeyEncrypted).toBeNull();
  });
});

describe("saveAiProviderAction — remote endpoints keep the key requirement", () => {
  it("refuses to enable a remote provider without a key", async () => {
    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      enabled: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatch(/API key/i);
    expect(db.prisma.aiProviderConfig.upsert).not.toHaveBeenCalled();
  });

  it("refuses a public custom endpoint without a key", async () => {
    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      enabled: true,
    });

    expect(result.ok).toBe(false);
    expect(db.prisma.aiProviderConfig.upsert).not.toHaveBeenCalled();
  });

  it("preserves a stored key for the same remote provider", async () => {
    const encrypted = encryptSecret("sk-stored");
    db.prisma.aiProviderConfig.findUnique.mockResolvedValue({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEncrypted: encrypted,
    });

    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      enabled: true,
    });

    expect(result).toEqual({ ok: true });
    const update = db.prisma.aiProviderConfig.upsert.mock.calls[0]?.[0]?.update;
    expect(update.apiKeyEncrypted).toBe(encrypted);
  });

  it("stores a new key encrypted, never in plain text", async () => {
    await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-new",
      enabled: true,
    });

    const create = db.prisma.aiProviderConfig.upsert.mock.calls[0]?.[0]?.create;
    expect(create.apiKeyEncrypted).not.toBe("sk-new");
    expect(create.apiKeyEncrypted).not.toContain("sk-new");
    expect(decryptSecret(create.apiKeyEncrypted)).toBe("sk-new");
  });

  it("allows saving a disabled remote provider without a key", async () => {
    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      enabled: false,
    });

    expect(result).toEqual({ ok: true });
  });
});

describe("saveAiProviderAction — URL safety", () => {
  it("refuses a non-http endpoint", async () => {
    for (const baseUrl of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)"]) {
      const result = await saveAiProviderAction({
        workspaceId: WORKSPACE_ID,
        provider: "custom",
        baseUrl,
        model: "m",
        enabled: true,
      });
      expect(result.ok, baseUrl).toBe(false);
    }
    expect(db.prisma.aiProviderConfig.upsert).not.toHaveBeenCalled();
  });

  it("refuses credentials embedded in the URL", async () => {
    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "https://user:pass@example.com/v1",
      model: "m",
      enabled: true,
    });

    expect(result.ok).toBe(false);
    expect(db.prisma.aiProviderConfig.upsert).not.toHaveBeenCalled();
  });

  it("refuses plain http for a public host", async () => {
    const result = await saveAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "http://example.com/v1",
      model: "m",
      apiKey: "sk-key",
      enabled: true,
    });

    expect(result.ok).toBe(false);
    expect(db.prisma.aiProviderConfig.upsert).not.toHaveBeenCalled();
  });
});

describe("testAiProviderAction", () => {
  it("tests a keyless local endpoint without inventing a placeholder key", async () => {
    const result = await testAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.1",
    });

    expect(result.ok).toBe(true);
    const config = ai.chatComplete.mock.calls[0]?.[1] as { apiKey: string; baseUrl: string };
    expect(config.apiKey).toBe("");
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("still requires a key for a remote endpoint", async () => {
    const result = await testAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    expect(result.ok).toBe(false);
    expect(ai.chatComplete).not.toHaveBeenCalled();
  });

  it("validates the endpoint before calling the provider", async () => {
    const result = await testAiProviderAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "file:///etc/passwd",
      model: "m",
    });

    expect(result.ok).toBe(false);
    expect(ai.chatComplete).not.toHaveBeenCalled();
  });
});

describe("getAiProviderSummary — local/remote state for the UI", () => {
  it("reports a keyless local workspace as ready and local-only", async () => {
    db.prisma.aiProviderConfig.findUnique.mockResolvedValue({
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.1",
      apiKeyEncrypted: null,
      enabled: true,
    });

    const summary = await getAiProviderSummary(WORKSPACE_ID);

    expect(summary?.source).toBe("workspace");
    expect(summary?.local).toBe(true);
    expect(summary?.keyless).toBe(true);
    expect(summary?.requiresKey).toBe(false);
    expect(summary?.processing).toBe("local");
    expect(summary?.endpointError).toBeNull();
  });

  it("reports a keyless remote row as not ready", async () => {
    db.prisma.aiProviderConfig.findUnique.mockResolvedValue({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyEncrypted: null,
      enabled: true,
    });

    const summary = await getAiProviderSummary(WORKSPACE_ID);

    expect(summary?.source).not.toBe("workspace");
    expect(summary?.local).toBe(false);
    expect(summary?.keyless).toBe(false);
    expect(summary?.requiresKey).toBe(true);
    expect(summary?.processing).toBe("none");
  });
});

describe("listAiModelsAction", () => {
  it("lists models of a keyless local endpoint", async () => {
    const result = await listAiModelsAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "http://localhost:11434/v1",
    });

    expect(result.ok).toBe(true);
    expect(ai.listProviderModels).toHaveBeenCalledTimes(1);
    const config = ai.listProviderModels.mock.calls[0]?.[0] as { apiKey: string };
    expect(config.apiKey).toBe("");
  });

  it("still asks for a key for a remote endpoint with no catalogue", async () => {
    const result = await listAiModelsAction({
      workspaceId: WORKSPACE_ID,
      provider: "custom",
      baseUrl: "https://api.example.com/v1",
    });

    expect(result.ok).toBe(false);
    expect(ai.listProviderModels).not.toHaveBeenCalled();
  });
});

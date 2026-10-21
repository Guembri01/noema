import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B13: a workspace's provider config belongs to that workspace.
 *
 * `resolveAiConfigForUser` is the only sanctioned way to turn a workspace id
 * into a provider config: the workspace's own endpoint/key are used only when
 * the caller has access to that workspace. Without access the environment
 * defaults apply and the foreign provider row is never even read.
 *
 * The database is mocked; the membership check and the config resolution run
 * for real.
 */

const db = vi.hoisted(() => ({
  aiProviderConfig: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

import { resolveAiConfigForUser } from "@/lib/ai-provider";
import { encryptSecret } from "@/lib/secrets";

/** A workspace id in the shape Prisma's `cuid()` produces. */
const WORKSPACE_ID = "clx1a2b3c4d5e6f7g8h9i0jkl";

/** The stored provider of the workspace the caller is not a member of. */
function storedProvider(apiKey: string) {
  return {
    provider: "openai",
    baseUrl: "https://foreign.example/v1",
    model: "gpt-4o",
    apiKeyEncrypted: encryptSecret(apiKey),
    enabled: true,
  };
}

const ENV_KEYS = [
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AUTH_SECRET",
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret-for-the-ai-workspace-suite";
  process.env.AI_API_KEY = "env-key";
  process.env.AI_BASE_URL = "https://env.example/v1";
  process.env.AI_MODEL = "env-model";
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

describe("resolveAiConfigForUser — a member uses the workspace's own provider", () => {
  it("resolves the workspace config for a member", async () => {
    db.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-workspace"));

    const config = await resolveAiConfigForUser("u1", WORKSPACE_ID);

    expect(config?.source).toBe("workspace");
    expect(config?.workspaceId).toBe(WORKSPACE_ID);
    expect(config?.apiKey).toBe("sk-workspace");
    expect(config?.baseUrl).toBe("https://foreign.example/v1");
  });

  it("resolves the workspace config for the owner", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue({ ownerId: "u1" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-workspace"));

    const config = await resolveAiConfigForUser("u1", WORKSPACE_ID);

    expect(config?.source).toBe("workspace");
    expect(config?.apiKey).toBe("sk-workspace");
  });
});

describe("resolveAiConfigForUser — no access means no workspace provider", () => {
  it("falls back to the environment config for a non-member", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue({ ownerId: "someone-else" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-foreign"));

    const config = await resolveAiConfigForUser("u1", WORKSPACE_ID);

    expect(config?.source).toBe("env");
    expect(config?.apiKey).toBe("env-key");
    expect(config?.baseUrl).toBe("https://env.example/v1");
    expect(config?.workspaceId).toBeUndefined();
  });

  it("never reads the provider row of a workspace the caller cannot access", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue({ ownerId: "someone-else" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-foreign"));

    await resolveAiConfigForUser("u1", WORKSPACE_ID);

    expect(db.aiProviderConfig.findUnique).not.toHaveBeenCalled();
  });

  it("does not resolve a workspace provider for an unknown workspace", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue(null);
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-foreign"));

    const config = await resolveAiConfigForUser("u1", WORKSPACE_ID);

    expect(config?.source).toBe("env");
    expect(db.aiProviderConfig.findUnique).not.toHaveBeenCalled();
  });
});

describe("resolveAiConfigForUser — without a workspace", () => {
  it("uses the environment config and skips the membership lookup", async () => {
    const config = await resolveAiConfigForUser("u1");

    expect(config?.source).toBe("env");
    expect(config?.apiKey).toBe("env-key");
    expect(db.workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(db.aiProviderConfig.findUnique).not.toHaveBeenCalled();
  });
});

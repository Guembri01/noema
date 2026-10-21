import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B13: `/api/ai` must not resolve another workspace's provider.
 *
 * (Its own file: the AI route test of B87 covers the guest scope of the
 * grounding search in the same route, and two `vi.mock` blocks for one
 * module cannot live in one file.)
 *
 * A workspace's stored provider (endpoint + decrypted API key) belongs to
 * that workspace, so a client-supplied `workspaceId` may only select it when
 * the caller has access to that workspace. The route resolves the config
 * through `resolveAiConfigForUser`; without access the environment defaults
 * apply and the foreign provider row is never read.
 *
 * The database and the provider transport are mocked; the body validation,
 * the membership check and the config resolution run for real.
 */

const db = vi.hoisted(() => ({
  aiProviderConfig: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const queries = vi.hoisted(() => ({ searchPagesForPrompt: vi.fn() }));
const ai = vi.hoisted(() => ({ chatComplete: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));
vi.mock("@/server/queries", () => ({
  searchPagesForPrompt: queries.searchPagesForPrompt,
}));
vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return { ...actual, chatComplete: ai.chatComplete };
});

import { POST } from "./route";
import { encryptSecret } from "@/lib/secrets";

/** A workspace id in the shape Prisma's `cuid()` produces. */
const WORKSPACE_ID = "clx1a2b3c4d5e6f7g8h9i0jkl";

/** The provider stored for the workspace the caller does not belong to. */
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

const ask = (body: unknown) =>
  POST(
    new Request("http://test/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  // `encryptSecret()` now goes through the 32-character AUTH_SECRET rule; a
  // short fixture would throw before the route ever sees the request.
  process.env.AUTH_SECRET =
    "9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e";
  process.env.AI_API_KEY = "env-key";
  process.env.AI_BASE_URL = "https://env.example/v1";
  process.env.AI_MODEL = "env-model";
  auth.getCurrentUser.mockResolvedValue({ id: "u1" });
  guard.rateLimit.mockReturnValue(null);
  queries.searchPagesForPrompt.mockResolvedValue([]);
  ai.chatComplete.mockResolvedValue({ ok: true, text: "ANSWER" });
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

describe("authentication and validation", () => {
  it("rejects an unauthenticated request", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    expect((await ask({ prompt: "hi" })).status).toBe(401);
  });

  it("rejects a body that does not match the schema", async () => {
    expect((await ask({ prompt: "hi", mode: "translate" })).status).toBe(400);
  });

  it("lets the access check answer a workspace id it does not know", async () => {
    // The id format is not enforced by the schema: a foreign or malformed id
    // is answered by the access check, not by a 400.
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue(null);

    const response = await ask({ prompt: "hi", workspaceId: "not-a-cuid" });

    expect(response.status).toBe(200);
    expect(ai.chatComplete).toHaveBeenCalled();
    expect(db.aiProviderConfig.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a missing prompt", async () => {
    expect((await ask({})).status).toBe(400);
  });

  it("reads a null workspace id as 'no workspace'", async () => {
    expect((await ask({ prompt: "hi", workspaceId: null })).status).toBe(200);
  });
});

describe("workspace scoping of the provider config", () => {
  it("does not use the provider of a workspace the caller has no access to", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue({ ownerId: "someone-else" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-foreign"));

    const response = await ask({ prompt: "hi", workspaceId: WORKSPACE_ID });

    expect(response.status).toBe(200);
    const config = ai.chatComplete.mock.calls[0]?.[1] as { apiKey: string; source: string };
    expect(config.apiKey).toBe("env-key");
    expect(config.source).toBe("env");
    // The foreign provider row is never even read.
    expect(db.aiProviderConfig.findUnique).not.toHaveBeenCalled();
  });

  it("does not ground the answer in a workspace the caller has no access to", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue({ ownerId: "someone-else" });

    await ask({ prompt: "hi", workspaceId: WORKSPACE_ID });

    expect(queries.searchPagesForPrompt).not.toHaveBeenCalled();
  });

  it("uses the workspace's own provider for a member", async () => {
    db.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-workspace"));

    const response = await ask({ prompt: "hi", workspaceId: WORKSPACE_ID });

    expect(response.status).toBe(200);
    const config = ai.chatComplete.mock.calls[0]?.[1] as { apiKey: string; source: string };
    expect(config.apiKey).toBe("sk-workspace");
    expect(config.source).toBe("workspace");
  });

  it("reports AI as unconfigured with 503", async () => {
    delete process.env.AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect((await ask({ prompt: "hi" })).status).toBe(503);
  });
});

describe("long bodies are trimmed, not refused", () => {
  it("trims a long prompt instead of rejecting the body", async () => {
    const response = await ask({ prompt: "x".repeat(50_000) });

    expect(response.status).toBe(200);
    const input = ai.chatComplete.mock.calls[0]?.[0] as { user?: string };
    expect(input.user?.length).toBe(4000);
  });
});

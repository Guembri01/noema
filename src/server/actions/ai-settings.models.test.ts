import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The model list of a provider (#271).
 *
 * OpenCode Go publishes its catalogue under `/inference/go/v1/models` while
 * its chat endpoint lives under `/inference/go/openai/v1` — asking the chat
 * endpoint's path for the catalogue answers 404, so "Fetch models" would come
 * back empty for a provider that does have a catalogue.
 *
 * A "custom" endpoint that is really a documented provider must keep that
 * provider's catalogue — the admin may well have typed the Go URL by hand.
 *
 * The transport edges are mocked; the provider client runs for real.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const permissions = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canManageMembers: vi.fn(),
}));
const db = vi.hoisted(() => ({
  prisma: { aiProviderConfig: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: permissions.getWorkspaceAccess,
  canManageMembers: permissions.canManageMembers,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { listAiModelsAction } from "@/server/actions/ai-settings";

/** The URL the provider was asked for. */
function askedUrl(): string {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return String(calls[calls.length - 1]?.[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1" });
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "OWNER" });
  permissions.canManageMembers.mockReturnValue(true);
  db.prisma.aiProviderConfig.findUnique.mockResolvedValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "glm-5.3-flash" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listAiModelsAction", () => {
  it("asks Go for its catalogue under its own path", async () => {
    const result = await listAiModelsAction({
      workspaceId: "ws-1",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      apiKey: "sk-go",
    });

    expect(result.ok).toBe(true);
    expect(askedUrl()).toBe("https://opencode.ai/inference/go/v1/models");
  });

  it("keeps Go's catalogue for an endpoint that was typed by hand", async () => {
    const result = await listAiModelsAction({
      workspaceId: "ws-1",
      provider: "custom",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      apiKey: "sk-go",
    });

    expect(result.ok).toBe(true);
    expect(askedUrl()).toBe("https://opencode.ai/inference/go/v1/models");
    // The curated models come with it, so the picker is not empty even when
    // the live list is thin.
    if (!result.ok) throw new Error("expected models");
    expect(result.models).toContain("glm-5.3-flash");
  });

  it("asks every other provider at its own path", async () => {
    await listAiModelsAction({
      workspaceId: "ws-1",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai",
    });

    expect(askedUrl()).toBe("https://api.openai.com/v1/models");
  });
});

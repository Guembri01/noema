import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * The decisive B19 test: does the workspace's provider key ever reach a client?
 *
 * OpenAI-compatible gateways (vLLM, LiteLLM, Ollama, Azure API Management)
 * answer a bad key with an error body that *contains* the key:
 *
 *   {"error":{"message":"Incorrect API key provided: sk-live-…","code":"invalid_api_key"}}
 *
 * This file drives all four AI surfaces with such a provider and asserts that
 * the key appears in none of the answers — not in `/api/ai`, not in
 * `/api/ai/skills`, not in `/api/ai/transcribe`, and not in the in-band error
 * of `/api/chat/stream`. The provider client runs for real (only `fetch` is
 * stubbed); the transport edges — auth, rate limiting, the database and the
 * workspace lookups — are mocked.
 */

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), requireUser: vi.fn() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const permissions = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canEditContent: vi.fn(),
  canManageMembers: vi.fn(),
}));
const queries = vi.hoisted(() => ({ searchPagesForPrompt: vi.fn() }));
const runtime = vi.hoisted(() => ({ buildChatRequest: vi.fn() }));
const actions = vi.hoisted(() => ({ planChatAction: vi.fn() }));
const db = vi.hoisted(() => ({
  prisma: {
    aiProviderConfig: { findUnique: vi.fn() },
    chatThread: { findUnique: vi.fn(), update: vi.fn() },
    chatMessage: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: auth.getCurrentUser,
  requireUser: auth.requireUser,
}));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: permissions.getWorkspaceAccess,
  canEditContent: permissions.canEditContent,
  canManageMembers: permissions.canManageMembers,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/queries", () => ({
  searchPagesForPrompt: queries.searchPagesForPrompt,
}));
vi.mock("@/lib/chat-runtime", () => ({
  buildChatRequest: runtime.buildChatRequest,
}));
vi.mock("@/lib/chat-actions", () => ({
  planChatAction: actions.planChatAction,
  proposalBody: () => "",
  proposalLabel: () => "",
}));
vi.mock("@/server/actions/chat", () => ({
  executeChatActionAction: vi.fn(),
}));

import { POST as aiPost } from "./ai/route";
import { POST as skillsPost } from "./ai/skills/route";
import { POST as streamPost } from "./chat/stream/route";
import { listAiModelsAction } from "@/server/actions/ai-settings";

/** The key the workspace sent to the provider — the thing that must not leak. */
const API_KEY = "sk-live-abcdef1234567890";

/** A provider body that echoes the key back, the way a gateway does. */
const LEAKY_BODY = JSON.stringify({
  error: {
    message: `Incorrect API key provided: ${API_KEY}. You can find your API key at https://example.invalid/keys.`,
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
});

/** The provider's answer: 401 with the key in the body. */
function providerError(): Response {
  return new Response(LEAKY_BODY, {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

const jsonRequest = (url: string, body: unknown) =>
  new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * The transcription route reads its key at module scope, so the module is
 * re-imported after the environment has been stubbed.
 */
async function loadTranscribePost() {
  vi.resetModules();
  vi.stubEnv("AI_TRANSCRIBE_API_KEY", API_KEY);
  const mod = await import("./ai/transcribe/route");
  return mod.POST;
}

function transcriptionRequest(): Request {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array([1, 2, 3])], "clip.wav", { type: "audio/wav" }),
  );
  return new Request("http://test/api/ai/transcribe", {
    method: "POST",
    body: form,
  });
}

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AI_API_KEY", API_KEY);
  vi.stubEnv("AI_BASE_URL", "http://localhost:1/v1");
  vi.stubEnv("AI_MODEL", "gpt-4o-mini");
  auth.getCurrentUser.mockResolvedValue({ id: "u1" });
  auth.requireUser.mockResolvedValue({ id: "u1" });
  guard.rateLimit.mockReturnValue(null);
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "OWNER" });
  permissions.canEditContent.mockReturnValue(true);
  permissions.canManageMembers.mockReturnValue(true);
  queries.searchPagesForPrompt.mockResolvedValue([]);
  actions.planChatAction.mockResolvedValue(null);
  runtime.buildChatRequest.mockResolvedValue({
    system: "s",
    context: undefined,
    user: "hello",
    intel: { intents: [], context: "", references: [], activity: [] },
  });
  db.prisma.aiProviderConfig.findUnique.mockResolvedValue(null);
  db.prisma.chatThread.findUnique.mockResolvedValue({
    id: "t1",
    workspaceId: "ws-1",
    pageId: null,
    title: "Discussion",
    _count: { messages: 1 },
  });
  db.prisma.chatThread.update.mockResolvedValue(undefined);
  db.prisma.chatMessage.create.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => providerError()));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

describe("the workspace key never reaches a client", () => {
  it("stays out of the /api/ai answer", async () => {
    const response = await aiPost(
      jsonRequest("/api/ai", { prompt: "hello" }),
    );
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain("Incorrect API key provided");
    expect(JSON.parse(raw)).toEqual({
      error: "AI provider error (401): invalid_api_key",
    });
  });

  it("stays out of the /api/ai/skills answer", async () => {
    const response = await skillsPost(
      jsonRequest("/api/ai/skills", { skillId: "proofread", text: "teh fox" }),
    );
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain("Incorrect API key provided");
    expect(JSON.parse(raw)).toEqual({
      error: "AI provider error (401): invalid_api_key",
    });
  });

  it("stays out of the /api/ai/transcribe answer", async () => {
    const POST = await loadTranscribePost();
    const response = await POST(transcriptionRequest());
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain("Incorrect API key provided");
    expect(JSON.parse(raw)).toEqual({
      error: "Transcription failed (401): invalid_api_key",
    });
  });

  it("stays out of the /api/chat/stream in-band error", async () => {
    const response = await streamPost(
      jsonRequest("/api/chat/stream", { threadId: "t1", body: "hello" }),
    );
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain("Incorrect API key provided");
    expect(raw).toContain("[stream-error] AI provider error (401): invalid_api_key");

    // The same text is persisted as the assistant's answer — the key must not
    // be in the database either.
    const persisted = db.prisma.chatMessage.create.mock.calls
      .map((call) => JSON.stringify(call))
      .join("\n");
    expect(persisted).not.toContain(API_KEY);
  });

  it("stays out of the model-list answer", async () => {
    // The runtime rejects an invalid header value with the *whole* header in
    // its message — the key we sent included:
    //   Headers.append: "Bearer <key>" is an invalid header value.
    const key = "sk-live-abc\ndef";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          `Headers.append: "Bearer ${key}" is an invalid header value.`,
        );
      }),
    );

    // A custom provider has no curated catalogue, so the live error is what
    // the admin gets to see.
    const result = await listAiModelsAction({
      workspaceId: "ws-1",
      provider: "custom",
      baseUrl: "http://localhost:1/v1",
      apiKey: key,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).not.toContain("sk-live-abc");
    expect(result.error).not.toContain("def");
  });

  it("stays out of the server-side log", async () => {
    await aiPost(jsonRequest("/api/ai", { prompt: "hello" }));
    await skillsPost(
      jsonRequest("/api/ai/skills", { skillId: "proofread", text: "teh fox" }),
    );
    const transcribe = await loadTranscribePost();
    await transcribe(transcriptionRequest());
    await streamPost(
      jsonRequest("/api/chat/stream", { threadId: "t1", body: "hello" }),
    );

    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain("Incorrect API key provided");
  });
});

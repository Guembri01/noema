import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * The streamed chat answer must not carry the workspace's key (B19).
 *
 * A transport failure is untrusted text: the runtime reports an invalid header
 * value with the *whole* header in its message, and that header is the
 * `Authorization` header the request was sent with — it carries the key. The
 * failure travels in-band *and* into the persisted assistant row, so both must
 * carry a class instead of the runtime's text.
 *
 * The transport edges — auth, rate limiting, the database and the workspace
 * lookups — are mocked; the provider client and the route's own error
 * handling run for real.
 */

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const permissions = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canEditContent: vi.fn(),
}));
const queries = vi.hoisted(() => ({ searchPagesForPrompt: vi.fn() }));
const runtime = vi.hoisted(() => ({ buildChatRequest: vi.fn() }));
const actions = vi.hoisted(() => ({ planChatAction: vi.fn(), executeChatActionAction: vi.fn() }));
const db = vi.hoisted(() => ({
  prisma: {
    aiProviderConfig: { findUnique: vi.fn() },
    chatThread: { findUnique: vi.fn(), update: vi.fn() },
    chatMessage: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: permissions.getWorkspaceAccess,
  canEditContent: permissions.canEditContent,
}));
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
  executeChatActionAction: actions.executeChatActionAction,
}));

import { POST as streamPost } from "./route";
import { PROVIDER_UNREACHABLE, TRANSPORT_ERROR } from "@/lib/ai-provider";

/**
 * The key the workspace sent to the provider — the thing that must not leak.
 * The newline in the middle is the point: the runtime rejects such a header
 * and reports the *whole* header value in its message.
 */
const API_KEY = "sk-live-abc\ndef-tail-9x";

/**
 * A second key for the provider failure: the transport failure needs the
 * newline (the runtime rejects such a header value), a provider failure does
 * not — it answers with a body that carries the key.
 */
const PROVIDER_KEY = "sk-live-abcdef1234567890";

const jsonRequest = (body: unknown) =>
  new Request("http://test/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AI_API_KEY", API_KEY);
  vi.stubEnv("AI_BASE_URL", "http://localhost:1/v1");
  vi.stubEnv("AI_MODEL", "gpt-4o-mini");
  auth.getCurrentUser.mockResolvedValue({ id: "u1" });
  guard.rateLimit.mockReturnValue(null);
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "OWNER" });
  permissions.canEditContent.mockReturnValue(true);
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
  actions.executeChatActionAction.mockResolvedValue({ ok: true, message: "Created **X** — DW-1." });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

describe("a confirmation names the proposal it applies (B17)", () => {
  const confirm = {
    kind: "createTicket",
    args: { title: "Ship the beta" },
    summary: 'Create ticket "Ship the beta"',
    requiresConfirm: true,
  };

  it("refuses a confirmation that names no proposal", async () => {
    const response = await streamPost(jsonRequest({ threadId: "t1", confirm }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "That confirmation must name the proposal it applies.",
    });
    // Nothing was executed.
    expect(actions.executeChatActionAction).not.toHaveBeenCalled();
  });

  it("hands the named proposal to the action that applies it", async () => {
    const response = await streamPost(
      jsonRequest({ threadId: "t1", confirm, proposalMessageId: "msg-1" }),
    );

    expect(response.status).toBe(200);
    expect(actions.executeChatActionAction).toHaveBeenCalledWith({
      threadId: "t1",
      action: confirm,
      proposalMessageId: "msg-1",
    });
  });
});

describe("the conversation names itself to the provider (#271)", () => {
  it("sends the discussion's id as the session and the app as the agent", async () => {
    // OpenCode Go asks for a user agent of the client's own and a stable
    // session id per conversation. The session is the discussion's own id, so
    // the provider can route and cache per conversation.
    vi.stubEnv("AI_API_KEY", PROVIDER_KEY);
    vi.stubEnv("AI_BASE_URL", "https://opencode.ai/inference/go/openai/v1");
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await streamPost(jsonRequest({ threadId: "t1", body: "hello" }));
    await response.text();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBe("noema:conversation:t1");
    expect(headers["user-agent"]).toMatch(/^noema\//);
  });

  it("does not name the session to another provider", async () => {
    vi.stubEnv("AI_API_KEY", PROVIDER_KEY);
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await streamPost(jsonRequest({ threadId: "t1", body: "hello" }));
    await response.text();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("a transport failure never carries the key", () => {
  it("stays out of the stream, out of the chat row and out of the log", async () => {
    // The runtime rejects an invalid header value with the *whole* header in
    // its message:
    //   Headers.append: "Bearer <key>" is an invalid header value.
    //
    // A scrubber knows a fixed set of credential *shapes*: the `Bearer` shape
    // covers "sk-live-abc" and stops at the newline, so the tail
    // "def-tail-9x" survives it. Only a class is safe whatever the key looks
    // like.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          `Headers.append: "Bearer ${API_KEY}" is an invalid header value.`,
        );
      }),
    );

    const response = await streamPost(jsonRequest({ threadId: "t1", body: "hello" }));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).not.toContain("sk-live-abc");
    expect(raw).not.toContain("def-tail-9x");
    // The in-band failure is the class, not the runtime's text.
    expect(raw).toContain(`[stream-error] ${PROVIDER_UNREACHABLE}`);

    // The same class is persisted as the assistant's answer — the key must not
    // be in the database either.
    const persisted = db.prisma.chatMessage.create.mock.calls
      .map((call) => JSON.stringify(call))
      .join("\n");
    expect(persisted).not.toContain("sk-live-abc");
    expect(persisted).not.toContain("def-tail-9x");
    expect(persisted).toContain(PROVIDER_UNREACHABLE);

    // And the log carries the class and no runtime text.
    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain("sk-live-abc");
    expect(logged).not.toContain("def-tail-9x");
    expect(logged).toContain(TRANSPORT_ERROR);
  });
});

describe("a provider failure never carries the key", () => {
  it("keeps the class in the log as its anchor and the body out of it", async () => {
    // A gateway answers a bad key with 401 and a body that carries the key:
    //   {"error":{"message":"Incorrect API key provided: …","code":"invalid_api_key"}}
    //
    // The failure travels in-band *and* into the persisted assistant row, so
    // both carry the class. The log keeps the class as its anchor — the grep
    // anchor is what makes the failure visible to the operator at all.
    vi.stubEnv("AI_API_KEY", PROVIDER_KEY);
    const leakyBody = JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${PROVIDER_KEY}.`,
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(leakyBody, {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const response = await streamPost(jsonRequest({ threadId: "t1", body: "hello" }));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).not.toContain(PROVIDER_KEY);
    expect(raw).not.toContain("Incorrect API key provided");
    // The in-band failure is the class, not the provider's body.
    expect(raw).toContain("[stream-error] AI provider error (401): invalid_api_key");

    // The persisted assistant row carries the class too — the key must not
    // be in the database either.
    const persisted = db.prisma.chatMessage.create.mock.calls
      .map((call) => JSON.stringify(call))
      .join("\n");
    expect(persisted).not.toContain(PROVIDER_KEY);
    expect(persisted).toContain("AI provider error (401): invalid_api_key");

    // The log keeps the class as its anchor and the raw text out of it.
    const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain(PROVIDER_KEY);
    expect(logged).not.toContain("Incorrect API key provided");
    expect(logged).toContain("invalid_api_key");
  });

  it("does not carry a truncated echo of the key into the stream or the row", async () => {
    // A provider may echo the key in the machine field ("code") instead of
    // the human one ("message") — whole, masked, truncated or re-cased. None
    // of those spellings is something the provider chooses freely, and none
    // of them may reach the client: a truncated key is not the key, so a
    // comparison that only knows the whole key would take it over as the
    // provider's code — and it would travel in-band and into the database.
    //
    // The key is a plain hex one on purpose: a truncated `sk-…` key is caught
    // by the credential *shape* anyway, so only a key the scrubber does not
    // know proves that the comparison against the key itself works.
    const hexKey = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const truncated = hexKey.slice(0, 24);
    vi.stubEnv("AI_API_KEY", hexKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: truncated } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const response = await streamPost(jsonRequest({ threadId: "t1", body: "hello" }));
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).not.toContain(truncated);
    expect(raw).not.toContain(hexKey);
    expect(raw).toContain("[stream-error] AI provider error (401): authentication_failed");

    // The persisted assistant row carries the class — no key material in the
    // database either.
    const persisted = db.prisma.chatMessage.create.mock.calls
      .map((call) => JSON.stringify(call))
      .join("\n");
    expect(persisted).not.toContain(truncated);
    expect(persisted).not.toContain(hexKey);
    expect(persisted).toContain("AI provider error (401): authentication_failed");
  });
});

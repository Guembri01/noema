import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B58 — `regenerateChatAnswerAction` must be a lossless replace (R25.4).
 *
 * The previous answer may only disappear once the replacement is on disk: a
 * provider failure — or AI that is not configured at all — has to leave the old
 * row untouched. Only the transport edges (prisma, auth, cache, provider,
 * runtime) are mocked; the action's own ordering logic runs for real.
 */

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  threadFindUnique: vi.fn(),
  messageFindFirst: vi.fn(),
  messageCreate: vi.fn(),
  /**
   * Spied on both APIs (`delete` and `deleteMany`): the requirement is "the old
   * row must not disappear", whichever prisma method would remove it.
   */
  messageDelete: vi.fn(),
}));

const ai = vi.hoisted(() => ({
  resolveAiConfig: vi.fn(),
  chatComplete: vi.fn(),
}));

const runtime = vi.hoisted(() => ({ buildChatRequest: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: db.memberFindUnique },
    chatThread: { findUnique: db.threadFindUnique },
    chatMessage: {
      findFirst: db.messageFindFirst,
      create: db.messageCreate,
      delete: db.messageDelete,
      deleteMany: db.messageDelete,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ai-provider", () => ({
  resolveAiConfig: ai.resolveAiConfig,
  chatComplete: ai.chatComplete,
}));
vi.mock("@/lib/chat-runtime", () => ({ buildChatRequest: runtime.buildChatRequest }));
vi.mock("@/lib/chat-context", () => ({ linkifyReferences: vi.fn((text: string) => text) }));

import { regenerateChatAnswerAction } from "./chat";

const CONFIG = {
  provider: "mock",
  baseUrl: "http://localhost",
  model: "m1",
  apiKey: "k",
  source: "env" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
  db.threadFindUnique.mockResolvedValue({ workspaceId: "ws-1", pageId: null });
  db.messageFindFirst.mockImplementation(async ({ where }: { where: { role?: string } }) =>
    where.role === "assistant" ? { id: "old-answer" } : { body: "What ships next?" },
  );
  db.messageCreate.mockResolvedValue({ id: "fresh-answer" });
  db.messageDelete.mockResolvedValue({ count: 1 });
  ai.resolveAiConfig.mockResolvedValue(CONFIG);
  ai.chatComplete.mockResolvedValue({ ok: true, text: "A fresh answer." });
  runtime.buildChatRequest.mockResolvedValue({
    system: "sys",
    context: "ctx",
    user: "usr",
    intel: { activity: [], intents: [], references: [] },
  });
});

describe("regenerateChatAnswerAction — lossless replace (R25.4)", () => {
  it("keeps the previous answer when the provider call fails", async () => {
    ai.chatComplete.mockResolvedValue({ ok: false, status: 502, error: "provider down" });

    await expect(regenerateChatAnswerAction("thread-1")).resolves.toEqual({
      ok: true,
      answered: false,
    });

    // The old row must still be there — nothing may have been deleted.
    expect(db.messageCreate).not.toHaveBeenCalled();
    expect(db.messageDelete).not.toHaveBeenCalled();
  });

  it("keeps the previous answer when AI is not configured at all", async () => {
    ai.resolveAiConfig.mockResolvedValue(null);

    await expect(regenerateChatAnswerAction("thread-1")).resolves.toEqual({
      ok: true,
      answered: false,
    });

    expect(db.messageDelete).not.toHaveBeenCalled();
  });

  it("persists the replacement before swapping the old answer out", async () => {
    await expect(regenerateChatAnswerAction("thread-1")).resolves.toEqual({
      ok: true,
      answered: true,
    });

    expect(db.messageCreate).toHaveBeenCalledTimes(1);
    expect(db.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "thread-1",
        role: "assistant",
        body: "A fresh answer.",
      }),
    });
    // Idempotent swap: the old row goes only after the new one is stored…
    expect(db.messageDelete).toHaveBeenCalledWith({ where: { id: "old-answer" } });
    // …and strictly after it (create first, delete second).
    expect(db.messageCreate.mock.invocationCallOrder[0]).toBeLessThan(
      db.messageDelete.mock.invocationCallOrder[0],
    );
  });

  it("deletes nothing when the thread had no answer yet", async () => {
    db.messageFindFirst.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "assistant" ? null : { body: "What ships next?" },
    );

    await expect(regenerateChatAnswerAction("thread-1")).resolves.toEqual({
      ok: true,
      answered: true,
    });

    expect(db.messageDelete).not.toHaveBeenCalled();
    expect(db.messageCreate).toHaveBeenCalledTimes(1);
  });

  it("denies a guest (permission chain is real, only transports are mocked)", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "GUEST" });

    await expect(regenerateChatAnswerAction("thread-1")).resolves.toEqual({
      error: "You do not have permission to change this discussion.",
    });

    expect(db.messageDelete).not.toHaveBeenCalled();
    expect(ai.chatComplete).not.toHaveBeenCalled();
  });
});

/**
 * The conversation's model.
 *
 * The picker in the composer is only half the feature — the choice has to reach
 * the provider, and it must change exactly one thing. These pin that seam: the id
 * is applied to the resolved config, everything that decides *where* the call goes
 * is left as the workspace had it, and the stored answer records what really
 * produced it.
 */
describe("regenerateChatAnswerAction — the conversation's model", () => {
  /** The config handed to the provider, i.e. the second argument of the call. */
  const sentConfig = () => ai.chatComplete.mock.calls[0][1];

  it("sends the chosen model instead of the configured one", async () => {
    await regenerateChatAnswerAction("thread-1", "m2");
    expect(sentConfig()).toEqual({
      ...CONFIG,
      model: "m2",
      // The session is the discussion's own id — the provider can cache and
      // route per conversation.
      sessionId: "noema:conversation:thread-1",
    });
  });

  it("changes only the model: provider, endpoint and key stay the workspace's", async () => {
    await regenerateChatAnswerAction("thread-1", "m2");
    expect(sentConfig()).toMatchObject({
      provider: CONFIG.provider,
      baseUrl: CONFIG.baseUrl,
      apiKey: CONFIG.apiKey,
      model: "m2",
    });
  });

  it("keeps the configured model when no choice travels (the ordinary path)", async () => {
    await regenerateChatAnswerAction("thread-1");
    expect(sentConfig().model).toBe(CONFIG.model);
  });

  it("ignores a choice that is not a bare model id", async () => {
    // A URL must not be able to aim the call somewhere else…
    await regenerateChatAnswerAction("thread-1", "https://evil.example/v1");
    expect(sentConfig().model).toBe(CONFIG.model);
  });

  it("records which model actually produced the stored answer", async () => {
    await regenerateChatAnswerAction("thread-1", "m2");
    expect(db.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: expect.objectContaining({ model: "m2" }),
      }),
    });
  });
});

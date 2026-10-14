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

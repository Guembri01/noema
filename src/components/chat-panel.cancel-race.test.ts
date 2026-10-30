/**
 * P2-T06 (F7+F13) — serialized sends and a Cancel that cannot be orphaned.
 *
 * The panel's node environment has no DOM, so the machinery `send()` actually
 * drives is asserted piece by piece — the same way `chat-panel.test.ts` pins
 * the pure layer — instead of clicking through a real mount:
 *
 *  - `sendBlocked` is the gate `send()` consults before starting a question.
 *    It closes while anything is in flight, and stays closed when the phase /
 *    pending flags have not caught up yet (the same-frame follow-up race).
 *  - `acquireChatThread` is the thread-creation step. It re-checks the send's
 *    abort signal before *and* after the create: a Stop pressed while the
 *    thread is being created leaves no actively created orphan thread row —
 *    the fresh row is deleted again, while a merely REUSED empty thread (which
 *    predates the send) is left to its owner.
 *  - `releaseStreamController` is the stream's `finally`: the panel's abort
 *    handle is only cleared when it is still *this* send's controller, so an
 *    overlap can never leave Cancel pointing at a destroyed controller.
 *
 * The fully interactive click-Cancel flow is covered by the Playwright suite.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/chat", () => ({
  createChatThreadAction: vi.fn(),
  deleteChatThreadAction: vi.fn(),
  executeChatActionAction: vi.fn(),
  postChatMessageAction: vi.fn(),
  regenerateChatAnswerAction: vi.fn(),
}));
vi.mock("@/server/actions/prompts", () => ({
  listPromptsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import {
  acquireChatThread,
  releaseStreamController,
  sendBlocked,
} from "./chat-panel";

/* ------------------------------------------------------------------ the gate */

describe("sendBlocked — sends are serialized (F7)", () => {
  it("refuses any send while a question is in flight", () => {
    expect(sendBlocked({ inFlight: true, phase: "pending", pending: true })).toBe(true);
    expect(sendBlocked({ inFlight: true, phase: "streaming", pending: false })).toBe(true);
  });

  it("keeps the gate closed in the same frame the second send fires — a stale idle/pending never re-opens it", () => {
    // The in-flight ref is set synchronously inside `send()`; a follow-up
    // clicked before the next render sees old `phase`/`pending` values. Even
    // with both stale, the ref alone must refuse the second send.
    expect(sendBlocked({ inFlight: true, phase: "idle", pending: false })).toBe(true);
  });

  it("blocks while pending or while a stream is running", () => {
    expect(sendBlocked({ inFlight: false, phase: "pending", pending: true })).toBe(true);
    expect(sendBlocked({ inFlight: false, phase: "streaming", pending: false })).toBe(true);
  });

  it("opens for the first question, and again once a send settled (retry)", () => {
    expect(sendBlocked({ inFlight: false, phase: "idle", pending: false })).toBe(false);
  });
});

/* --------------------------------------------------- thread-creation and cancel */

describe("acquireChatThread — the cancel checks around thread creation", () => {
  const makeSignal = (aborted: boolean) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    return controller.signal;
  };

  it("reuses the open discussion without creating anything", async () => {
    const outcome = await acquireChatThread({
      threadId: "thread-open",
      signal: makeSignal(false),
      createThread: () => never.createThread(),
      deleteThread: () => never.deleteThread(),
    });
    expect(outcome).toEqual({ status: "ready", threadId: "thread-open", created: false });
  });

  it("checks the cancel before creating — a Stop pressed first never reaches the server", async () => {
    let created = 0;
    const outcome = await acquireChatThread({
      threadId: null,
      signal: makeSignal(true),
      createThread: async () => {
        created += 1;
        return { ok: true, value: { ok: true, id: "never", reused: false } };
      },
      deleteThread: () => never.deleteThread(),
    });
    expect(created).toBe(0);
    expect(outcome).toEqual({ status: "aborted", orphanDeleted: false });
  });

  it("deletes the thread it had created when the cancel lands during the create — no orphan row", async () => {
    const controller = new AbortController();
    const deleted: string[] = [];
    const outcome = await acquireChatThread({
      threadId: null,
      signal: controller.signal,
      createThread: async () => {
        // The user presses Stop while the create is still resolving.
        controller.abort();
        return { ok: true, value: { ok: true, id: "fresh", reused: false } };
      },
      deleteThread: async (id) => {
        deleted.push(id);
        return { ok: true, value: { ok: true } };
      },
    });
    expect(deleted).toEqual(["fresh"]);
    expect(outcome).toEqual({ status: "aborted", orphanDeleted: true });
  });

  it("does not delete a REUSED empty thread on cancel — it predates this send", async () => {
    const controller = new AbortController();
    const deleted: string[] = [];
    const outcome = await acquireChatThread({
      threadId: null,
      signal: controller.signal,
      createThread: async () => {
        controller.abort();
        return { ok: true, value: { ok: true, id: "reused-empty", reused: true } };
      },
      deleteThread: async (id) => {
        deleted.push(id);
        return { ok: true, value: { ok: true } };
      },
    });
    expect(deleted).toEqual([]);
    expect(outcome).toEqual({ status: "aborted", orphanDeleted: false });
  });

  it("hands back the created thread when no cancel raced", async () => {
    const outcome = await acquireChatThread({
      threadId: null,
      signal: makeSignal(false),
      createThread: async () => ({ ok: true, value: { ok: true, id: "fresh", reused: false } }),
      deleteThread: () => never.deleteThread(),
    });
    expect(outcome).toEqual({ status: "ready", threadId: "fresh", created: true });
  });

  it("propagates a transport failure without touching threads", async () => {
    const outcome = await acquireChatThread({
      threadId: null,
      signal: makeSignal(false),
      createThread: async () => ({ ok: false, error: "Cannot reach the server", retryable: true }),
      deleteThread: () => never.deleteThread(),
    });
    expect(outcome).toEqual({ status: "failed", error: "Cannot reach the server" });
  });

  it("propagates a domain failure (permission) without deleting anything", async () => {
    const outcome = await acquireChatThread({
      threadId: null,
      signal: makeSignal(false),
      createThread: async () => ({
        ok: true,
        value: { error: "You do not have permission to start a discussion." },
      }),
      deleteThread: () => never.deleteThread(),
    });
    expect(outcome).toEqual({
      status: "failed",
      error: "You do not have permission to start a discussion.",
    });
  });
});

/* ------------------------------------------------------------- the controller */

describe("releaseStreamController — the finally only clears its own handle", () => {
  it("clears the handle when it is still this send's controller", () => {
    const handle: { current: AbortController | null } = { current: new AbortController() };
    const own = new AbortController();
    handle.current = own;
    releaseStreamController(handle, own);
    expect(handle.current).toBeNull();
  });

  it("never destroys a NEWER send's controller — the overlap defect", () => {
    const handle: { current: AbortController | null } = { current: null };
    const older = new AbortController();
    const newer = new AbortController();
    // The (now forbidden) overlap: a second send re-pointed the handle before
    // the first stream settled. Its finally must not null the newer handle.
    handle.current = older;
    handle.current = newer;
    releaseStreamController(handle, older);
    expect(handle.current).toBe(newer);
    // Cancel still reaches the stream that actually runs.
    newer.abort();
    expect(newer.signal.aborted).toBe(true);
  });

  it("leaves a matching settled controller cleared once and stays harmless on repeat", () => {
    const handle: { current: AbortController | null } = { current: new AbortController() };
    const own = new AbortController();
    handle.current = own;
    releaseStreamController(handle, own);
    releaseStreamController(handle, own);
    expect(handle.current).toBeNull();
  });
});

/* ----------------------------------------------------------------- helpers */

/** Never called in these tests — used where a dependency must not be reached. */
const never = {
  createThread: () => {
    throw new Error("createThread must not be called in this path");
  },
  deleteThread: () => {
    throw new Error("deleteThread must not be called in this path");
  },
};

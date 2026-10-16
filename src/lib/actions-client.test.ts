import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  UNDO_WINDOW_MS,
  feedbackFor,
  feedbackFromAction,
  withUndo,
} from "./actions-client";
import { t } from "./i18n";

/**
 * The universal feedback layer.
 *
 * `feedbackFor` is the one pure mapping from an outcome to what a surface
 * shows — success is never silent and failure is never dropped. `withUndo`
 * wraps a reversible action in a six-second, single-flight Undo whose copy is
 * decided up front. This file pins both, plus the `feedbackFromAction` bridge
 * for `safeAction` results.
 *
 * No timers are real: `withUndo` takes an injected `now`, and every undo is a
 * resolved value, so the suite is deterministic.
 */

// Vitest hoists this above the imports, so `actions-client` sees the fake.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

/** Let the undo promise chain settle (microtasks only — no 700 ms retry sleeps). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("feedbackFor", () => {
  it("keeps an explicit success message", () => {
    expect(feedbackFor({ status: "success", message: "Deleted" })).toEqual({
      kind: "success",
      message: "Deleted",
    });
  });

  it("never leaves a save silent", () => {
    const feedback = feedbackFor({ status: "success" });
    expect(feedback).toEqual({ kind: "success", message: t("en", "savedWord") });
    expect(feedback.message.trim()).not.toBe("");
  });

  it("treats a blank message as missing", () => {
    expect(feedbackFor({ status: "success", message: "   " }).message).toBe(
      t("en", "savedWord"),
    );
  });

  it("flags Undo only for a reversible success", () => {
    expect(feedbackFor({ status: "success", message: "Archived", undoable: true })).toEqual({
      kind: "success",
      message: "Archived",
      undo: true,
    });
    expect(feedbackFor({ status: "success", message: "Archived" })).not.toHaveProperty("undo");
  });

  it("keeps an explicit error message", () => {
    expect(feedbackFor({ status: "error", message: "Server said no" })).toEqual({
      kind: "error",
      message: "Server said no",
    });
  });

  it("never drops a failure without a message", () => {
    expect(feedbackFor({ status: "error" })).toEqual({
      kind: "error",
      message: t("en", "somethingWentWrongDot"),
    });
  });

  it("maps informational outcomes and defaults them", () => {
    expect(feedbackFor({ status: "info", message: "All caught up" })).toEqual({
      kind: "info",
      message: "All caught up",
    });
    expect(feedbackFor({ status: "info" })).toEqual({ kind: "info", message: t("en", "done") });
  });

  it("localizes the fallbacks", () => {
    expect(feedbackFor({ status: "success" }, "fr").message).toBe(t("fr", "savedWord"));
    expect(feedbackFor({ status: "error" }, "fr").message).toBe(
      t("fr", "somethingWentWrongDot"),
    );
  });
});

describe("feedbackFromAction", () => {
  it("maps a transport failure to error feedback", () => {
    expect(
      feedbackFromAction({ ok: false, error: "Couldn't reach the server", retryable: true }),
    ).toEqual({ kind: "error", message: "Couldn't reach the server" });
  });

  it("maps an action that returned { error } to error feedback", () => {
    expect(feedbackFromAction({ ok: true, value: { error: "Not allowed" } })).toEqual({
      kind: "error",
      message: "Not allowed",
    });
  });

  it("maps a clean success through, carrying undo", () => {
    expect(feedbackFromAction({ ok: true, value: {} }, { success: "Renamed", undoable: true })).toEqual(
      { kind: "success", message: "Renamed", undo: true },
    );
    expect(feedbackFromAction({ ok: true, value: {} })).toEqual({
      kind: "success",
      message: t("en", "savedWord"),
    });
  });
});

describe("withUndo", () => {
  it("returns a localized action and the six-second window", () => {
    const { action, duration } = withUndo({ label: "Delete", undo: async () => undefined });
    expect(action.label).toBe(t("en", "undo"));
    expect(duration).toBe(UNDO_WINDOW_MS);
    expect(UNDO_WINDOW_MS).toBe(6000);
  });

  it("honours a custom window and exposes it on the toast", () => {
    const { duration } = withUndo({
      label: "Move",
      undo: async () => undefined,
      windowMs: 1500,
    });
    expect(duration).toBe(1500);
  });

  it("runs the undo once and toasts success", async () => {
    const undo = vi.fn(async () => undefined);
    const { action } = withUndo({ label: "Delete", undo });
    action.onClick();
    await tick();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Delete undone");
  });

  it("lets the caller override the success copy", async () => {
    const undo = vi.fn(async () => undefined);
    const { action } = withUndo({ label: "Delete", undo, successMessage: "Page restored" });
    action.onClick();
    await tick();
    expect(toast.success).toHaveBeenCalledWith("Page restored");
  });

  it("is single-flight: a double-click cannot run the undo twice", async () => {
    let release!: () => void;
    const undo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { action } = withUndo({ label: "Archive", undo });

    action.onClick();
    action.onClick();
    expect(undo).toHaveBeenCalledTimes(1);

    release();
    await tick();
    expect(toast.success).toHaveBeenCalledTimes(1);

    // Once it landed the offer is spent — a later click is inert.
    action.onClick();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("closes the window at the deadline (injected clock)", async () => {
    let clock = 0;
    const undo = vi.fn(async () => undefined);
    const { action } = withUndo({ label: "Delete", undo, now: () => clock });

    clock = UNDO_WINDOW_MS;
    action.onClick();
    await tick();
    expect(undo).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("stays open just inside the window (injected clock)", async () => {
    let clock = 0;
    const undo = vi.fn(async () => undefined);
    const { action } = withUndo({ label: "Delete", undo, now: () => clock });

    clock = UNDO_WINDOW_MS - 1;
    action.onClick();
    await tick();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("toasts a failure and stays retryable inside the window", async () => {
    let clock = 0;
    const undo = vi.fn();
    undo.mockRejectedValueOnce(new Error("Disk is on fire"));
    undo.mockResolvedValueOnce(undefined);
    const { action } = withUndo({ label: "Delete", undo, now: () => clock });

    action.onClick();
    await tick();
    expect(toast.error).toHaveBeenCalledWith("Disk is on fire");

    // The failure did not burn the offer: a retry inside the window works.
    clock = UNDO_WINDOW_MS - 1;
    action.onClick();
    await tick();
    expect(undo).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith("Delete undone");
  });

  it("toasts when an undo returns { error }", async () => {
    const undo = vi.fn(async () => ({ error: "Gone already" }));
    const { action } = withUndo({ label: "Delete", undo });
    action.onClick();
    await tick();
    expect(toast.error).toHaveBeenCalledWith("Gone already");
    expect(toast.success).not.toHaveBeenCalled();
  });
});

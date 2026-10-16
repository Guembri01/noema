"use client";

import { useCallback, useState, useTransition } from "react";
import { toast } from "sonner";
import { t } from "@/lib/i18n";

/**
 * Server Action helpers.
 *
 * A dropped connection used to surface as a dead end ("Network problem - the
 * change was not saved."). Transient failures are now retried once with a short
 * delay, and the messages distinguish "the server is unreachable" (retryable)
 * from "the server rejected this" (needs a reload), so the UI can advise
 * sensibly instead of looking broken.
 *
 * Feedback & undo (the universal layer): every settled action maps through
 * `feedbackFor`, and any reversible one can offer "Undo" for six seconds:
 *
 *   const { run } = useAction(locale);
 *   run(() => archiveTicket(id), {
 *     success: "Ticket archived",
 *     undo: { label: "Archive", undo: () => restoreTicket(id) },
 *   });
 *   // By hand, for any toast surface:
 *   toast.success(feedbackFor({ status: "success", message: "Deleted", undoable: true }).message,
 *     withUndo({ label: "Delete", undo: () => restorePage(id) }));
 */

export type ActionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; retryable: boolean };

const NETWORK = /failed to fetch|load failed|network|fetch failed|econnrefused|socket/i;
const STALE = /server action|unexpected response|invalid server actions|did not match the expected/i;

export function describeActionError(error: unknown, locale: string = "en"): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (NETWORK.test(message)) {
    return t(locale, "serverUnreach");
  }
  if (STALE.test(message)) {
    return t(locale, "staleTab");
  }
  return message || t(locale, "somethingWentWrongDot");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a Server Action, retrying once on a connection-level failure.
 * Results that carry their own `{ error }` are returned untouched.
 */
export async function safeAction<T>(
  run: () => Promise<T>,
  options: { retries?: number; locale?: string } = {},
): Promise<ActionOutcome<T>> {
  const attempts = (options.retries ?? 1) + 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error ?? "");
      const transient = NETWORK.test(message);
      if (!transient || attempt === attempts - 1) break;
      await sleep(700 * (attempt + 1));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "");
  return {
    ok: false,
    error: describeActionError(lastError, options.locale),
    retryable: NETWORK.test(message),
  };
}

/**
 * Wrap a Server Action so a *transport* failure becomes a value instead of a
 * thrown rejection.
 *
 * Existing call sites already handle `{ error }` results, so wrapping an action
 * once at the import makes every one of them safe without touching the call:
 *
 *   import { renameThingAction as raw } from "@/server/actions/things";
 *   const renameThingAction = guarded(raw);
 */
export function guarded<Args extends unknown[], T>(
  task: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T | { error: string }> {
  return async (...args: Args) => {
    const outcome = await safeAction(() => task(...args));
    // Call sites already branch on `"error" in result`, so a transport failure
    // joins that branch instead of rejecting.
    return outcome.ok ? outcome.value : { error: outcome.error };
  };
}

/** Unwrap an action that itself may return `{ error }`. */
export function actionError<T>(value: T): string | null {
  if (value && typeof value === "object" && "error" in value) {
    const message = (value as { error?: unknown }).error;
    if (typeof message === "string" && message) return message;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Feedback policy                                                            */
/* -------------------------------------------------------------------------- */

export type FeedbackKind = "success" | "error" | "info";

/** The canonical thing to show for a settled outcome. */
export type Feedback = {
  kind: FeedbackKind;
  /** Never empty: a missing message falls back to a localized default. */
  message: string;
  /** Present and `true` only when the caller should offer an Undo. */
  undo?: boolean;
};

/**
 * What happened, as the caller knows it. `success` without a message still
 * produces "Saved" — a save is never silent. `error` without a message still
 * produces "Something went wrong." — a failure is never dropped.
 */
export type FeedbackOutcome =
  | { status: "success"; message?: string; undoable?: boolean }
  | { status: "error"; message?: string }
  | { status: "info"; message?: string };

function nonEmpty(message: string | undefined): string | undefined {
  const trimmed = message?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The single mapping from an outcome to its feedback, so every surface speaks
 * with one voice. Pure and total over `FeedbackOutcome`.
 */
export function feedbackFor(outcome: FeedbackOutcome, locale: string = "en"): Feedback {
  switch (outcome.status) {
    case "success": {
      const feedback: Feedback = {
        kind: "success",
        message: nonEmpty(outcome.message) ?? t(locale, "savedWord"),
      };
      if (outcome.undoable) feedback.undo = true;
      return feedback;
    }
    case "error":
      return {
        kind: "error",
        message: nonEmpty(outcome.message) ?? t(locale, "somethingWentWrongDot"),
      };
    case "info":
      return {
        kind: "info",
        message: nonEmpty(outcome.message) ?? t(locale, "done"),
      };
  }
}

/**
 * Bridge a `safeAction` result (or an action that returned `{ error }`) onto the
 * feedback policy, so a dropped connection and a rejected action read alike.
 */
export function feedbackFromAction<T>(
  outcome: ActionOutcome<T>,
  options: { success?: string; undoable?: boolean } = {},
  locale: string = "en",
): Feedback {
  if (!outcome.ok) {
    return feedbackFor({ status: "error", message: outcome.error }, locale);
  }
  const rejected = actionError(outcome.value);
  if (rejected) {
    return feedbackFor({ status: "error", message: rejected }, locale);
  }
  return feedbackFor(
    { status: "success", message: options.success, undoable: options.undoable },
    locale,
  );
}

/* -------------------------------------------------------------------------- */
/* Undo                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How long an Undo offer stays live. Kept here (not just in the toast) so the
 * guard and the copy can never disagree.
 */
export const UNDO_WINDOW_MS = 6000;

/** A sonner-style toast action. */
export type ToastAction = { label: string; onClick: () => void };

/** Spread straight into a sonner call: `toast.success(msg, withUndo(...))`. */
export type UndoToast = {
  action: ToastAction;
  /** Matches the guard's window so the toast does not outlive its Undo. */
  duration: number;
};

export type WithUndoOptions = {
  /** The action being undone, e.g. "Delete" — used in copy and the aria-label. */
  label: string;
  /** Runs once when the user presses Undo. */
  undo: () => Promise<unknown>;
  locale?: string;
  /** Override the 6 s window; must match `UNDO_WINDOW_MS` unless you have a reason. */
  windowMs?: number;
  /** Injected clock (tests) — defaults to `Date.now`. */
  now?: () => number;
  /** Visible button text; defaults to the localized "Undo". */
  undoLabel?: string;
  /** Toast shown once the undo lands; defaults to "<label> undone". */
  successMessage?: string;
};

/**
 * Offer "Undo" for a reversible action.
 *
 * The returned action is single-flight (a double-click runs `undo` once) and
 * honours a deadline: once the window closes the click is a no-op. What
 * happens after the click is already decided — a success or failure toast — so
 * the caller only wires the action and the label.
 */
export function withUndo(options: WithUndoOptions): UndoToast {
  const {
    label,
    undo,
    locale = "en",
    windowMs = UNDO_WINDOW_MS,
    now = Date.now,
    undoLabel = t(locale, "undo"),
    successMessage = `${label} undone`,
  } = options;

  const openedAt = now();
  let inFlight = false;
  let spent = false;

  const onClick = () => {
    if (inFlight || spent) return;
    if (now() - openedAt >= windowMs) {
      spent = true;
      return;
    }
    inFlight = true;
    void (async () => {
      const outcome = await safeAction(() => undo(), { locale });
      if (!outcome.ok) {
        inFlight = false;
        toast.error(outcome.error);
        return;
      }
      const rejected = actionError(outcome.value);
      if (rejected) {
        inFlight = false;
        toast.error(rejected);
        return;
      }
      spent = true;
      inFlight = false;
      toast.success(successMessage);
    })();
  };

  return { action: { label: undoLabel, onClick }, duration: windowMs };
}

/**
 * The single way a client component runs a Server Action.
 *
 * Handles both failure modes — a rejected fetch *and* an action that returned
 * `{ error }` — with one toast, one pending flag and one error slot, so no
 * control can silently hang and no call site has to remember the rules.
 *
 *   const { run, pending } = useAction();
 *   run(() => renameAction(id, name), { success: "Renamed", onSuccess: refresh });
 */
export function useAction(locale: string = "en") {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    <T,>(
      task: () => Promise<T>,
      options: {
        /** Toast on success (omit for silent operations). */
        success?: string;
        /** Offer Undo for six seconds after the action succeeds. */
        undo?: { label: string; undo: () => Promise<unknown> };
        /** Run after success — typically `router.refresh()` or a local update. */
        onSuccess?: (value: T) => void;
        /** Suppress the error toast (the caller renders the error itself). */
        silentError?: boolean;
      } = {},
    ) => {
      setError(null);
      startTransition(async () => {
        const outcome = await safeAction(task, { locale });
        if (!outcome.ok) {
          setError(outcome.error);
          if (!options.silentError) toast.error(outcome.error);
          return;
        }
        const rejected = actionError(outcome.value);
        if (rejected) {
          setError(rejected);
          if (!options.silentError) toast.error(rejected);
          return;
        }
        if (options.undo) {
          const message =
            options.success ?? feedbackFor({ status: "success" }, locale).message;
          toast.success(message, withUndo({ ...options.undo, locale }));
        } else if (options.success) {
          toast.success(options.success);
        }
        options.onSuccess?.(outcome.value);
      });
    },
    [locale],
  );

  const clearError = useCallback(() => setError(null), []);

  return { run, pending, error, clearError };
}

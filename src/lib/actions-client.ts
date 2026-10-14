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
        if (options.success) toast.success(options.success);
        options.onSuccess?.(outcome.value);
      });
    },
    [locale],
  );

  const clearError = useCallback(() => setError(null), []);

  return { run, pending, error, clearError };
}

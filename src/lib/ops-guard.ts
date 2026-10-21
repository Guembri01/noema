import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/secrets";

/**
 * The shared ops gate: one constant-time secret comparison and one guard
 * order for every endpoint that authenticates with the shared ops secret
 * (`CRON_SECRET`; the readiness probe also accepts `READY_SECRET`).
 *
 * Two properties this module owns, so the ops routes cannot drift apart:
 *
 *  1. **The comparison never short-circuits.** `===`/`!==` on two strings
 *     returns at the first differing byte, so the shared secret becomes a
 *     byte-at-a-time oracle. {@link safeSecretEqual} delegates the byte loop
 *     to the repo's existing {@link constantTimeEqual}
 *     (`src/lib/secrets.ts`), which folds the length difference into the
 *     accumulator and always scans the longer of the two inputs.
 *  2. **The rate limit runs *before* the comparison.** A route that compares
 *     first and throttles afterwards lets an attacker probe the comparison
 *     without a limit — the failed guesses are exactly what the limit is
 *     supposed to bound. {@link guardOpsSecret} fixes the order once, for
 *     every caller.
 *
 * The gate fails closed: an unset (or blank) secret means "not configured" and
 * the route answers 503, never an open endpoint. An empty or missing presented
 * value is never a match.
 */

/** The header an ops caller presents the shared secret in. */
export const OPS_SECRET_HEADER = "x-cron-secret";

/** The alias the readiness probe additionally accepts. */
export const READY_SECRET_HEADER = "x-ready-secret";

/** The 503 body a cron route shows when `CRON_SECRET` is unset. */
export const CRON_SECRET_NOT_CONFIGURED =
  "CRON_SECRET is not configured. Set CRON_SECRET in the environment and send it as the x-cron-secret header.";

/** The 503 body the readiness probe shows when no ops secret is configured. */
export const OPS_SECRET_NOT_CONFIGURED =
  "Ops secret is not configured. Set CRON_SECRET (or READY_SECRET) in the environment and send it as the x-cron-secret header.";

/**
 * Compare two secrets without leaking *where* they differ.
 *
 * - **Constant time in the content:** the byte loop never returns early on a
 *   mismatch and the length difference is folded into the accumulator, so the
 *   comparison costs the same for a near-miss and for a total mismatch.
 * - **Fail closed:** an absent (`undefined`/`null`), non-string or empty value
 *   is never a match — not even against another empty value. An unset
 *   environment variable therefore can never authenticate a caller.
 * - **Trimmed:** both sides are trimmed *before* the comparison, so a header
 *   that carries the secret with surrounding whitespace still matches. The
 *   trim happens outside the byte loop, so it cannot shorten the comparison
 *   of one side only.
 * - **Case sensitive:** ops secrets are case sensitive.
 */
export function safeSecretEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = a.trim();
  const right = b.trim();
  if (left === "" || right === "") return false;
  return constantTimeEqual(left, right);
}

/**
 * Whether the request presents `secret` in one of `headerNames`.
 *
 * Every candidate header is compared with {@link safeSecretEqual}; a header
 * that is absent is simply not a match.
 */
export function requestHasOpsSecret(
  request: Request,
  secret: string,
  headerNames: readonly string[] = [OPS_SECRET_HEADER],
): boolean {
  for (const name of headerNames) {
    const provided = request.headers.get(name);
    if (provided !== null && safeSecretEqual(provided, secret)) return true;
  }
  return false;
}

/** Options for {@link guardOpsSecret}. */
export type OpsGateOptions = {
  /** The configured secret; unset/blank means "not configured" → the gate is closed. */
  readonly secret: string | undefined;
  /**
   * The rate limit for this scope. It runs *before* the secret comparison, so
   * a failed guess is throttled instead of being an unbounded oracle. Returns
   * the 429 response to answer with, or `null` to continue.
   */
  readonly limit?: () => NextResponse | null;
  /** The 503 body shown when no secret is configured. */
  readonly notConfigured?: string;
  /** The headers that may carry the secret (default: `x-cron-secret`). */
  readonly headerNames?: readonly string[];
};

/** The outcome of {@link guardOpsSecret}. */
export type OpsGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly response: NextResponse };

/**
 * The shared ops gate: fail closed, throttle, then compare in constant time.
 *
 * The order is deliberate and is the point of this helper:
 *
 *   1. no secret configured → 503 with the "not configured" hint (fail closed:
 *      the route never becomes open);
 *   2. over the rate limit → 429 (the limit is spent by *failed* guesses too,
 *      so the comparison below is not an unbounded oracle);
 *   3. the secret does not match → 401.
 */
export function guardOpsSecret(request: Request, options: OpsGateOptions): OpsGate {
  const secret = options.secret?.trim();
  if (!secret) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: options.notConfigured ?? CRON_SECRET_NOT_CONFIGURED },
        { status: 503 },
      ),
    };
  }

  // The rate limit runs BEFORE the comparison: a wrong secret is throttled
  // instead of being an unbounded guessing oracle.
  const limited = options.limit?.();
  if (limited) return { ok: false, response: limited };

  if (!requestHasOpsSecret(request, secret, options.headerNames)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return { ok: true };
}

/**
 * The rate-limit key for an ops surface that has no request of its own — a
 * server action is an HTTP endpoint too, but it never sees a `Request`.
 *
 * The key is derived from the **configured** secret, never from the presented
 * one: a key built from the guess would hand an attacker a fresh bucket per
 * attempt (the limit would be bypassable by varying the guess). The secret is
 * hashed, so the raw value never becomes a map key.
 */
export function opsSecretLimitKey(scope: string, configuredSecret: string): string {
  const digest = createHash("sha256").update(configuredSecret).digest("hex").slice(0, 32);
  return `ops-guard:${scope}:${digest}`;
}

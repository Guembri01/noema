import { NextResponse } from "next/server";
import { checkRateLimit, checkUserRateLimit, clientKey, userKey } from "@/lib/rate-limit";

/** Options accepted by {@link rateLimit}. */
export type RateLimitOptions = {
  /**
   * The authenticated caller's id, for routes that already know it. It adds a
   * second, non-spoofable budget: a signed-in caller cannot dodge its limit
   * by changing its (spoofed) client IP — and because that budget lives in
   * its own store, it cannot be reset by a flood of forged addresses either.
   */
  userId?: string | null;
};

/** The 429 response returned once a budget is exhausted. */
function tooManyRequests(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    { error: "Rate limit exceeded" },
    {
      status: 429,
      headers: {
        "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    },
  );
}

/**
 * Apply a fixed-window rate limit to an API route. Returns a 429 response when
 * the caller is over the limit, or `null` to continue.
 *
 * Two budgets apply:
 *
 *  1. the **per-user** budget, when the caller is known (`options.userId`) —
 *     the id comes from the session or the API token, so it cannot be spoofed;
 *  2. the **client-IP** budget — the client IP is only taken from the
 *     forwarding headers when a trusted proxy is declared
 *     (`TRUSTED_PROXY_HOPS`), see `clientKey`.
 *
 * The user budget is checked **first**: it is the budget a caller cannot dodge
 * by rotating its (spoofable) client IP, so it has to be the binding one.
 * Checking it first also means a caller that is already over its account
 * budget never opens a fresh client-IP bucket — a caller rotating its IP
 * cannot fill the bucket store that way.
 *
 * The two budgets live in **separate** stores (`src/lib/rate-limit.ts`), so
 * the address key space — the part an unauthenticated caller controls — cannot
 * evict the per-user bucket and cannot reset an exhausted user window.
 *
 * An anonymous caller (no `userId`) only gets the client-IP budget. That is
 * the fail-closed direction: without a declared proxy every caller of a scope
 * shares the `scope:local` bucket, which is a shared budget but never a
 * *bypassable* one.
 *
 * **The caller is identified before the limit is charged.** The per-user
 * budget is keyed on the user id, so the id has to be known first: the route
 * resolves the session or the API token *before* it calls `rateLimit()`. The
 * limiter therefore no longer bounds that lookup itself — an anonymous flood
 * on a wired route costs one session lookup per request before the limit
 * bites. The lookup is cheap for an unauthenticated caller (a forged cookie
 * fails the signature check before any database access), so only authenticated
 * callers make it expensive.
 */
export function rateLimit(
  request: Request,
  scope: string,
  limit = 120,
  windowMs = 60_000,
  options: RateLimitOptions = {},
): NextResponse | null {
  const userId = options.userId ?? null;
  if (userId) {
    const userResult = checkUserRateLimit(userKey(scope, userId), limit, windowMs);
    if (!userResult.ok) return tooManyRequests(userResult.retryAfterMs);
  }
  const ipResult = checkRateLimit(clientKey(request, scope), limit, windowMs);
  if (!ipResult.ok) return tooManyRequests(ipResult.retryAfterMs);
  return null;
}

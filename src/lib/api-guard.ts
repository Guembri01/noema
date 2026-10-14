import { NextResponse } from "next/server";
import { checkRateLimit, clientKey } from "@/lib/rate-limit";

/**
 * Apply a fixed-window rate limit to an API route. Returns a 429 response when
 * the caller is over the limit, or `null` to continue.
 */
export function rateLimit(
  request: Request,
  scope: string,
  limit = 120,
  windowMs = 60_000,
): NextResponse | null {
  const result = checkRateLimit(clientKey(request, scope), limit, windowMs);
  if (result.ok) return null;
  return NextResponse.json(
    { error: "Rate limit exceeded" },
    {
      status: 429,
      headers: {
        "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
      },
    },
  );
}

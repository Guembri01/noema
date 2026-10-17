import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { rateLimit } from "@/lib/api-guard";
import { attemptShareUnlock } from "@/server/actions/share";

export const runtime = "nodejs";

/** Unlock a password-protected share link by setting a short-lived cookie. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const origin = new URL(request.url).origin;

  // This endpoint is unauthenticated, so it needs the same rate limit as
  // every other non-public route. The share token is not guessable, so it
  // scopes the budget per link.
  //
  // The budget is scoped by the share token, so a caller that rotates its
  // forwarded ip does not get a fresh budget. The attempt brake below is the
  // second, token-bound limit that holds even if the scope key is guessed.
  const limited = rateLimit(request, `share-unlock-${token}`, 5, 60_000);
  if (limited) return limited;

  const form = await request.formData();
  const password = String(form.get("password") ?? "");

  // The attempt counter is keyed by the share token alone: it still stops a
  // brute force when the caller rotates its forwarded ip.
  const attempt = await attemptShareUnlock(token, password);
  if (attempt.status === "locked") {
    return NextResponse.json(
      { error: "Too many unlock attempts" },
      {
        status: 429,
        headers: {
          "retry-after": String(
            Math.max(1, Math.ceil(attempt.retryAfterMs / 1000)),
          ),
        },
      },
    );
  }
  if (attempt.status === "wrong-password") {
    return NextResponse.redirect(`${origin}/s/${token}?error=1`, 303);
  }

  const store = await cookies();
  store.set(`share_${token}`, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return NextResponse.redirect(`${origin}/s/${token}`, 303);
}

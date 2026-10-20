import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { rateLimit } from "@/lib/api-guard";
import {
  SHARE_UNLOCK_TTL_SECONDS,
  createShareUnlockToken,
  shareUnlockCookieName,
} from "@/lib/secrets";
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
  // every other non-public route.
  //
  // The limiter's bucket is `share-unlock-<token>:<ip>`: the scope names the
  // share link, the address part comes from the forwarding header. A caller
  // that rotates its forwarded ip therefore *does* get a fresh rate-limit
  // budget. The attempt brake below is the token-bound limit that holds
  // across an ip rotation.
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

  // The cookie value is an HMAC over the share token and an expiry, keyed by
  // AUTH_SECRET: a client cannot forge it, and a cookie minted for one link
  // never unlocks another.
  //
  // Without a usable AUTH_SECRET the mint throws. That must not surface as a
  // server error on a public route: the unlock fails closed the same way a
  // wrong password does — no cookie is handed out that nobody could verify.
  let value: string;
  try {
    value = createShareUnlockToken(token);
  } catch {
    return NextResponse.redirect(`${origin}/s/${token}?error=1`, 303);
  }
  const store = await cookies();
  store.set(shareUnlockCookieName(token), value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SHARE_UNLOCK_TTL_SECONDS,
  });
  return NextResponse.redirect(`${origin}/s/${token}`, 303);
}

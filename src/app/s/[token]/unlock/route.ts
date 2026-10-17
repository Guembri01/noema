import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySharePassword } from "@/server/actions/share";
import {
  SHARE_UNLOCK_TTL_SECONDS,
  createShareUnlockToken,
  shareUnlockCookieName,
} from "@/lib/secrets";

export const runtime = "nodejs";

/** Unlock a password-protected share link by setting a short-lived cookie. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const origin = new URL(request.url).origin;

  if (!(await verifySharePassword(token, password))) {
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

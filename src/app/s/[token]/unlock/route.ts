import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySharePassword } from "@/server/actions/share";

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

  const store = await cookies();
  store.set(`share_${token}`, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return NextResponse.redirect(`${origin}/s/${token}`, 303);
}

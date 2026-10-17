import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { bodyReadError, readFormDataBody } from "@/lib/body-limit";
import { verifySharePassword } from "@/server/actions/share";

export const runtime = "nodejs";

/**
 * B22 — the budget for one unlock attempt. The route is public and not rate
 * limited, so the form body has to carry a bound of its own.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Unlock a password-protected share link by setting a short-lived cookie. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let form: FormData;
  try {
    form = await readFormDataBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Expected multipart form data");
  }
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

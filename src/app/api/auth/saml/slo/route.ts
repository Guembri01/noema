import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Best-effort Single Logout endpoint: always destroy the local session, then
 * return to the login page. Full front/back-channel SLO validation is not done
 * here (the local session is authoritative and a forged logout request must
 * not be able to do more than end the caller's own session).
 */
async function logout(request: Request) {
  await destroySession();
  return NextResponse.redirect(new URL("/login", request.url));
}

export async function GET(request: Request) {
  return logout(request);
}

export async function POST(request: Request) {
  return logout(request);
}

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { prisma } from "./db";
import {
  describeDevice,
  isSessionRevoked,
  registerSession,
  revokeSessionForUser,
  touchSession,
} from "./session-store";

const COOKIE_NAME = "noema_session";
const SESSION_DAYS = 30;

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Set a strong value in .env (see .env.example).",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Issue a signed session cookie for the given user id.
 *
 * B54: the token carries a `sid` claim that is registered in the session
 * registry (src/lib/session-store.ts) so the security settings UI can list the
 * device and revoke it. If the registry is unavailable the sign-in still
 * succeeds — the session then behaves like a legacy (unlisted) one, because a
 * broken store must not block authentication.
 */
export async function createSession(userId: string): Promise<void> {
  let record: { sid: string } | null = null;
  try {
    const requestHeaders = await headers();
    record = registerSession({
      userId,
      device: describeDevice(requestHeaders.get("user-agent")),
    });
  } catch {
    record = null;
  }

  const payload: { sub: string; sid?: string } = { sub: userId };
  if (record) payload.sid = record.sid;

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secretKey());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * SESSION_DAYS,
  });
}

/**
 * Delete the calling device's cookie — and revoke its registry record, so a
 * replayed copy of the token is dead on its next request too (B54).
 */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    try {
      const { payload } = await jwtVerify(token, secretKey());
      if (typeof payload.sub === "string" && typeof payload.sid === "string") {
        revokeSessionForUser(payload.sid, payload.sub);
      }
    } catch {
      // Invalid/expired token: nothing worth revoking.
    }
  }
  store.delete(COOKIE_NAME);
}

export async function getSessionUserId(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.sub !== "string") return null;
    const sid = typeof payload.sid === "string" ? payload.sid : null;
    if (sid) {
      // Best-effort: an unreadable registry fails OPEN (auth stays up) — it
      // never turns a storage hiccup into a mass sign-out.
      try {
        if (isSessionRevoked(sid)) return null;
        touchSession(sid);
      } catch {
        /* registry unavailable → revocation lags a request */
      }
    }
    return payload.sub;
  } catch {
    return null;
  }
}

/** The registry sid behind the calling cookie (null for legacy tokens). */
export async function getSessionId(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return typeof payload.sid === "string" ? payload.sid : null;
  } catch {
    return null;
  }
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  theme: string;
  locale: string;
};

export async function getCurrentUser(): Promise<SessionUser | null> {
  const id = await getSessionUserId();
  if (!id) return null;
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      theme: true,
      locale: true,
    },
  });
}

/** Redirect to /login when unauthenticated. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

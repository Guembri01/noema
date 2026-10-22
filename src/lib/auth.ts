import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { resolveAuthSecret } from "./auth-secret";
import { prisma } from "./db";
import {
  describeDevice,
  registerSession,
  revokeSessionForUser,
  touchSession,
  validateSession,
} from "./session-store";

const COOKIE_NAME = "noema_session";
const SESSION_DAYS = 30;
/**
 * B39 — the idle window of a session: a cookie that sees no activity for
 * this long is dead on its next request. The absolute ceiling stays the
 * JWT's 30 days, so sliding expiry can never keep a session alive forever.
 */
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

/**
 * The session policy the request path enforces (B39): an idle session dies
 * after `SESSION_IDLE_MS`, no session outlives `SESSION_DAYS` from its
 * creation. The registry slides the very same policy on activity.
 */
const SESSION_POLICY = {
  idleTimeoutMs: SESSION_IDLE_MS,
  maxLifetimeMs: SESSION_DAYS * 24 * 60 * 60 * 1000,
};

/**
 * The HMAC key for the session cookie.
 *
 * B55: the rule that decides whether `AUTH_SECRET` is usable lives in
 * `src/lib/auth-secret.ts` — the placeholder this repository ships in
 * `.env.example` is public, so accepting it would give every instance the
 * same, known signing key. A missing or unusable secret throws: a session
 * that cannot be signed must never be handed out.
 */
function secretKey(): Uint8Array {
  return new TextEncoder().encode(resolveAuthSecret());
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
 *
 * B129: a session that is not in the registry cannot be revoked and cannot be
 * listed. It gets the **idle** lifetime instead of the absolute one: the
 * sign-in still works, and the exposure is bounded to the idle window instead
 * of the 30 days of the token. A *request* that presents a `sid` the registry
 * does not know is rejected (fail closed); this legacy-free path only applies
 * to tokens minted while the registry was unwritable, which carry no `sid`.
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

  // A session without a registry row is only as good as the idle window:
  // nothing can revoke it, nothing can list it, and nothing enforces the
  // idle deadline for it.
  const seconds = record
    ? 60 * 60 * 24 * SESSION_DAYS
    : Math.floor(SESSION_IDLE_MS / 1000);

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(secretKey());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: seconds,
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
      // B39 + session-registry hardening: the registry decides whether this
      // session is still alive. A revoked, expired (idle) **or unknown** sid is
      // rejected even though the JWT is still valid; a missing/corrupt registry
      // also rejects, because an unavailable revocation list must not turn every
      // revocation into a no-op. Legacy tokens without a `sid` keep working
      // until their own 30-day expiry.
      const now = Date.now();
      const record = validateSession(sid, now, SESSION_POLICY);
      if (!record) return null;
      // Activity renews the idle window — never past the absolute cap. The
      // touch is best-effort: a full lock or a read-only store must not sign a
      // still-valid session out, and the next request retries it.
      try {
        touchSession(sid, now, SESSION_POLICY);
      } catch {
        // Keep the authenticated request; only the activity timestamp lags.
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

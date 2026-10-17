"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
} from "@/lib/auth";
import { loginSchema, signupSchema } from "@/lib/validation";
import { encryptTwoFactorSecret, openTwoFactorSecret } from "@/lib/secrets";
import { verifyTotp } from "@/lib/totp";
import { welcomeDoc } from "@/lib/welcome";
import { uniqueWorkspaceSlug } from "@/server/unique";
import { isSafeReturnTo, passwordStrategyEnabled } from "@/lib/auth-strategies";
import {
  authLimitMessage,
  authLockoutMs,
  checkAuthLimit,
  checkTwoFactorLimit,
  clientKeyFromHeaders,
} from "@/lib/rate-limit";

export type AuthState = { error?: string; requiresTwoFactor?: boolean };

/**
 * Shown when the deployment has switched the password strategy off
 * (`AUTH_PASSWORD=disabled` or an `AUTH_STRATEGIES` allow-list without
 * `password`). The same message is returned for every input, so it discloses
 * nothing about the submitted account.
 */
const PASSWORD_DISABLED_ERROR = "Password sign-in is disabled on this deployment.";

/**
 * B24 — the one sign-in failure text. Every failed sign-in (unknown address,
 * wrong password, wrong two-factor code) answers with this same string: a
 * message that differs per cause tells an attacker which half they got right.
 */
const LOGIN_FAILED = "Incorrect email or password.";

/**
 * B24 — the one sign-up failure text. It names neither the reason nor an
 * e-mail that will never arrive: the app sends no confirmation mail on
 * sign-up, and a message that says "this address is taken" is a free
 * enumeration oracle. The same text answers every way a sign-up can fail to
 * create the account, so the reply never tells "already registered" apart
 * from "lost the race against another sign-up for the same address".
 */
const SIGNUP_FAILED =
  "We could not create the account for this address. If you already have an account, sign in instead.";

/**
 * B24 — a real bcrypt hash (cost 12, the cost `hashPassword` uses) of a
 * value nobody can guess. `verifyPassword` against it costs exactly as much
 * as a real comparison, so the sign-in path can do the same work when no
 * account exists and the response time stops revealing whether the address
 * is registered. The cost must stay in step with `hashPassword` (cost 12) —
 * a cheaper hash would reintroduce the timing oracle.
 */
const DUMMY_PASSWORD_HASH =
  "$2b$12$DDATzCAs4idfq89J5AQgj.xDjyjiwPleCbBHhzWDH1HywDCLKgoYi";

/**
 * The shape of a hash that `bcrypt.compare` can actually work with: the
 * variant must be one bcrypt knows (`a`, `b`, `y`), the cost must be inside
 * bcrypt's range (4–31), and the rest is base64. Anything else — an SSO
 * account's `sso:<token>`, an erased account's tombstone, a legacy or
 * truncated value — can never match a password, and `bcrypt.compare` either
 * rejects it without doing any work (a value that is not 60 characters long)
 * or throws on it (a variant or a cost bcrypt does not know), which would
 * open a hole of its own. Such a value is compared against the dummy hash
 * instead, so the sign-in costs the same and fails closed.
 */
const BCRYPT_HASH = /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

/** A Prisma unique-constraint violation (`P2002`). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Create the user row. A unique-constraint violation means another sign-up
 * for the same address won the race; it is reported as `null` so the caller
 * can answer with the very same neutral text as the "address is taken" case
 * (B24). Every other failure propagates untouched.
 */
async function createUser(
  name: string,
  email: string,
  passwordHash: string,
): Promise<{ id: string } | null> {
  try {
    return await prisma.user.create({
      data: {
        name,
        email,
        // A local signup proves nothing about the address it registers (B07):
        // the account stays unverified until the owner proves it, so a later
        // provider sign-in may not link it silently.
        emailVerified: false,
        passwordHash,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}


/**
 * The address the attempt came from. A server action never sees a
 * `Request`, so the forwarding headers are read from the request headers
 * instead. When they cannot be read every caller shares one bucket,
 * which is the stricter direction.
 */
async function clientAddress(): Promise<string> {
  try {
    return clientKeyFromHeaders(await headers(), "auth");
  } catch {
    return "auth:unknown";
  }
}

/**
 * Record a failed sign-in and (re)arm the account lock. The counter is
 * persisted on the user row, so the lock survives a restart of the app;
 * the backoff grows with every consecutive failure and is reset by the
 * next successful sign-in.
 */
async function registerFailedLogin(userId: string, now: Date): Promise<void> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  const backoff = authLockoutMs(updated.failedLoginCount);
  await prisma.user.update({
    where: { id: userId },
    data: {
      lockedUntil: backoff > 0 ? new Date(now.getTime() + backoff) : null,
    },
  });
}

/** A successful sign-in clears the failure counter and the lock. */
async function clearFailedLogins(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });
}

export async function signupAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  // The strategy gate comes first: with the password strategy disabled the
  // deployment is single-sign-on only, so no local account may be created.
  if (!passwordStrategyEnabled(process.env)) {
    return { error: PASSWORD_DISABLED_ERROR };
  }

  const parsed = signupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { name, email, password } = parsed.data;

  // Budgets first: a sign-up costs a slot before it touches the database,
  // so the "this e-mail already exists" answer cannot be harvested and
  // accounts cannot be created in bulk.
  const limit = checkAuthLimit({ email, ip: await clientAddress() });
  if (!limit.allowed) {
    return { error: authLimitMessage(limit) };
  }

  // Hash first (B24): the bcrypt cost dominates the request, so paying it on
  // every path keeps the answer from arriving measurably faster for an
  // address that is already registered.
  const passwordHash = await hashPassword(password);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { error: SIGNUP_FAILED };
  }

  const user = await createUser(name, email, passwordHash);
  if (!user) {
    // Another sign-up for this address won the race — same neutral answer.
    return { error: SIGNUP_FAILED };
  }

  const workspace = await prisma.workspace.create({
    data: {
      name: `${name.split(" ")[0]}'s Workspace`,
      slug: await uniqueWorkspaceSlug(name),
      ownerId: user.id,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });

  await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title: "Getting started",
      icon: "👋",
      createdById: user.id,
      content: welcomeDoc() as unknown as Prisma.InputJsonValue,
    },
  });

  await createSession(user.id);
  redirect(`/w/${workspace.slug}`);
}

export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  // The strategy gate comes first: with the password strategy disabled the
  // deployment is single-sign-on only, so no password may be accepted.
  if (!passwordStrategyEnabled(process.env)) {
    return { error: PASSWORD_DISABLED_ERROR };
  }

  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    code: formData.get("code") ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { email, password, code } = parsed.data;

  // Budgets first: an attempt costs a slot before any password work
  // happens, so a flood of guesses cannot outrun the limiter. The
  // account budget is keyed on the e-mail address, which the client
  // cannot forge.
  const now = new Date();
  const limit = checkAuthLimit({
    email,
    ip: await clientAddress(),
    now: now.getTime(),
  });
  if (!limit.allowed) {
    return { error: authLimitMessage(limit) };
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      passwordHash: true,
      twoFactorEnabled: true,
      twoFactorSecret: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  });

  // B24 — always run a bcrypt comparison, never skip it. When there is no
  // account (or the stored value is not a bcrypt hash, e.g. an SSO account's
  // `sso:<token>`) the dummy hash is compared instead, so the sign-in costs
  // the same whether or not the address is registered. A stored value that is
  // not a bcrypt hash can never match a password, so it is also rejected
  // below — the dummy comparison only pays the bill, it never grants access.
  const storedHash = user?.passwordHash ?? "";
  const hasBcryptHash = BCRYPT_HASH.test(storedHash);
  const passwordOk = await verifyPassword(
    password,
    hasBcryptHash ? storedHash : DUMMY_PASSWORD_HASH,
  );

  // A locked account is refused before it can sign in, but only *after* the
  // comparison above, and with the same text as every other failure: a
  // distinct "temporarily locked" reply would confirm that the address exists.
  if (user?.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    return { error: LOGIN_FAILED };
  }

  if (!user || !hasBcryptHash || !passwordOk) {
    // Only a real password account can be locked. An SSO row must not become
    // a denial-of-service target for the password form.
    if (user && hasBcryptHash) await registerFailedLogin(user.id, now);
    return { error: LOGIN_FAILED };
  }

  // Two-factor gate: ask for a code, then verify it before issuing a session.
  if (user.twoFactorEnabled) {
    if (!code) return { requiresTwoFactor: true };
    // The code space is small (three valid codes per 30 s window), so the
    // guesses get their own budget.
    const guess = checkTwoFactorLimit({ key: email, now: now.getTime() });
    if (!guess.allowed) {
      return { error: authLimitMessage(guess), requiresTwoFactor: true };
    }

    // B05: the stored seed is an ENVELOPE (`v1:iv:tag:payload`), so it is
    // opened BEFORE the code is checked — `verifyTotp` gets the seed, never the
    // ciphertext. A value that cannot be opened (tampered ciphertext, a
    // rotated `AUTH_SECRET`) fails closed: no session.
    const stored = user.twoFactorSecret
      ? openTwoFactorSecret(user.twoFactorSecret)
      : ({ kind: "unreadable" } as const);
    if (stored.kind === "unreadable" || !verifyTotp(stored.secret, code)) {
      // One text for every failed sign-in: a message of its own would confirm
      // that the password was right (B24). The flag keeps the code field on
      // screen so the user can try again. The separate 2FA budget handles
      // guessing; it must not lock the password account.
      return { error: LOGIN_FAILED, requiresTwoFactor: true };
    }
    // A pre-B05 cleartext seed has now proved itself: re-seal it in place so
    // the migration completes without a re-enrolment. A failed write denies
    // the login — the row must not stay in the cleartext state.
    if (stored.kind === "legacy") {
      try {
        const sealed = encryptTwoFactorSecret(stored.secret);
        await prisma.user.update({
          where: { id: user.id },
          data: { twoFactorSecret: sealed },
        });
      } catch (error) {
        // No AUTH_SECRET (nothing can be sealed) or a write that did not land:
        // the seed stays cleartext, so the sign-in does not go through. The
        // reason goes to the log; the answer stays the neutral one above.
        console.error(
          "[2fa] could not re-seal a legacy TOTP seed; the sign-in was denied.",
          error,
        );
        return { error: LOGIN_FAILED, requiresTwoFactor: true };
      }
    }
  }

  await clearFailedLogins(user.id);
  await createSession(user.id);

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const owned = await prisma.workspace.findFirst({
    where: { ownerId: user.id },
    select: { slug: true },
    orderBy: { createdAt: "asc" },
  });
  const slug = membership?.workspace.slug ?? owned?.slug;
  // B28 — only same-site relative destinations (no open redirects). The
  // hardened check refuses a backslash and a percent-encoded "//" as well, so
  // a `next` that only looks like a path never leaves the origin.
  const next = String(formData.get("next") ?? "").trim();
  const safeNext = isSafeReturnTo(next) ? next : null;
  redirect(safeNext ?? (slug ? `/w/${slug}` : "/app"));
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

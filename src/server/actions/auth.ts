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
import { verifyTotpCounter } from "@/lib/totp";
import { consumeTotpStep } from "@/lib/totp-replay";
import { welcomeDoc } from "@/lib/welcome";
import {
  isWorkspaceSlugConflict,
  uniqueWorkspaceSlug,
} from "@/server/unique";
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
 * Create the user row on the given client — the shared one for a standalone
 * user, the transaction handle when it runs as part of the provisioning
 * transaction below. A unique-constraint violation means another sign-up for
 * the same address won the race; it is reported as `null` so the caller can
 * answer with the very same neutral text as the "address is taken" case
 * (B24). Every other failure propagates untouched.
 */
async function createUser(
  client: Prisma.TransactionClient,
  name: string,
  email: string,
  passwordHash: string,
): Promise<{ id: string } | null> {
  try {
    return await client.user.create({
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
 *
 * P3-T03 — concurrent failures cannot undo each other's work. The increment
 * is arithmetic under the row's write lock (`SET x = x + 1`), so overlapping
 * failures never lose a count, and the lock that follows is a **conditional
 * write**: its where-clause is evaluated in the same statement as its write,
 * so a slow failure carrying a smaller backoff can only match a row whose
 * lock is smaller — one a concurrent failure armed meanwhile stays the
 * larger one and simply wins. Whatever interleaving the requests take, the
 * stored lock only ever moves forward in time.
 */
async function registerFailedLogin(userId: string, now: Date): Promise<void> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  const backoff = authLockoutMs(updated.failedLoginCount);
  if (backoff > 0) {
    // Arm or extend the lock. The row may already hold a lock a concurrent
    // failure armed after the increment above — a larger one then matches
    // nothing here and stays; this write only lands when it extends what is
    // stored (no lock before, or one that ends earlier).
    const lockedUntil = new Date(now.getTime() + backoff);
    await prisma.user.updateMany({
      where: {
        id: userId,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: lockedUntil } }],
      },
      data: { lockedUntil },
    });
  } else {
    // Under the threshold nothing is owed, so a stale lock value is wiped —
    // but only one that is not live: the gate in `loginAction` refuses while
    // a lock ends after `now`, so this may only clear a lock that has
    // already expired (or was never set). The "no lock" this branch writes
    // is the smallest backoff there is; like the arm above, it may not
    // overwrite a lock a concurrent failure armed after the increment was
    // read.
    await prisma.user.updateMany({
      where: {
        id: userId,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { lockedUntil: null },
    });
  }
}

/** A successful sign-in clears the failure counter and the lock. */
async function clearFailedLogins(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });
}

/**
 * P3-T04 — provision the whole account: user row, workspace with its OWNER
 * member, and the "Getting started" page, all inside ONE transaction. The
 * earlier shape created the user first and provisioned the workspace and page
 * afterwards as separate writes — a failure in between stranded an
 * `emailVerified: false` user whose retries hit the neutral text and whose
 * next login landed workspace-less on `/app`; the transaction rolls the
 * attempt back entirely, so the caller answers neutrally and a retry starts
 * from a clean slate (nothing was persisted).
 *
 * The slug race regenerates instead of failing: the slug a concurrent
 * same-name sign-up took between `uniqueWorkspaceSlug`'s check and the insert
 * is invisible to the check but still collides with the index, and on
 * Postgres that failed insert aborts the transaction, so the *attempt* (not
 * the statement) is what retries. The committed winner is visible to the next
 * attempt's check, which proposes the next free variant; the bounded loop
 * answers with the neutral sign-up text instead of a raw 500 when even that
 * cannot win. No email is sent between the user and workspace writes and the
 * session is a cookie issued afterwards, so nothing non-transactional lives
 * inside the block.
 */
const SIGNUP_ATTEMPTS = 3;

async function provisionAccount(
  name: string,
  email: string,
  passwordHash: string,
): Promise<{ userId: string; workspaceSlug: string } | null> {
  for (let attempt = 0; attempt < SIGNUP_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const user = await createUser(tx, name, email, passwordHash);
        if (!user) {
          // A concurrent sign-up for the same address won the race; nothing
          // this attempt created survives and the caller answers neutrally.
          return null;
        }
        const workspace = await tx.workspace.create({
          data: {
            name: `${name.split(" ")[0]}'s Workspace`,
            slug: await uniqueWorkspaceSlug(name),
            ownerId: user.id,
            members: { create: { userId: user.id, role: "OWNER" } },
          },
        });
        await tx.page.create({
          data: {
            workspaceId: workspace.id,
            title: "Getting started",
            icon: "👋",
            createdById: user.id,
            content: welcomeDoc() as unknown as Prisma.InputJsonValue,
          },
        });
        return { userId: user.id, workspaceSlug: workspace.slug };
      });
    } catch (error) {
      // Only a slug collision is worth another attempt, freshly generated —
      // every other failure propagates (transaction rolled back, nothing
      // stranded).
      if (isWorkspaceSlugConflict(error)) continue;
      throw error;
    }
  }
  return null;
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

  const provisioned = await provisionAccount(name, email, passwordHash);
  if (!provisioned) {
    // The address was registered a moment before the user write landed, or
    // the slug race outlasted every attempt — either way the same neutral
    // answer, and nothing persisted for a retry to trip over.
    return { error: SIGNUP_FAILED };
  }

  await createSession(provisioned.userId);
  redirect(`/w/${provisioned.workspaceSlug}`);
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
    // opened BEFORE the code is checked — the verification gets the seed, never
    // the ciphertext. A value that cannot be opened (tampered ciphertext, a
    // rotated `AUTH_SECRET`) fails closed: no session.
    const stored = user.twoFactorSecret
      ? openTwoFactorSecret(user.twoFactorSecret)
      : ({ kind: "unreadable" } as const);
    // B25: the verification answers with the TIME STEP the code belongs to,
    // not only that it matched — that step is the state a replay is compared
    // against.
    const step =
      stored.kind === "unreadable"
        ? null
        : verifyTotpCounter(stored.secret, code);
    if (step === null) {
      // One text for every failed sign-in: a message of its own would confirm
      // that the password was right (B24). The flag keeps the code field on
      // screen so the user can try again. The separate 2FA budget handles
      // guessing; it must not lock the password account.
      return { error: LOGIN_FAILED, requiresTwoFactor: true };
    }
    // B25: the step is spent BEFORE the session exists. A code that was
    // already used opens no second session — not even inside the ±1 step
    // window, which is where an observed code used to be replayable.
    if (!(await consumeTotpStep(user.id, step))) {
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

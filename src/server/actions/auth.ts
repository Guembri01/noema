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
import { verifyTotp } from "@/lib/totp";
import { welcomeDoc } from "@/lib/welcome";
import { uniqueWorkspaceSlug } from "@/server/unique";
import {
  authLimitMessage,
  authLockoutMessage,
  authLockoutMs,
  checkAuthLimit,
  checkTwoFactorLimit,
  clientKeyFromHeaders,
} from "@/lib/rate-limit";

export type AuthState = { error?: string; requiresTwoFactor?: boolean };

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

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with that email already exists." };
  }

  const user = await prisma.user.create({
    data: { name, email, passwordHash: await hashPassword(password) },
  });

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
  const limit = checkAuthLimit({ email, ip: await clientAddress(), now: now.getTime() });
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
  if (!user) {
    return { error: "Incorrect email or password." };
  }

  // A locked account is refused before the password is even checked.
  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    return { error: authLockoutMessage(user.lockedUntil, now) };
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    await registerFailedLogin(user.id, now);
    return { error: "Incorrect email or password." };
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
    if (!user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, code)) {
      await registerFailedLogin(user.id, now);
      return { error: "Invalid two-factor code.", requiresTwoFactor: true };
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
  // Only allow same-site relative destinations (no open redirects).
  const next = String(formData.get("next") ?? "").trim();
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : null;
  redirect(safeNext ?? (slug ? `/w/${slug}` : "/app"));
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

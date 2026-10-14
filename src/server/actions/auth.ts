"use server";

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

export type AuthState = { error?: string; requiresTwoFactor?: boolean };

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

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { error: "Incorrect email or password." };
  }

  // Two-factor gate: ask for a code, then verify it before issuing a session.
  if (user.twoFactorEnabled) {
    if (!code) return { requiresTwoFactor: true };
    if (!user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, code)) {
      return { error: "Invalid two-factor code.", requiresTwoFactor: true };
    }
  }

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

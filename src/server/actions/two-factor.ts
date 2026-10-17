"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "@/lib/totp";
import { authLimitMessage, checkTwoFactorLimit } from "@/lib/rate-limit";

/** Begin 2FA setup: generate a secret (not yet enabled) and its otpauth URI. */
export async function startTwoFactorAction(): Promise<
  { secret: string; otpauth: string } | { error: string }
> {
  const user = await requireUser();
  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorSecret: secret, twoFactorEnabled: false },
  });
  return { secret, otpauth: otpauthUrl(secret, user.email) };
}

export async function enableTwoFactorAction(
  code: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: { twoFactorSecret: true },
  });
  if (!record?.twoFactorSecret) return { error: "Start the setup first." };
  // The code space is small (three valid codes per 30 s window), so the
  // guesses get their own budget, keyed on the account.
  const guess = checkTwoFactorLimit({ key: `user:${user.id}` });
  if (!guess.allowed) {
    return { error: authLimitMessage(guess) };
  }
  if (!verifyTotp(record.twoFactorSecret, code)) {
    return { error: "That code is not valid. Check your authenticator app." };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: true },
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function disableTwoFactorAction(
  code: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: { twoFactorSecret: true, twoFactorEnabled: true },
  });
  if (!record?.twoFactorEnabled || !record.twoFactorSecret) {
    return { error: "Two-factor authentication is not enabled." };
  }
  const guess = checkTwoFactorLimit({ key: `user:${user.id}` });
  if (!guess.allowed) {
    return { error: authLimitMessage(guess) };
  }
  if (!verifyTotp(record.twoFactorSecret, code)) {
    return { error: "That code is not valid." };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

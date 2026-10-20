"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "@/lib/totp";
import { authLimitMessage, checkTwoFactorLimit } from "@/lib/rate-limit";
import { encryptTwoFactorSecret, openTwoFactorSecret } from "@/lib/secrets";

/** Begin 2FA setup: generate a secret (not yet enabled) and its otpauth URI. */
export async function startTwoFactorAction(): Promise<
  { secret: string; otpauth: string } | { error: string }
> {
  const user = await requireUser();
  const secret = generateTotpSecret();
  // B05: the seed is sealed BEFORE it reaches the database, so the column
  // never holds the raw seed. A sealing failure aborts the setup instead of
  // falling back to a cleartext row.
  let sealed: string;
  try {
    sealed = encryptTwoFactorSecret(secret);
  } catch {
    console.error("[2fa] could not seal the TOTP seed; setup aborted.");
    return { error: "Two-factor setup is unavailable right now." };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorSecret: sealed, twoFactorEnabled: false },
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
  // B05: the stored value is an envelope; it is opened before the code is
  // checked. A value that cannot be opened fails closed.
  const stored = openTwoFactorSecret(record.twoFactorSecret);
  if (stored.kind === "unreadable") {
    return { error: "The two-factor secret could not be read. Start the setup again." };
  }
  if (!verifyTotp(stored.secret, code)) {
    return { error: "That code is not valid. Check your authenticator app." };
  }
  // Always store the sealed form — this also migrates a pre-B05 cleartext row.
  let sealed: string;
  try {
    sealed = encryptTwoFactorSecret(stored.secret);
  } catch {
    console.error("[2fa] could not seal the TOTP seed; enable aborted.");
    return { error: "Two-factor setup is unavailable right now." };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: true, twoFactorSecret: sealed },
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
  const stored = openTwoFactorSecret(record.twoFactorSecret);
  if (stored.kind === "unreadable") {
    return { error: "The two-factor secret could not be read." };
  }
  if (!verifyTotp(stored.secret, code)) {
    return { error: "That code is not valid." };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

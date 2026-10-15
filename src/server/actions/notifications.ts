"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { normalizePrefs, type NotificationPrefs } from "@/lib/notification-prefs";

export async function markAllNotificationsRead(): Promise<void> {
  const user = await requireUser();
  await prisma.notification.updateMany({
    where: { userId: user.id, read: false },
    data: { read: true },
  });
  revalidatePath("/w", "layout");
}

export async function markNotificationRead(id: string): Promise<void> {
  const user = await requireUser();
  await prisma.notification.updateMany({
    where: { id, userId: user.id },
    data: { read: true },
  });
  revalidatePath("/w", "layout");
}

/**
 * The signed-in user's notification preferences, filled to a complete shape.
 *
 * Always returns the normalized `NotificationPrefs` (defaults for a null or
 * corrupt `User.notificationPrefs` row), so the settings UI can render a full
 * form without defending against a partially-written payload. Read through the
 * same pure validator the delivery decision uses (`src/lib/notification-prefs`).
 */
export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  const user = await requireUser();
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { notificationPrefs: true },
  });
  return normalizePrefs(row?.notificationPrefs);
}

/** Outcome of a preference write: the persisted (normalized) prefs or a message. */
export type UpdateNotificationPrefsResult =
  | { ok: true; prefs: NotificationPrefs }
  | { error: string };

/**
 * Replace the signed-in user's notification preferences.
 *
 * `input` is normalized through `normalizePrefs` before it is stored, so unknown
 * event types/levels and bad cadences fall back to their defaults - a malformed
 * payload can only narrow delivery, never widen it. Non-object input is rejected
 * outright rather than silently resetting the row to the defaults.
 */
export async function updateNotificationPrefs(
  input: unknown,
): Promise<UpdateNotificationPrefsResult> {
  const user = await requireUser();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "Invalid notification preferences." };
  }
  const prefs = normalizePrefs(input);
  await prisma.user.update({
    where: { id: user.id },
    data: { notificationPrefs: prefs as unknown as Prisma.InputJsonValue },
  });
  revalidatePath("/w", "layout");
  return { ok: true, prefs };
}

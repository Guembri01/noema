"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { normalizePrefs, type NotificationPrefs } from "@/lib/notification-prefs";
import {
  parsePrefs as parseEnginePrefs,
  resolveRecipients,
} from "@/lib/notification-prefs-engine";

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

/**
 * R82.12 — the `PageFollow` dispatch (docs/specs/notifications.md, D1 "bell is
 * write-only"). Called by `updatePageAction` after a *material* title/content
 * edit; nothing else consumes `PageFollow`, so before this the bell was a dead
 * letter box.
 *
 * Who: the page's followers, resolved through the pure engine
 * (`resolveRecipients`, `src/lib/notification-prefs-engine`), which drops the
 * actor, honours each follower's per-type `page.updated` in-app switch and their
 * quiet hours, and returns a sorted, de-duplicated set. Recipients are then
 * filtered against the last 24 h of `page.updated` rows for the page so a busy
 * document notifies each follower **at most once per day** (R82.12).
 *
 * Safety: the only server-action entry point besides the read/prefs helpers, so
 * it re-derives the actor from the session and re-checks that they may edit the
 * page — a forged call cannot notify another workspace's followers. It never
 * throws (R82.8): a dispatch failure is logged and the triggering edit still
 * succeeds, mirroring `dispatchWebhooks`.
 */
export const PAGE_UPDATED_DEDUPE_MS = 24 * 60 * 60 * 1000;

export async function notifyPageUpdated(pageId: string): Promise<void> {
  try {
    const actor = await requireUser();
    const page = await prisma.page.findUnique({
      where: { id: pageId },
      select: { id: true, workspaceId: true, title: true, deletedAt: true },
    });
    if (!page || page.deletedAt) return;

    const access = await getWorkspaceAccess(actor.id, page.workspaceId);
    if (!access || !canEditContent(access.role)) return;

    const followers = await prisma.pageFollow.findMany({
      where: { pageId },
      select: { userId: true },
    });
    const followerIds = followers
      .map((row) => row.userId)
      .filter((id) => id !== actor.id);
    if (followerIds.length === 0) return;

    const now = new Date();
    const [users, recent] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: followerIds } },
        select: { id: true, notificationPrefs: true },
      }),
      prisma.notification.findMany({
        where: {
          type: "page.updated",
          userId: { in: followerIds },
          createdAt: { gte: new Date(now.getTime() - PAGE_UPDATED_DEDUPE_MS) },
          payload: { path: ["pageId"], equals: pageId },
        },
        select: { userId: true },
      }),
    ]);

    const prefs: Record<string, ReturnType<typeof parseEnginePrefs>> = {};
    for (const user of users) {
      prefs[user.id] = parseEnginePrefs(user.notificationPrefs);
    }

    const alreadyNotified = new Set(recent.map((row) => row.userId));
    const recipients = resolveRecipients(
      { type: "page.updated", pageId, actorId: actor.id, at: now },
      { followers: followerIds, prefs },
    ).filter((id) => !alreadyNotified.has(id));

    if (recipients.length === 0) return;

    await prisma.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        type: "page.updated",
        payload: {
          workspaceId: page.workspaceId,
          pageId,
          title: page.title,
          actorId: actor.id,
        },
      })),
    });
    revalidatePath("/w", "layout");
  } catch (error) {
    // R82.8 — never fail the edit that triggered the dispatch.
    console.warn("notifyPageUpdated: dispatch failed", error);
  }
}

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
import {
  actions,
  buildSlackMessage,
  button,
  escapeMrkdwn,
  header,
  section,
} from "@/lib/slack-blocks";
import type { SlackMessage } from "@/lib/slack-blocks";

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
 * The followers are re-checked against the workspace's current members first: a
 * `PageFollow` row outlives the membership that justified it, and the notice
 * carries the page's title — so a person who was removed from the workspace (or
 * who left) is told nothing about its pages any more.
 *
 * Safety: the only server-action entry point besides the read/prefs helpers, so
 * it re-derives the actor from the session and re-checks that they may edit the
 * page — a forged call cannot notify another workspace's followers. It never
 * throws (R82.8): a dispatch failure is logged and the triggering edit still
 * succeeds, mirroring `dispatchWebhooks`.
 */
// NOTE: this file has "use server" at the top, so it may only export async
// functions. Keep this constant module-private (a non-function export breaks
// the whole app with "A \"use server\" file can only export async functions").
const PAGE_UPDATED_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** Per-attempt timeout for the outbound Slack POST. */
const SLACK_TIMEOUT_MS = 5_000;

/** True only for a Slack incoming-webhook endpoint (`https://hooks.slack.com/…`). */
function isSlackWebhookUrl(url: string): boolean {
  try {
    return new URL(url).host === "hooks.slack.com";
  } catch {
    return false;
  }
}

/** A Slack link: the label is escaped, the target only needs `&` made safe. */
function slackLink(url: string, label: string): string {
  return `<${url.replace(/&/g, "&amp;")}|${escapeMrkdwn(label)}>`;
}

/**
 * Render a followed-page edit as a validated Slack Block Kit message using the
 * `slack-blocks` builder (the production wire for that module). The body is
 * escaped through `escapeMrkdwn`, so a page title cannot inject Slack markup,
 * and `buildSlackMessage` fails closed on a malformed payload.
 */
function pageUpdatedSlackMessage(input: {
  actorName: string;
  pageTitle: string;
  pageUrl: string;
}): SlackMessage {
  const title = input.pageTitle.trim() || "Untitled";
  return buildSlackMessage({
    text: `${input.actorName} updated ${title}`,
    blocks: [
      header("Page updated"),
      section(
        `*${escapeMrkdwn(input.actorName)}* updated ${slackLink(input.pageUrl, title)}`,
      ),
      actions(button("Open page", input.pageUrl)),
    ],
  });
}

/**
 * Post a page-update notice to every active Slack incoming webhook in the
 * workspace.
 *
 * The repo has **no** Slack client — only generic outbound webhooks — so this is
 * where `slack-blocks` is made reachable: a webhook whose URL is a Slack
 * incoming endpoint receives the Block Kit body the module builds, rather than
 * the generic JSON envelope (which Slack rejects). Best-effort and never
 * throwing, mirroring `dispatchWebhooks`: a Slack outage cannot fail the edit
 * that triggered the notification.
 */
async function postSlackPageUpdate(
  workspaceId: string,
  input: { actorName: string; pageTitle: string; pageId: string },
): Promise<void> {
  try {
    const origin = (
      process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
    )?.replace(/\/+$/, "");
    if (!origin) return; // no absolute origin ⇒ no valid Slack button; skip
    const hooks = await prisma.webhook.findMany({
      where: { workspaceId, active: true },
      select: { url: true },
    });
    const slackUrls = hooks.map((hook) => hook.url).filter(isSlackWebhookUrl);
    if (slackUrls.length === 0) return;

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    });
    const pageUrl = workspace
      ? `${origin}/w/${workspace.slug}/${input.pageId}`
      : origin;
    const body = JSON.stringify(
      pageUpdatedSlackMessage({
        actorName: input.actorName,
        pageTitle: input.pageTitle,
        pageUrl,
      }),
    );
    await Promise.all(
      slackUrls.map(async (url) => {
        try {
          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
          });
        } catch {
          /* outbound Slack must never break the edit */
        }
      }),
    );
  } catch {
    /* never break the caller */
  }
}

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

    // A `PageFollow` row outlives the membership that justified it: a person
    // who was removed from the workspace (or who left) still has the row, so
    // the followers are re-checked against the workspace's current members
    // before anybody is notified. The notice carries the page's title, so it
    // is a read of the workspace — only its members may receive it.
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: page.workspaceId, userId: { in: followerIds } },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((member) => member.userId));
    const currentFollowers = followerIds.filter((id) => memberIds.has(id));
    if (currentFollowers.length === 0) return;

    const now = new Date();
    const [users, recent] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: currentFollowers } },
        select: { id: true, notificationPrefs: true },
      }),
      prisma.notification.findMany({
        where: {
          type: "page.updated",
          userId: { in: currentFollowers },
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
      { followers: currentFollowers, prefs },
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
    // Secondary channel (outbound Slack): build the Block Kit payload with
    // `slack-blocks` and post it to Slack incoming webhooks. Best-effort — its
    // own guard swallows failures so the edit never fails (R82.8).
    await postSlackPageUpdate(page.workspaceId, {
      actorName: actor.name,
      pageTitle: page.title,
      pageId: page.id,
    });
  } catch (error) {
    // R82.8 — never fail the edit that triggered the dispatch.
    console.warn("notifyPageUpdated: dispatch failed", error);
  }
}

/** Upper bound on the tickets one assignment notice may describe (defence in depth). */
const TICKET_ASSIGNED_MAX = 200;

/**
 * Tell someone they were handed a ticket.
 *
 * The assignment paths (`createTicketAction`, `updateTicketAction`,
 * `bulkUpdateTicketsAction`) used to write `assigneeId` and the activity log and
 * nothing else, so a person could be assigned a ticket and never hear about it -
 * the inbox only ever had rows for mentions, replies, shares and page edits.
 * This is the missing dispatch.
 *
 * It is deliberately **state-checked rather than argument-trusted**, because
 * this file is a `"use server"` module and therefore a callable endpoint:
 *
 *  - the actor is re-derived from the session and must be able to edit content
 *    in the workspace, so a forged call cannot notify anyone;
 *  - the tickets are re-read from the database (scoped to the workspace) instead
 *    of trusting titles passed by the caller;
 *  - only tickets that are *currently* assigned to the target are described, so
 *    a call can only ever tell someone about work they actually hold;
 *  - the target's own preferences decide delivery through `resolveRecipients`
 *    (`ticket.assigned` is a directed event: the assignee is the only watcher, the
 *    actor is excluded, the per-type in-app toggle and quiet hours apply).
 *
 * Best-effort: a dispatch failure is logged and the assignment itself still
 * succeeds (R82.8), exactly like `notifyPageUpdated`.
 */
export async function notifyTicketAssigned(input: {
  workspaceId: string;
  assigneeId: string;
  /** The tickets that changed hands; already-assigned ones are filtered out here. */
  ticketIds: readonly string[];
  projectId?: string | null;
}): Promise<void> {
  try {
    if (input.ticketIds.length === 0) return;

    const actor = await requireUser();
    if (input.assigneeId === actor.id) return; // assigning yourself is not news

    const actorAccess = await getWorkspaceAccess(actor.id, input.workspaceId);
    if (!actorAccess || !canEditContent(actorAccess.role)) return;
    const assigneeAccess = await getWorkspaceAccess(input.assigneeId, input.workspaceId);
    if (!assigneeAccess) return; // an inbox is a delivery channel: members only

    const ids = [...new Set(input.ticketIds)].slice(0, TICKET_ASSIGNED_MAX);
    const tickets = await prisma.ticket.findMany({
      where: {
        id: { in: ids },
        workspaceId: input.workspaceId,
        assigneeId: input.assigneeId,
      },
      select: { id: true, title: true },
      orderBy: { id: "asc" },
    });
    if (tickets.length === 0) return;

    const assignee = await prisma.user.findUnique({
      where: { id: input.assigneeId },
      select: { notificationPrefs: true },
    });
    if (!assignee) return;

    const recipients = resolveRecipients(
      { type: "ticket.assigned", actorId: actor.id, at: new Date() },
      {
        watchers: [input.assigneeId],
        prefs: { [input.assigneeId]: parseEnginePrefs(assignee.notificationPrefs) },
      },
    );
    if (recipients.length === 0) return;

    const [first] = tickets;
    await prisma.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        type: "ticket.assigned",
        payload: {
          workspaceId: input.workspaceId,
          ticketId: first.id,
          title: first.title,
          count: tickets.length,
          projectId: input.projectId ?? null,
          actorId: actor.id,
        },
      })),
    });
    revalidatePath("/w", "layout");
  } catch (error) {
    // R82.8 — never fail the edit that triggered the dispatch.
    console.warn("notifyTicketAssigned: dispatch failed", error);
  }
}

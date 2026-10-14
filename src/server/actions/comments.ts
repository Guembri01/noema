"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { commentSchema } from "@/lib/validation";
import { dispatchWebhooks } from "@/lib/webhooks";
import { logActivity } from "@/lib/activity";
import { extractMentions, mentionMatches } from "@/lib/comments";

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

export async function addCommentAction(input: {
  pageId: string;
  body: string;
  parentId?: string | null;
  blockId?: string;
  quote?: string;
}): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  const parsed = commentSchema.safeParse({
    pageId: input.pageId,
    body: input.body,
    parentId: input.parentId ?? null,
    blockId: input.blockId,
    quote: input.quote,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid comment." };
  }

  const page = await prisma.page.findUnique({
    where: { id: parsed.data.pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to comment." };
  }

  const comment = await prisma.comment.create({
    data: {
      pageId: parsed.data.pageId,
      parentId: parsed.data.parentId ?? null,
      blockId: parsed.data.blockId,
      quote: parsed.data.quote?.trim() || null,
      authorId: user.id,
      body: parsed.data.body,
    },
    select: { id: true },
  });

  if (parsed.data.parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: parsed.data.parentId },
      select: { authorId: true },
    });
    if (parent && parent.authorId !== user.id) {
      await prisma.notification.create({
        data: {
          userId: parent.authorId,
          type: "comment.reply",
          payload: { pageId: parsed.data.pageId, commentId: comment.id },
        },
      });
    }
  }

  // Mentions: `@Ada` or `@ada@example.com` notifies workspace members whose name
  // (or email address) matches. The author is never notified of themselves.
  const mentions = extractMentions(parsed.data.body);
  if (mentions.length > 0) {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: page.workspaceId },
      select: { userId: true, user: { select: { name: true, email: true } } },
    });
    const targets = members.filter(
      (member) =>
        member.userId !== user.id &&
        mentions.some((mention) => mentionMatches(mention, member.user)),
    );
    if (targets.length > 0) {
      await prisma.notification.createMany({
        data: targets.map((target) => ({
          userId: target.userId,
          type: "page.mention",
          payload: { pageId: parsed.data.pageId, commentId: comment.id },
        })),
      });
    }
  }

  await logActivity({
    workspaceId: page.workspaceId,
    actorId: user.id,
    action: "comment.created",
    targetType: "comment",
    targetId: comment.id,
    meta: { pageId: parsed.data.pageId },
  });

  await dispatchWebhooks(page.workspaceId, "comment.created", {
    pageId: parsed.data.pageId,
    commentId: comment.id,
  });
  revalidatePath(`/w`, "layout");
  return { ok: true, id: comment.id };
}

/** Add or remove your emoji reaction on a comment. */
export async function toggleCommentReactionAction(
  commentId: string,
  emoji: string,
): Promise<Result<{ reacted: boolean }>> {
  const user = await requireUser();
  const clean = emoji.trim().slice(0, 8);
  if (!clean) return { error: "Pick an emoji." };
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, page: { select: { workspaceId: true } } },
  });
  if (!comment) return { error: "Comment not found." };
  const access = await getWorkspaceAccess(user.id, comment.page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to react." };
  }

  const existing = await prisma.commentReaction.findUnique({
    where: { commentId_userId_emoji: { commentId, userId: user.id, emoji: clean } },
    select: { id: true },
  });
  if (existing) {
    await prisma.commentReaction.delete({ where: { id: existing.id } });
    revalidatePath("/w", "layout");
    return { ok: true, reacted: false };
  }
  await prisma.commentReaction.create({
    data: { commentId, userId: user.id, emoji: clean },
  });
  revalidatePath("/w", "layout");
  return { ok: true, reacted: true };
}

/** Edit a comment you wrote (admins can fix anyone's). */
export async function editCommentAction(
  commentId: string,
  body: string,
): Promise<Result<{ edited: boolean }>> {
  const user = await requireUser();
  const text = (body ?? "").trim();
  if (!text) return { error: "A comment cannot be empty." };
  if (text.length > 4000) return { error: "That comment is too long." };

  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, pageId: true, authorId: true, page: { select: { workspaceId: true } } },
  });
  if (!comment) return { error: "Comment not found." };
  const access = await getWorkspaceAccess(user.id, comment.page.workspaceId);
  if (!access || !canEditContent(access.role)) return { error: "No permission." };
  const isAdmin = access.role === "OWNER" || access.role === "ADMIN";
  if (comment.authorId !== user.id && !isAdmin) {
    return { error: "You can only edit your own comments." };
  }

  await prisma.comment.update({ where: { id: commentId }, data: { body: text } });
  revalidatePath("/w", "layout");
  return { ok: true, edited: true };
}

export async function resolveCommentAction(
  commentId: string,
  resolved: boolean,
): Promise<Result> {  const user = await requireUser();
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, pageId: true, page: { select: { workspaceId: true } } },
  });
  if (!comment) return { error: "Comment not found." };
  const access = await getWorkspaceAccess(user.id, comment.page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "No permission." };
  }
  await prisma.comment.update({
    where: { id: commentId },
    data: { resolved },
  });
  revalidatePath(`/w`, "layout");
  return { ok: true };
}

export async function deleteCommentAction(
  commentId: string,
): Promise<Result> {
  const user = await requireUser();
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true, page: { select: { workspaceId: true } } },
  });
  if (!comment) return { error: "Comment not found." };
  const access = await getWorkspaceAccess(user.id, comment.page.workspaceId);
  if (!access) return { error: "No access." };
  if (comment.authorId !== user.id && !canEditContent(access.role)) {
    return { error: "You can only delete your own comments." };
  }
  await prisma.comment.delete({ where: { id: commentId } });
  revalidatePath(`/w`, "layout");
  return { ok: true };
}

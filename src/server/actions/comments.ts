"use server";

import { revalidatePath } from "next/cache";
import type { SharePermission, WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { guestReadablePageIds } from "@/lib/guest-access";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { commentSchema } from "@/lib/validation";
import { dispatchWebhooks } from "@/lib/webhooks";
import { logActivity } from "@/lib/activity";
import { extractMentions, mentionMatches } from "@/lib/comments";
import {
  validateThreadDepth,
  type Comment as ThreadComment,
  type DepthIssueReason,
} from "@/lib/comment-threads";

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

/**
 * The page-level comment gate shared by every comment action.
 *
 * Workspace membership is not enough: a page `READ` row (or a guest outside
 * the guest read scope) must not be able to add, edit, resolve or delete
 * comments. `COMMENT` and above may comment; editing stays separate.
 */
async function commentPermissionError(input: {
  userId: string;
  pageId: string;
  workspaceId: string;
  role: WorkspaceRole;
  permissions: readonly { level: SharePermission }[] | null | undefined;
}): Promise<string | null> {
  if (!pageCapabilitiesFromRelation(input.role, input.permissions).comment) {
    return "You do not have permission to comment.";
  }
  if (input.role === "GUEST") {
    const readable = await guestReadablePageIds(input.userId, input.workspaceId);
    if (!readable.has(input.pageId)) return "Page not found.";
  }
  return null;
}

/**
 * Distinct copy per `validateThreadDepth` issue so a rejected reply tells the
 * author why (R79.1). `cross-thread-parent`/`cycle` are defensive: the chain we
 * feed the validator is linear, so they should not fire on live data.
 */
const REPLY_DEPTH_ERRORS: Record<DepthIssueReason, string> = {
  "missing-parent": "The comment you are replying to no longer exists.",
  "cross-thread-parent": "That comment belongs to a different thread.",
  "max-depth-exceeded": "Replies can only be one level deep.",
  cycle: "That comment's thread is malformed.",
};

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
    select: {
      workspaceId: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "You do not have permission to comment." };
  const denied = await commentPermissionError({
    userId: user.id,
    pageId: parsed.data.pageId,
    workspaceId: page.workspaceId,
    role: access.role,
    permissions: page.permissions,
  });
  if (denied) return { error: denied };

  // Thread depth is enforced before the write (R79.1): a reply may only target
  // a thread root, so a reply-to-a-reply creates no row. We walk the prospective
  // parent's ancestor chain, add the pending reply, and let the pure thread model
  // (`validateThreadDepth`, maxDepth 1) flag it. Done before `create` so a bad
  // target never reaches the database.
  //
  // The notification deep-link target: the block anchor belongs to the thread
  // root, so a reply reuses the parent's anchor instead of the reply's own
  // (null) one.
  let threadBlockId: string | undefined = parsed.data.blockId;

  if (parsed.data.parentId) {
    const parentId = parsed.data.parentId;
    const ancestors: ThreadComment[] = [];
    const seenIds = new Set<string>();
    let parentPageId: string | undefined;
    let cursor: string | null = parentId;
    while (cursor !== null && !seenIds.has(cursor)) {
      seenIds.add(cursor);
      const row: {
        id: string;
        parentId: string | null;
        pageId: string;
        authorId: string;
        body: string;
        createdAt: Date;
      } | null = await prisma.comment.findUnique({
        where: { id: cursor },
        select: {
          id: true,
          parentId: true,
          pageId: true,
          authorId: true,
          body: true,
          createdAt: true,
        },
      });
      if (!row) break;
      if (ancestors.length === 0) parentPageId = row.pageId;
      ancestors.push({
        id: row.id,
        threadId: row.parentId ?? row.id,
        parentId: row.parentId ?? undefined,
        authorId: row.authorId,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
      });
      cursor = row.parentId;
    }

    if (parentPageId !== undefined && parentPageId !== parsed.data.pageId) {
      return { error: "That comment belongs to a different page." };
    }

    const threadId = ancestors[ancestors.length - 1]?.id ?? parentId;
    const pending: ThreadComment = {
      id: "__pending_reply__",
      threadId,
      parentId,
      authorId: user.id,
      body: parsed.data.body,
      createdAt: new Date().toISOString(),
    };
    const issue = validateThreadDepth([...ancestors, pending], { maxDepth: 1 }).find(
      (candidate) => candidate.commentId === pending.id,
    );
    if (issue) return { error: REPLY_DEPTH_ERRORS[issue.reason] };
  }

  const comment = await prisma.comment.create({
    data: {
      pageId: parsed.data.pageId,
      parentId: parsed.data.parentId ?? null,
      // Anchors belong to the thread root: a reply is rendered inside its
      // parent's thread, so storing a second anchor would only create a jump
      // target that the thread UI never shows.
      blockId: parsed.data.parentId ? undefined : parsed.data.blockId,
      quote: parsed.data.parentId ? null : parsed.data.quote?.trim() || null,
      authorId: user.id,
      body: parsed.data.body,
    },
    select: { id: true },
  });

  if (parsed.data.parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: parsed.data.parentId },
      select: { authorId: true, blockId: true },
    });
    threadBlockId = parent?.blockId ?? undefined;
    if (parent && parent.authorId !== user.id) {
      // The reply reaches the author of the parent comment only while they
      // still are a member of the workspace — the mention path below resolves
      // the same set before it writes a row. A member who was removed must not
      // be told that somebody answered their comment.
      const parentAccess = await getWorkspaceAccess(parent.authorId, page.workspaceId);
      if (parentAccess) {
        await prisma.notification.create({
          data: {
            userId: parent.authorId,
            type: "comment.reply",
            // B136: the payload names the workspace, like the other two
            // notification types do — without it the row cannot be attributed
            // to a workspace at all.
            payload: {
              workspaceId: page.workspaceId,
              pageId: parsed.data.pageId,
              commentId: comment.id,
              ...(threadBlockId ? { blockId: threadBlockId } : {}),
            },
          },
        });
      }
    }
  }

  // Mentions: `@Ada` or `@ada@example.com` notifies workspace members whose name
  // (or email address) matches. The author is never notified of themselves.
  const mentions = extractMentions(parsed.data.body);
  if (mentions.length > 0) {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: page.workspaceId },
      select: {
        userId: true,
        role: true,
        user: { select: { name: true, email: true } },
      },
    });
    const targets = members.filter(
      (member) =>
        member.userId !== user.id &&
        mentions.some((mention) => mentionMatches(mention, member.user)),
    );
    // A guest only reaches the pages in their read scope. A mention is a
    // notification carrying the page id, so a guest outside that scope must
    // not receive it (and must not learn that the page exists) even though
    // they are a workspace member. Members and admins reach the whole
    // workspace, and an explicit page READ row still lets them open the page.
    const deliverable: typeof targets = [];
    for (const target of targets) {
      if (target.role !== "GUEST") {
        deliverable.push(target);
        continue;
      }
      const readable = await guestReadablePageIds(
        target.userId,
        page.workspaceId,
      );
      if (readable.has(parsed.data.pageId)) deliverable.push(target);
    }
    if (deliverable.length > 0) {
      await prisma.notification.createMany({
        data: deliverable.map((target) => ({
          userId: target.userId,
          type: "page.mention",
          // B136: the payload names the workspace, like the other two
          // notification types do — without it the row cannot be attributed
          // to a workspace at all.
          payload: {
            workspaceId: page.workspaceId,
            pageId: parsed.data.pageId,
            commentId: comment.id,
            ...(threadBlockId ? { blockId: threadBlockId } : {}),
          },
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
    select: {
      id: true,
      pageId: true,
      page: {
        select: {
          workspaceId: true,
          permissions: {
            where: { userId: user.id },
            select: { level: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!comment) return { error: "Comment not found." };
  const access = await getWorkspaceAccess(user.id, comment.page.workspaceId);
  if (!access) return { error: "You do not have permission to react." };
  const denied = await commentPermissionError({
    userId: user.id,
    pageId: comment.pageId,
    workspaceId: comment.page.workspaceId,
    role: access.role,
    permissions: comment.page.permissions,
  });
  if (denied) return { error: denied };

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
    select: {
      id: true,
      pageId: true,
      authorId: true,
      page: {
        select: {
          workspaceId: true,
          permissions: {
            where: { userId: user.id },
            select: { level: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!comment) return { error: "Comment not found." };
  const access = await getWorkspaceAccess(user.id, comment.page.workspaceId);
  if (!access) return { error: "No permission." };
  const denied = await commentPermissionError({
    userId: user.id,
    pageId: comment.pageId,
    workspaceId: comment.page.workspaceId,
    role: access.role,
    permissions: comment.page.permissions,
  });
  if (denied) return { error: denied };
  const isAdmin = access.role === "OWNER" || access.role === "ADMIN";
  if (comment.authorId !== user.id && !isAdmin) {
    return { error: "You can only edit your own comments." };
  }

  await prisma.comment.update({ where: { id: commentId }, data: { body: text } });
  await logActivity({
    workspaceId: comment.page.workspaceId,
    actorId: user.id,
    action: "comment.edited",
    targetType: "comment",
    targetId: commentId,
    meta: { pageId: comment.pageId },
  });
  revalidatePath("/w", "layout");
  return { ok: true, edited: true };
}

export async function resolveCommentAction(
  commentId: string,
  resolved: boolean,
): Promise<Result> {
  const user = await requireUser();
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      pageId: true,
      page: {
        select: {
          workspaceId: true,
          permissions: {
            where: { userId: user.id },
            select: { level: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!comment) return { error: "Comment not found." };
  const access = await getWorkspaceAccess(user.id, comment.page.workspaceId);
  if (!access) return { error: "No permission." };
  const denied = await commentPermissionError({
    userId: user.id,
    pageId: comment.pageId,
    workspaceId: comment.page.workspaceId,
    role: access.role,
    permissions: comment.page.permissions,
  });
  if (denied) return { error: denied };
  await prisma.comment.update({
    where: { id: commentId },
    data: { resolved },
  });
  await logActivity({
    workspaceId: comment.page.workspaceId,
    actorId: user.id,
    action: "comment.resolved",
    targetType: "comment",
    targetId: commentId,
    meta: { pageId: comment.pageId, resolved },
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
    select: {
      id: true,
      pageId: true,
      authorId: true,
      page: {
        select: {
          workspaceId: true,
          permissions: {
            where: { userId: user.id },
            select: { level: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!comment) return { error: "Comment not found." };
  const access = await getWorkspaceAccess(user.id, comment.page.workspaceId);
  if (!access) return { error: "No access." };
  const denied = await commentPermissionError({
    userId: user.id,
    pageId: comment.pageId,
    workspaceId: comment.page.workspaceId,
    role: access.role,
    permissions: comment.page.permissions,
  });
  if (denied) return { error: denied };
  const canModerate = pageCapabilitiesFromRelation(
    access.role,
    comment.page.permissions,
  ).edit;
  if (comment.authorId !== user.id && !canModerate) {
    return { error: "You can only delete your own comments." };
  }
  await prisma.comment.delete({ where: { id: commentId } });
  await logActivity({
    workspaceId: comment.page.workspaceId,
    actorId: user.id,
    action: "comment.deleted",
    targetType: "comment",
    targetId: commentId,
    meta: { pageId: comment.pageId },
  });
  revalidatePath(`/w`, "layout");
  return { ok: true };
}

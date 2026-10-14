"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { stripLoneSurrogates } from "@/lib/utils";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { linkifyReferences } from "@/lib/chat-context";
import { buildChatRequest } from "@/lib/chat-runtime";
import { chatComplete, resolveAiConfig } from "@/lib/ai-provider";

export type ChatResult<T = unknown> = ({ ok: true } & T) | { error: string };

const DEFAULT_TITLE = "New discussion";
/** Messages that start with this are answered by the assistant. */
const CHAT_ASK_PREFIX = "/ask";

/**
 * Open a discussion, optionally pinned to a page ("discuss this note").
 * Clicking "New discussion" twice must not litter the sidebar, so an existing
 * empty thread is reused.
 */
export async function createChatThreadAction(
  workspaceId: string,
  title?: string,
  pageId?: string | null,
): Promise<ChatResult<{ id: string; reused: boolean }>> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to start a discussion." };
  }
  const requested = (title ?? "").trim().slice(0, 120);

  if (!requested) {
    const existing = await prisma.chatThread.findFirst({
      where: {
        workspaceId,
        createdById: user.id,
        pageId: pageId ?? null,
        title: DEFAULT_TITLE,
        messages: { none: {} },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (existing) return { ok: true, id: existing.id, reused: true };
  }

  if (pageId) {
    const page = await prisma.page.findUnique({
      where: { id: pageId },
      select: { workspaceId: true },
    });
    if (!page || page.workspaceId !== workspaceId) {
      return { error: "That page is not in this workspace." };
    }
  }

  const thread = await prisma.chatThread.create({
    data: {
      workspaceId,
      pageId: pageId ?? null,
      createdById: user.id,
      title: requested || DEFAULT_TITLE,
    },
    select: { id: true },
  });
  revalidatePath("/w", "layout");
  return { ok: true, id: thread.id, reused: false };
}

/**
 * Find (or open) the discussion attached to a page — used by the page menu's
 * "Discuss this note".
 */
export async function discussPageAction(
  pageId: string,
): Promise<ChatResult<{ threadId: string }>> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, title: true, workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to discuss this page." };
  }

  const existing = await prisma.chatThread.findFirst({
    where: { pageId, workspaceId: page.workspaceId },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (existing) return { ok: true, threadId: existing.id };

  const created = await createChatThreadAction(
    page.workspaceId,
    `Discussion · ${page.title || "Untitled"}`.slice(0, 120),
    pageId,
  );
  if ("error" in created) return created;
  return { ok: true, threadId: created.id };
}

/** Post a message; questions get an assistant reply grounded in the workspace. */export async function postChatMessageAction(
  threadId: string,
  body: string,
): Promise<ChatResult<{ id: string; title: string; answered: boolean }>> {
  const user = await requireUser();
  const message = (body ?? "").trim();
  if (!message) return { error: "Write something first." };
  if (message.length > 4000) return { error: "That message is too long." };

  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId },
    select: {
      workspaceId: true,
      pageId: true,
      title: true,
      _count: { select: { messages: true } },
    },
  });
  if (!thread) return { error: "Discussion not found." };
  const access = await getWorkspaceAccess(user.id, thread.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to post here." };
  }

  const created = await prisma.chatMessage.create({
    data: { threadId, userId: user.id, role: "user", body: message },
    select: { id: true },
  });

  // The first message names the discussion (Notion-style).
  const untitled = !thread.title.trim() || thread.title === DEFAULT_TITLE;
  let title = thread.title;
  if (thread._count.messages === 0 && untitled) {
    title = message.replace(CHAT_ASK_PREFIX, "").replace(/\s+/g, " ").trim().slice(0, 60) || title;
  }
  await prisma.chatThread.update({
    where: { id: threadId },
    data: { updatedAt: new Date(), title },
  });

  // Every conversation is an AI conversation: answer from the workspace data the
  // question needs (notes, members, projects/milestones, tasks). The `/ask`
  // prefix stays supported for muscle memory.
  const answered = await replyAsAssistant(threadId, {
    workspaceId: thread.workspaceId,
    pageId: thread.pageId,
    question: message.replace(new RegExp(`^\\${CHAT_ASK_PREFIX}\\s*`, "i"), "").trim(),
  });

  revalidatePath("/w", "layout");
  return { ok: true, id: created.id, title, answered };
}

/**
 * Ground the answer in the linked page (when there is one) and the workspace,
 * then store it as an assistant message. Silently no-ops when AI is off.
 */
async function replyAsAssistant(
  threadId: string,
  input: { workspaceId: string; pageId: string | null; question: string },
): Promise<boolean> {
  const config = await resolveAiConfig(input.workspaceId);
  if (!config) return false;

  // Route the question to the workspace data it needs (notes, members,
  // projects/milestones, tickets, tasks) — the "chat tools". The prompt lives in
  // chat-runtime so the streaming transport uses the identical contract.
  const request = await buildChatRequest({
    workspaceId: input.workspaceId,
    pageId: input.pageId,
    question: input.question,
  });

  const result = await chatComplete(
    {
      system: request.system,
      context: request.context,
      user: request.user,
      temperature: 0.3,
    },
    config,
  );
  if (!result.ok) return false;
  const answer = linkifyReferences(result.text.trim(), request.intel.references);
  if (!answer) return false;

  await prisma.chatMessage.create({
    data: {
      threadId,
      userId: null,
      role: "assistant",
      body: answer,
      meta: {
        activity: request.intel.activity,
        intents: request.intel.intents,
        references: request.intel.references,
        model: config.model,
        provider: config.source,
      },
    },
  });
  return true;
}
/**
 * Save an assistant answer as a real page in the workspace, so a good synthesis
 * becomes durable content instead of scrollback. The new page is linked from the
 * message so the same answer is never saved twice by accident.
 */
export async function saveChatAnswerAction(
  messageId: string,
): Promise<ChatResult<{ pageId: string; title: string }>> {
  const user = await requireUser();
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      role: true,
      body: true,
      meta: true,
      thread: { select: { id: true, workspaceId: true, pageId: true, title: true } },
    },
  });
  if (!message) return { error: "Message not found." };
  const access = await getWorkspaceAccess(user.id, message.thread.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create pages in this workspace." };
  }

  const { markdownToTipTap } = await import("@/lib/markdown");
  // Bound the page we create: answers are short by prompt, but nothing enforces it.
  const answer = stripLoneSurrogates(message.body).slice(0, 20_000);
  const blocks = markdownToTipTap(answer);

  // Title: the first heading if there is one, else the first non-empty line.
  const firstLine = answer.split("\n").map((line) => line.trim()).find(Boolean) ?? "AI answer";
  const heading = /^#{1,6}\s+(.*)$/.exec(firstLine)?.[1];
  const title =
    (heading ?? firstLine.replace(/^[>*-]\s*/, "")).replace(/[*_`#]/g, "").trim().slice(0, 80) ||
    "AI answer";

  // Sit next to the discussion's own page when it has one, otherwise at the root.
  const parentId = message.thread.pageId ?? null;
  const last = await prisma.page.findFirst({
    where: { workspaceId: message.thread.workspaceId, parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const page = await prisma.page.create({
    data: {
      workspaceId: message.thread.workspaceId,
      parentId,
      title,
      icon: "✨",
      createdById: user.id,
      position: (last?.position ?? 0) + 1000,
      content: { type: "doc", content: blocks } as Prisma.InputJsonValue,
    },
    select: { id: true, title: true },
  });

  const meta =
    message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
      ? (message.meta as Record<string, unknown>)
      : {};
  await prisma.chatMessage.update({
    where: { id: messageId },
    data: { meta: { ...meta, savedPageId: page.id, savedPageTitle: page.title } },
  });

  revalidatePath("/w", "layout");
  return { ok: true, pageId: page.id, title: page.title };
}

/** Replace the last answer with a fresh one (same question, new generation). */
export async function regenerateChatAnswerAction(
  threadId: string,
): Promise<ChatResult<{ answered: boolean }>> {
  const user = await requireUser();
  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId },
    select: { workspaceId: true, pageId: true },
  });
  if (!thread) return { error: "Discussion not found." };
  const access = await getWorkspaceAccess(user.id, thread.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to change this discussion." };
  }

  const [lastAnswer, lastQuestion] = await Promise.all([
    prisma.chatMessage.findFirst({
      where: { threadId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
    prisma.chatMessage.findFirst({
      where: { threadId, role: "user" },
      orderBy: { createdAt: "desc" },
      select: { body: true },
    }),
  ]);
  // Lossless replace (R25.4): capture the new answer first and only swap the
  // old one out once it is on disk — a failed or unconfigured regenerate must
  // never eat the previous answer. deleteMany keeps the swap idempotent when
  // two regenerates race (the second delete is a no-op, not a P2025 throw).
  const answered = await replyAsAssistant(threadId, {
    workspaceId: thread.workspaceId,
    pageId: thread.pageId,
    question: lastQuestion?.body ?? "",
  });
  if (answered && lastAnswer) {
    await prisma.chatMessage.deleteMany({ where: { id: lastAnswer.id } });
  }
  revalidatePath("/w", "layout");
  return { ok: true, answered };
}

/** Rename a discussion thread. */
export async function renameChatThreadAction(
  threadId: string,
  title: string,
): Promise<ChatResult> {
  const user = await requireUser();
  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId },
    select: { workspaceId: true },
  });
  if (!thread) return { error: "Discussion not found." };
  const access = await getWorkspaceAccess(user.id, thread.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to rename this discussion." };
  }
  await prisma.chatThread.update({
    where: { id: threadId },
    data: { title: title.trim().slice(0, 120) || DEFAULT_TITLE },
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Delete a discussion thread (and its messages). */
export async function deleteChatThreadAction(threadId: string): Promise<ChatResult> {
  const user = await requireUser();
  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId },
    select: { workspaceId: true },
  });
  if (!thread) return { error: "Discussion not found." };
  const access = await getWorkspaceAccess(user.id, thread.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to delete this discussion." };
  }
  await prisma.chatThread.delete({ where: { id: threadId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

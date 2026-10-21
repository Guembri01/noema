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
import { conversationSessionId } from "@/lib/ai-session";
import { effectiveChatModel } from "@/lib/chat-model";
import { assertScopedParent } from "@/lib/page-parent";
import {
  planChatAction,
  proposalBody,
  proposalLabel,
  resolveTicketRef,
  sameProposal,
  statusLabel,
  type ChatActionPlan,
  type ChatActionProposal,
} from "@/lib/chat-actions";
import {
  archiveTicketAction,
  createTicketAction,
  moveTicketAction,
  toggleTicketLabelAction,
  updateTicketAction,
} from "@/server/actions/tickets";
import { createPageAction } from "@/server/actions/pages";

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
  /** The page open in the UI, so "this page" can be answered about. */
  activePageId?: string | null,
  /** The model chosen for this conversation; the configured one when omitted. */
  model?: string | null,
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
  const question = message.replace(new RegExp(`^\\${CHAT_ASK_PREFIX}\\s*`, "i"), "").trim();

  // An explicit request to change data becomes a proposal the UI confirms —
  // the model is never asked to perform (or claim) a mutation.
  const plan = await planChatAction(thread.workspaceId, question);
  if (plan) {
    await persistChatActionPlan(threadId, plan);
    revalidatePath("/w", "layout");
    return { ok: true, id: created.id, title, answered: true };
  }

  const answered = await replyAsAssistant(threadId, {
    workspaceId: thread.workspaceId,
    pageId: thread.pageId,
    activePageId: activePageId ?? null,
    question,
    model,
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
  input: {
    workspaceId: string;
    /** The page the thread is pinned to. */
    pageId: string | null;
    /** The page the user is looking at, if any. */
    activePageId?: string | null;
    question: string;
    /** The model chosen for this conversation; the configured one when omitted. */
    model?: string | null;
  },
): Promise<boolean> {
  const config = await resolveAiConfig(input.workspaceId);
  if (!config) return false;

  // The conversation's model, when one was chosen. Only the model *id* can
  // come from a caller, so the provider, endpoint and key stay the workspace's.
  const chosenModel = effectiveChatModel(config.model, input.model);

  // Route the question to the workspace data it needs (notes, members,
  // projects/milestones, tickets, tasks) — the "chat tools". The prompt lives in
  // chat-runtime so the streaming transport uses the identical contract.
  const request = await buildChatRequest({
    workspaceId: input.workspaceId,
    pageId: input.pageId,
    activePageId: input.activePageId ?? null,
    question: input.question,
  });

  const result = await chatComplete(
    {
      system: request.system,
      context: request.context,
      user: request.user,
      temperature: 0.3,
    },
    // The session is the discussion's own id, so the provider can route and
    // cache per conversation.
    { ...config, model: chosenModel, sessionId: conversationSessionId(threadId) },
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
        model: chosenModel,
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
  // `ChatThread.pageId` is a plain foreign key, so the thread row does not prove
  // that the page lives in the thread's workspace — check it before the new
  // page is written under it (B08).
  const parent = await assertScopedParent({
    workspaceId: message.thread.workspaceId,
    parentId: message.thread.pageId ?? null,
  });
  if ("error" in parent) return parent;
  const parentId = parent.parentId;
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
  /** The model chosen for this conversation; the configured one when omitted. */
  model?: string | null,
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
    model,
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

/* -------------------------------------------------------------------------- *
 * Chat actions — deterministic propose/confirm, then execute through the real
 * ticket/page actions (same permission checks, same activity trail).
 * -------------------------------------------------------------------------- */

/** Store the deterministic assistant turn for a parsed action plan. */
async function persistChatActionPlan(threadId: string, plan: ChatActionPlan): Promise<void> {
  if (plan.status === "clarify") {
    await prisma.chatMessage.create({
      data: {
        threadId,
        userId: null,
        role: "assistant",
        body: plan.message,
        meta: { activity: ["Asked a clarifying question"] },
      },
    });
    return;
  }
  const { proposal } = plan;
  await prisma.chatMessage.create({
    data: {
      threadId,
      userId: null,
      role: "assistant",
      body: proposalBody(proposal),
      meta: {
        proposal,
        activity: [`Prepared: ${proposalLabel(proposal.kind)}`],
        intents: [],
      },
    },
  });
}

/** Resolve (and workspace-check) the ticket an action targets. */
async function resolveActionTicket(
  workspaceId: string,
  args: { ticketId?: string; ticketKey?: string; ticketRef?: string },
): Promise<{ ok: true; id: string; key: string } | { ok: false; error: string }> {
  if (args.ticketId) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: args.ticketId },
      select: { id: true, key: true, workspaceId: true },
    });
    if (!ticket || ticket.workspaceId !== workspaceId) {
      return { ok: false, error: "That ticket is not in this workspace." };
    }
    return { ok: true, id: ticket.id, key: ticket.key };
  }
  if (!args.ticketRef) return { ok: false, error: "That action is missing its ticket." };
  const resolved = await resolveTicketRef(workspaceId, args.ticketRef);
  if (!resolved.ok) {
    return { ok: false, error: `I couldn't find a ticket matching "${args.ticketRef}".` };
  }
  return { ok: true, id: resolved.ticket.id, key: resolved.ticket.key };
}

/** A workspace member by name or email ("me" is the acting user). */
async function resolveAssigneeId(
  workspaceId: string,
  name: string,
  actorId: string,
): Promise<string | null> {
  const trimmed = name.trim();
  if (/^(me|myself)$/i.test(trimmed)) return actorId;
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      owner: { select: { id: true, name: true, email: true } },
      members: { select: { user: { select: { id: true, name: true, email: true } } } },
    },
  });
  if (!workspace) return null;
  const people = [workspace.owner, ...workspace.members.map((member) => member.user)];
  const needle = trimmed.toLowerCase();
  const exact = people.find(
    (person) => person.name.toLowerCase() === needle || person.email.toLowerCase() === needle,
  );
  if (exact) return exact.id;
  const partial = people.filter((person) => person.name.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0].id : null;
}

/** A project by name within the workspace (exact, then unique partial). */
async function resolveProjectId(workspaceId: string, name: string): Promise<string | null> {
  const trimmed = name.trim();
  const exact = await prisma.project.findFirst({
    where: { workspaceId, name: { equals: trimmed, mode: "insensitive" } },
    select: { id: true },
  });
  if (exact) return exact.id;
  const partial = await prisma.project.findMany({
    where: { workspaceId, name: { contains: trimmed, mode: "insensitive" } },
    take: 5,
    select: { id: true },
  });
  return partial.length === 1 ? partial[0].id : null;
}

/** Existing workspace labels matching the given names (unknown ones are skipped). */
async function resolveLabelIds(workspaceId: string, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const label = await prisma.label.findFirst({
      where: { workspaceId, name: { equals: name.trim(), mode: "insensitive" } },
      select: { id: true },
    });
    if (label) ids.push(label.id);
  }
  return ids;
}

/**
 * The proposal a confirmation names: the assistant turn that stored it.
 *
 * A confirmation is bound to a proposal of *this* thread that is still pending.
 * One that was never stored, belongs to another thread or was already applied
 * cannot be confirmed — without that binding any caller could have the chat
 * apply an action nobody ever proposed (B17).
 */
async function loadPendingProposal(
  threadId: string,
  proposalMessageId: string,
): Promise<{ proposal: ChatActionProposal; meta: Record<string, unknown> } | null> {
  const message = await prisma.chatMessage.findUnique({
    where: { id: proposalMessageId },
    select: { threadId: true, meta: true },
  });
  if (!message || message.threadId !== threadId) return null;
  const meta =
    message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
      ? (message.meta as Record<string, unknown>)
      : null;
  if (!meta || meta.applied === true) return null;
  const proposal = meta.proposal;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return null;
  return { proposal: proposal as ChatActionProposal, meta };
}

/**
 * Apply a confirmed chat action. This is the ONLY path that changes data from
 * the chat: it re-checks workspace permission, resolves names to ids, and
 * delegates to the existing ticket/page server actions (so the same guards and
 * the same activity trail apply). The assistant's confirmation is appended to
 * the thread and the proposal turn is marked applied.
 *
 * The confirmation is bound to the stored proposal: the caller names the
 * proposal turn it confirms, and only the proposal that turn stored is applied
 * (B17).
 */
export async function executeChatActionAction(input: {
  threadId: string;
  action: ChatActionProposal;
  proposalMessageId?: string | null;
}): Promise<ChatResult<{ message: string }>> {
  const user = await requireUser();
  const thread = await prisma.chatThread.findUnique({
    where: { id: input.threadId },
    select: { id: true, workspaceId: true },
  });
  if (!thread) return { error: "Discussion not found." };
  const access = await getWorkspaceAccess(user.id, thread.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to change this workspace." };
  }
  const workspaceId = thread.workspaceId;
  const { action: requested } = input;
  if (!requested || !requested.kind) return { error: "That action is no longer valid." };

  // The stored proposal is the one that may be applied — never the copy the
  // caller sent.
  const proposalMessageId =
    typeof input.proposalMessageId === "string" ? input.proposalMessageId.trim() : "";
  const stored = proposalMessageId
    ? await loadPendingProposal(thread.id, proposalMessageId)
    : null;
  if (!stored) return { error: "That proposal is no longer available." };
  if (!sameProposal(stored.proposal, requested)) {
    return { error: "That proposal does not match the request." };
  }
  // Claim the proposal before acting. The check in `loadPendingProposal` is a
  // read, so two confirmations that arrive together could both pass it; the
  // conditional update makes exactly one of them the winner. The flag is put
  // back if the action itself fails.
  const claim = await prisma.chatMessage.updateMany({
    where: {
      id: proposalMessageId,
      threadId: thread.id,
      NOT: { meta: { path: ["applied"], equals: true } },
    },
    data: { meta: { ...stored.meta, applied: true } as Prisma.InputJsonValue },
  });
  if (claim.count !== 1) return { error: "That proposal is no longer available." };
  const action = stored.proposal;

  let message: string;
  let activity: string;
  try {
    switch (action.kind) {
      case "createTicket": {
        const title = (action.args.title ?? "").trim();
        if (!title) return { error: "Give the ticket a title." };
        const payload: Parameters<typeof createTicketAction>[0] = { workspaceId, title };
        if (action.args.status) payload.status = action.args.status;
        if (action.args.priority) payload.priority = action.args.priority;
        if (action.args.estimate !== undefined) payload.estimate = action.args.estimate;
        if (action.args.estimateUnit) payload.estimateUnit = action.args.estimateUnit;
        if (action.args.dueDate) payload.dueDate = action.args.dueDate;
        if (action.args.assigneeName) {
          const assigneeId = await resolveAssigneeId(workspaceId, action.args.assigneeName, user.id);
          if (!assigneeId) {
            return { error: `I couldn't find a member matching "${action.args.assigneeName}".` };
          }
          payload.assigneeId = assigneeId;
        }
        if (action.args.projectName) {
          const projectId = await resolveProjectId(workspaceId, action.args.projectName);
          if (!projectId) {
            return { error: `I couldn't find a project matching "${action.args.projectName}".` };
          }
          payload.projectId = projectId;
        }
        if (action.args.labels && action.args.labels.length > 0) {
          payload.labelIds = await resolveLabelIds(workspaceId, action.args.labels);
        }
        const created = await createTicketAction(payload);
        if ("error" in created) return { error: created.error };
        message = `Created **${title}** — ${created.key}.`;
        activity = `Created ${created.key}`;
        break;
      }
      case "createNote": {
        const title = (action.args.title ?? "").trim();
        if (!title) return { error: "Give the note a title." };
        const created = await createPageAction({ workspaceId, title });
        if ("error" in created) return { error: created.error };
        message = `Created note **${title}**.`;
        activity = `Created note ${title}`;
        break;
      }
      case "updateTicket": {
        const ticket = await resolveActionTicket(workspaceId, action.args);
        if (!ticket.ok) return { error: ticket.error };
        const changes = action.args.changes ?? {};
        const payload: Parameters<typeof updateTicketAction>[0] = { ticketId: ticket.id };
        if (changes.status) payload.status = changes.status;
        if (changes.priority) payload.priority = changes.priority;
        if (changes.estimate !== undefined) payload.estimate = changes.estimate;
        if (changes.estimateUnit) payload.estimateUnit = changes.estimateUnit;
        if (changes.dueDate) payload.dueDate = changes.dueDate;
        if (changes.assigneeName) {
          const assigneeId = await resolveAssigneeId(workspaceId, changes.assigneeName, user.id);
          if (!assigneeId) {
            return { error: `I couldn't find a member matching "${changes.assigneeName}".` };
          }
          payload.assigneeId = assigneeId;
        }
        if (changes.projectName) {
          const projectId = await resolveProjectId(workspaceId, changes.projectName);
          if (!projectId) {
            return { error: `I couldn't find a project matching "${changes.projectName}".` };
          }
          payload.projectId = projectId;
        }
        const updated = await updateTicketAction(payload);
        if ("error" in updated) return { error: updated.error };
        if (changes.labels && changes.labels.length > 0) {
          const labelIds = await resolveLabelIds(workspaceId, changes.labels);
          const attached = await prisma.ticketLabel.findMany({
            where: { ticketId: ticket.id },
            select: { labelId: true },
          });
          const present = new Set(attached.map((row) => row.labelId));
          for (const labelId of labelIds) {
            if (present.has(labelId)) continue;
            const toggled = await toggleTicketLabelAction(ticket.id, labelId);
            if ("error" in toggled) return { error: toggled.error };
          }
        }
        message = `Updated **${ticket.key}**.`;
        activity = `Updated ${ticket.key}`;
        break;
      }
      case "moveTicket": {
        const ticket = await resolveActionTicket(workspaceId, action.args);
        if (!ticket.ok) return { error: ticket.error };
        const status = action.args.status ?? "";
        const moved = await moveTicketAction({ ticketId: ticket.id, status });
        if ("error" in moved) return { error: moved.error };
        message = `Moved **${ticket.key}** to ${statusLabel(status)}.`;
        activity = `Moved ${ticket.key}`;
        break;
      }
      case "archiveTicket": {
        const ticket = await resolveActionTicket(workspaceId, action.args);
        if (!ticket.ok) return { error: ticket.error };
        const archived = await archiveTicketAction(ticket.id, true);
        if ("error" in archived) return { error: archived.error };
        message = `Archived **${ticket.key}**.`;
        activity = `Archived ${ticket.key}`;
        break;
      }
      case "deleteTicket": {
        const ticket = await resolveActionTicket(workspaceId, action.args);
        if (!ticket.ok) return { error: ticket.error };
        const row = await prisma.ticket.findUnique({
          where: { id: ticket.id },
          select: { title: true },
        });
        await prisma.ticket.delete({ where: { id: ticket.id } });
        // The ticket's own activity cascades away, so record the deletion on the
        // workspace trail instead.
        await prisma.activity
          .create({
            data: {
              workspaceId,
              actorId: user.id,
              action: "ticket.deleted",
              targetType: "ticket",
              targetId: ticket.id,
              meta: { key: ticket.key, title: row?.title ?? null },
            },
          })
          .catch(() => undefined);
        message = `Deleted **${ticket.key}**${row?.title ? ` — ${row.title}` : ""}.`;
        activity = `Deleted ${ticket.key}`;
        break;
      }
      default:
        return { error: "That action is not supported." };
    }
  } catch (error) {
    // The action did not run, so the proposal is still pending. Put the flag
    // back; the next confirmation can try again.
    await prisma.chatMessage
      .update({
        where: { id: proposalMessageId },
        data: { meta: stored.meta as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
    return { error: error instanceof Error ? error.message : "The action could not be applied." };
  }

  await prisma.chatMessage.create({
    data: {
      threadId: thread.id,
      userId: null,
      role: "assistant",
      body: message,
      meta: { activity: [activity], appliedAction: action.kind },
    },
  });

  // The proposal turn is already marked applied by the claim above; the
  // confirm button stays hidden from here on.

  revalidatePath("/w", "layout");
  return { ok: true, message };
}

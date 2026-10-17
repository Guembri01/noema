import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/api-guard";
import { prisma } from "@/lib/db";
import { resolveAiConfig, chatCompleteStream, providerClass } from "@/lib/ai-provider";
import { buildChatRequest } from "@/lib/chat-runtime";
import { effectiveChatModel } from "@/lib/chat-model";
import { linkifyReferences } from "@/lib/chat-context";
import {
  planChatAction,
  proposalBody,
  proposalLabel,
  type ChatActionProposal,
} from "@/lib/chat-actions";
import { executeChatActionAction } from "@/server/actions/chat";

export const runtime = "nodejs";

const STREAM_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
} as const;

/** A one-shot response that streams a fixed, deterministic string. */
function textStream(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { headers: STREAM_HEADERS });
}

/**
 * POST /api/chat/stream — the same grounded answer as `postChatMessageAction`,
 * but streamed token by token.
 *
 * The user message is persisted before the stream starts, and the assistant
 * message when it ends, so the database stays the source of truth and a dropped
 * connection leaves no half-written row.
 *
 * Body: `{ threadId, body }`
 *
 * The chat action layer runs before the model. An explicit "create / update /
 * move / delete / archive a ticket" or "create a note" request never reaches the
 * model: it becomes a deterministic proposal the UI renders as a confirm
 * button. Body `{ threadId, confirm, proposalMessageId? }` applies a confirmed
 * proposal through the real server actions (the only path that changes data).
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "chat-stream", 20, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: {
    threadId?: string;
    body?: string;
    confirm?: ChatActionProposal;
    proposalMessageId?: string | null;
    /** The page open in the UI, so "this page" has a referent. Untrusted: it is
     *  resolved scoped to the thread's workspace, so a foreign id resolves to
     *  nothing rather than leaking a title. */
    pageId?: string | null;
    /** The model chosen for this conversation. Untrusted: only the model *id* is
     *  honoured — provider, endpoint and key stay the resolved workspace ones —
     *  so a crafted body cannot aim the call at another host. */
    model?: string | null;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // --- Confirmation: apply a previously proposed action ---------------------
  if (payload.confirm && payload.threadId) {
    const result = await executeChatActionAction({
      threadId: payload.threadId,
      action: payload.confirm,
      proposalMessageId: payload.proposalMessageId ?? null,
    });
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json(result);
  }

  const message = (payload.body ?? "").trim().slice(0, 4000);
  if (!message) return NextResponse.json({ error: "Write something first." }, { status: 400 });

  const thread = await prisma.chatThread.findUnique({
    where: { id: payload.threadId ?? "" },
    select: { id: true, workspaceId: true, pageId: true, title: true, _count: { select: { messages: true } } },
  });
  if (!thread) return NextResponse.json({ error: "Discussion not found." }, { status: 404 });

  const access = await getWorkspaceAccess(user.id, thread.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return NextResponse.json({ error: "You do not have permission to post here." }, { status: 403 });
  }

  // Persist the question first (and name the thread on its first message).
  await prisma.chatMessage.create({
    data: { threadId: thread.id, userId: user.id, role: "user", body: message },
  });
  if (thread._count.messages === 0 && (!thread.title.trim() || thread.title === "New discussion")) {
    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        updatedAt: new Date(),
        title: message.replace(/\s+/g, " ").slice(0, 60) || thread.title,
      },
    });
  }

  // --- Chat actions: deterministic, no model, no blind execution ------------
  const plan = await planChatAction(thread.workspaceId, message);
  if (plan) {
    const body = plan.status === "clarify" ? plan.message : proposalBody(plan.proposal);
    const meta =
      plan.status === "clarify"
        ? { activity: ["Asked a clarifying question"] }
        : {
            proposal: plan.proposal,
            activity: [`Prepared: ${proposalLabel(plan.proposal.kind)}`],
            intents: [],
          };
    await prisma.chatMessage
      .create({
        data: { threadId: thread.id, userId: null, role: "assistant", body, meta },
      })
      .catch(() => undefined);
    return textStream(body);
  }

  // --- Otherwise answer from the workspace with the configured model --------
  const config = await resolveAiConfig(thread.workspaceId);
  if (!config) {
    return NextResponse.json({ error: "AI is not configured for this workspace." }, { status: 503 });
  }

  // The conversation's model, when one was chosen. Only the model *id* can
  // come from the request: provider, endpoint and key stay the ones resolved
  // for this workspace, so a crafted body cannot aim the call at another host.
  const requestConfig = { ...config, model: effectiveChatModel(config.model, payload.model) };

  const chatRequest = await buildChatRequest({
    workspaceId: thread.workspaceId,
    pageId: thread.pageId,
    activePageId: typeof payload.pageId === "string" ? payload.pageId.slice(0, 64) : null,
    question: message,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answer = "";
      try {
        for await (const delta of chatCompleteStream(
          {
            system: chatRequest.system,
            context: chatRequest.context,
            user: chatRequest.user,
            temperature: 0.3,
          },
          requestConfig,
        )) {
          answer += delta;
          controller.enqueue(encoder.encode(delta));
        }
      } catch (error) {
        // The failure travels in-band *and* into the persisted assistant
        // message, so both carry a class, never provider or runtime text: the
        // runtime's transport message can carry the request header, and the
        // header carries the workspace's key.
        const detail = providerClass(error);
        // The status is already 200, so the failure travels in-band and the client
        // surfaces it next to the partial answer.
        controller.enqueue(encoder.encode(`\n\n[stream-error] ${detail}`));
        answer = answer || `I could not answer that: ${detail}`;
      }

      const body = linkifyReferences(answer.trim(), chatRequest.intel.references);
      if (body) {
        await prisma.chatMessage
          .create({
            data: {
              threadId: thread.id,
              userId: null,
              role: "assistant",
              body,
              meta: {
                activity: chatRequest.intel.activity,
                intents: chatRequest.intel.intents,
                references: chatRequest.intel.references,
                model: requestConfig.model,
                provider: config.source,
              },
            },
          })
          .catch(() => undefined);
      }
      controller.close();
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}

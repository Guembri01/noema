import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/api-guard";
import { prisma } from "@/lib/db";
import { resolveAiConfig, chatCompleteStream } from "@/lib/ai-provider";
import { buildChatRequest } from "@/lib/chat-runtime";
import { linkifyReferences } from "@/lib/chat-context";

export const runtime = "nodejs";

/**
 * POST /api/chat/stream — the same grounded answer as `postChatMessageAction`,
 * but streamed token by token.
 *
 * The user message is persisted before the stream starts, and the assistant
 * message when it ends, so the database stays the source of truth and a dropped
 * connection leaves no half-written row.
 *
 * Body: `{ threadId, body }`
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "chat-stream", 20, 60_000);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: { threadId?: string; body?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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

  const config = await resolveAiConfig(thread.workspaceId);
  if (!config) {
    return NextResponse.json({ error: "AI is not configured for this workspace." }, { status: 503 });
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

  const chatRequest = await buildChatRequest({
    workspaceId: thread.workspaceId,
    pageId: thread.pageId,
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
          config,
        )) {
          answer += delta;
          controller.enqueue(encoder.encode(delta));
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "AI request failed";
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
                model: config.model,
                provider: config.source,
              },
            },
          })
          .catch(() => undefined);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

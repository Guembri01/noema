import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { rateLimit } from "@/lib/api-guard";
import {
  bodyReadError,
  MAX_JSON_BODY_BYTES,
  readJsonBody,
} from "@/lib/body-limit";
import { getChatThreadsWithMessages } from "@/server/queries";
import {
  createChatThreadAction,
  deleteChatThreadAction,
  postChatMessageAction,
  renameChatThreadAction,
} from "@/server/actions/chat";

export const runtime = "nodejs";

/** List the workspace's discussions with their recent messages. */
export async function GET(request: Request) {
  const limited = rateLimit(request, "chat-read", 120, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  return NextResponse.json({ threads: await getChatThreadsWithMessages(workspaceId) });
}

/**
 * Discussion mutations. Body: { action: "create" | "post" | "rename" | "delete", … }
 * The same server actions back the sidebar UI.
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "chat-write", 60, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    action?: string;
    workspaceId?: string;
    threadId?: string;
    title?: string;
    body?: string;
  };
  try {
    body = await readJsonBody<typeof body>(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Invalid JSON body.");
  }

  let result: { ok: true } & Record<string, unknown> | { error: string };
  switch (body.action) {
    case "create":
      result = await createChatThreadAction(String(body.workspaceId ?? ""), body.title);
      break;
    case "post":
      result = await postChatMessageAction(String(body.threadId ?? ""), String(body.body ?? ""));
      break;
    case "rename":
      result = await renameChatThreadAction(String(body.threadId ?? ""), String(body.title ?? ""));
      break;
    case "delete":
      result = await deleteChatThreadAction(String(body.threadId ?? ""));
      break;
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}

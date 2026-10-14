import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { searchPagesForPrompt } from "@/server/queries";
import { rateLimit } from "@/lib/api-guard";
import { AI_NOT_CONFIGURED, chatComplete, resolveAiConfig } from "@/lib/ai-provider";

export const runtime = "nodejs";

/**
 * Small AI proxy (OpenAI-compatible chat completions). Modes:
 *   ask       — answer a prompt, optionally grounded in workspace search
 *   summarize — summarize the provided context
 * Configure with AI_API_KEY (required), AI_BASE_URL and AI_MODEL. Returns 503
 * with guidance when unconfigured so the "Ask AI" block degrades gracefully.
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "ai", 30, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { prompt?: string; context?: string; mode?: string; workspaceId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mode =
    body.mode === "summarize"
      ? "summarize"
      : body.mode === "autofill"
        ? "autofill"
        : "ask";
  const prompt = (body.prompt ?? "").trim().slice(0, 4000);
  let context = (body.context ?? "").slice(0, 8000);

  if (mode === "summarize" && !context) {
    return NextResponse.json({ error: "context is required to summarize" }, { status: 400 });
  }
  if (mode === "autofill" && !prompt) {
    return NextResponse.json({ error: "prompt is required to autofill" }, { status: 400 });
  }
  if (mode === "ask" && !prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  // Ground "ask" in the workspace when a workspace id is supplied.
  if (mode === "ask" && body.workspaceId) {
    const access = await getWorkspaceAccess(user.id, body.workspaceId);
    if (access && prompt) {
      const results = await searchPagesForPrompt(body.workspaceId, prompt, 5);
      const grounding = results
        .map((page) => `- ${page.title}: ${page.snippet}`.trim())
        .join("\n");
      if (grounding) {
        context = `${context ? `${context}\n\n` : ""}Workspace matches:\n${grounding}`.slice(0, 8000);
      }
    }
  }

  const system =
    mode === "summarize"
      ? "You summarize the provided notes as GitHub-flavoured Markdown: one sentence of synthesis first, then short `-` bullets for the key points, and `**bold**` for the two or three terms that matter. No preamble, no closing pleasantries."
      : mode === "autofill"
        ? "You fill a single database cell. Reply with ONLY the value, no quotes, no explanation, no trailing punctuation."
        : "You are a writing assistant embedded in a notes app. Reply in GitHub-flavoured Markdown: answer in the first sentence, then use short `-` bullets, `**bold**` for key terms, `| a | b |` tables to compare, and fenced code blocks for code. Answer only from the provided context when context is given.";

  const config = await resolveAiConfig(body.workspaceId);
  if (!config) {
    return NextResponse.json({ error: AI_NOT_CONFIGURED }, { status: 503 });
  }

  const result = await chatComplete(
    {
      system,
      context: context || undefined,
      user: mode === "summarize" ? "Summarize the context above." : prompt,
      temperature: mode === "autofill" ? 0.1 : 0.4,
      ...(mode === "autofill" ? { maxTokens: 60 } : {}),
    },
    config,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ text: result.text });
}

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { searchPagesForPrompt } from "@/server/queries";
import { rateLimit } from "@/lib/api-guard";
import { AI_NOT_CONFIGURED, chatComplete, resolveAiConfig } from "@/lib/ai-provider";
import { assembleContext, estimateTokens, type ContextDoc } from "@/lib/ai-context";

export const runtime = "nodejs";

/** Default token window for the request prompt when the client sends none. */
const DEFAULT_MAX_TOKENS = 2000;
/** Hard floor/ceiling (in tokens) for a client-supplied prompt budget. */
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 8000;

/** Clamp an untrusted client budget to a finite, sane token window. */
function clampMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(value)));
}

/**
 * Split the joined context blob into paragraph blocks in input order. Later
 * blocks are treated as the most recent, so `assembleContext` keeps them first
 * and drops the oldest blocks when the token budget is tight.
 */
function contextToDocs(context: string): ContextDoc[] {
  const blocks = context
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  return blocks.map((text, index) => ({ id: `context-${index}`, text, priority: index }));
}

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

  let body: {
    prompt?: string;
    context?: string;
    mode?: string;
    workspaceId?: string;
    maxTokens?: number;
  };
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
      // Ground only in the pages the caller may open: a guest gets the pages
      // shared with them, a member the whole workspace. An empty guest scope
      // grounds in nothing rather than in everything.
      const visiblePageIds = await pageScopeFor(user.id, body.workspaceId, access.role);
      const results = await searchPagesForPrompt(
        body.workspaceId,
        prompt,
        visiblePageIds,
        5,
      );
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

  // Budget the request prompt: `system` and the user's question are mandatory,
  // so the client's token window is spent on the context blocks (oldest first to
  // be dropped). `maxTokens` is clamped to a sane range.
  const userMessage = mode === "summarize" ? "Summarize the context above." : prompt;
  const maxTokens = clampMaxTokens(body.maxTokens);
  const contextBudget = Math.max(0, maxTokens - estimateTokens(system) - estimateTokens(userMessage));
  const { prompt: budgetedContext } = assembleContext({
    docs: contextToDocs(context),
    question: "",
    maxTokens: contextBudget,
  });

  const config = await resolveAiConfig(body.workspaceId);
  if (!config) {
    return NextResponse.json({ error: AI_NOT_CONFIGURED }, { status: 503 });
  }

  const result = await chatComplete(
    {
      system,
      context: budgetedContext || undefined,
      user: userMessage,
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

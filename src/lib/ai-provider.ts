/**
 * Shared AI provider client.
 *
 * Any OpenAI-compatible endpoint works: OpenAI, DeepSeek, Gemini (via its
 * OpenAI-compatible surface), Ollama, vLLM… A workspace can store its own
 * provider + model + key (settings → AI); otherwise the environment defaults
 * (AI_API_KEY / AI_BASE_URL / AI_MODEL) apply. Keeping resolution and transport
 * here means every route reports failures the same way.
 */

import { prisma } from "./db";
import { decryptSecret } from "./secrets";
import { providerDefaultBaseUrl, normalizeBaseUrl } from "./ai-providers";
import { checkBudget, estimateTokens, recordUsage, type BudgetRecord } from "./ai-cost";
import { getWorkspaceAccess } from "./permissions";

export const AI_NOT_CONFIGURED =
  "AI is not configured. Add a provider in workspace settings (AI) or set AI_API_KEY / AI_BASE_URL / AI_MODEL.";

export const AI_BUDGET_EXCEEDED =
  "The workspace AI token budget is exhausted for this period. Raise AI_BUDGET_TOKENS or wait for the next period.";

export type AiRuntimeConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  source: "workspace" | "env";
  /** Workspace the call is billed to; absent for the env/global defaults. */
  workspaceId?: string;
};

/**
 * Monthly token ceiling for every AI call, read from `AI_BUDGET_TOKENS`.
 * A missing, non-numeric or non-positive value disables enforcement (the
 * default), so self-hosters who never set it keep unmetered behaviour. The
 * budget engine (`./ai-cost`) is the gate; this only supplies the limit.
 */
export function aiBudgetLimitTokens(): number {
  const raw = Number(process.env.AI_BUDGET_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** The calendar-month period key (`YYYY-MM`, UTC) a budget belongs to. */
export function budgetPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * In-process usage ledger keyed by workspace + provider + model. Token usage
 * accrues here for the life of the process; `resetAiBudgetLedger` clears it
 * (tests invoke it between cases). Durable, cross-instance accounting is a
 * follow-up once a budget table exists — the *enforcement* path below is the
 * real one either way.
 */
const usageLedger = new Map<string, BudgetRecord>();

function budgetKey(config: AiRuntimeConfig): string {
  return `${config.workspaceId ?? "env"}:${config.provider}:${config.model}`;
}

/** The current budget record for a config, or `null` when enforcement is off. */
function loadBudget(config: AiRuntimeConfig): BudgetRecord | null {
  const limitTokens = aiBudgetLimitTokens();
  if (limitTokens <= 0) return null;
  const key = budgetKey(config);
  const existing = usageLedger.get(key);
  if (existing && existing.limitTokens === limitTokens) return existing;
  return {
    workspaceId: config.workspaceId ?? "env",
    period: budgetPeriod(),
    limitTokens,
    usedInput: 0,
    usedOutput: 0,
    spendUsd: 0,
  };
}

/** Forget the in-process usage ledger (tests and maintenance). */
export function resetAiBudgetLedger(): void {
  usageLedger.clear();
}

/** Estimated prompt tokens for a chat request (spec `chars / 4` heuristic). */
function promptTokens(input: { system: string; user?: string; context?: string }): number {
  const text = [input.system, input.context, input.user]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  return estimateTokens(text);
}

export type ChatMessage = { role: "system" | "user"; content: string };

export type ChatResult =
  | { ok: true; text: string }
  | { ok: false; status: number; error: string };

function envConfig(): AiRuntimeConfig | null {
  const apiKey =
    process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return null;
  return {
    provider: "env",
    baseUrl: normalizeBaseUrl(process.env.AI_BASE_URL ?? "https://api.openai.com/v1"),
    model: process.env.AI_MODEL ?? "gpt-4o-mini",
    apiKey,
    source: "env",
  };
}

export function envAiConfig(): AiRuntimeConfig | null {
  return envConfig();
}

/** Workspace config when configured and enabled, else the env defaults. */
export async function resolveAiConfig(
  workspaceId?: string | null,
): Promise<AiRuntimeConfig | null> {
  if (workspaceId) {
    const stored = await prisma.aiProviderConfig
      .findUnique({ where: { workspaceId }, select: { provider: true, baseUrl: true, model: true, apiKeyEncrypted: true, enabled: true } })
      .catch(() => null);
    if (stored?.enabled) {
      const apiKey = decryptSecret(stored.apiKeyEncrypted);
      const baseUrl = normalizeBaseUrl(stored.baseUrl ?? providerDefaultBaseUrl(stored.provider));
      if (apiKey && baseUrl && stored.model) {
        return {
          provider: stored.provider,
          baseUrl,
          model: stored.model,
          apiKey,
          source: "workspace",
          workspaceId,
        };
      }
    }
  }
  return envConfig();
}

/**
 * Resolve the provider config a *user* is allowed to use.
 *
 * A workspace's stored provider (endpoint + decrypted API key) belongs to that
 * workspace, so it may only be used when the caller actually has access to it.
 * `resolveAiConfig` has no user context, so every route that takes a
 * workspace id from the client must go through this helper — otherwise any
 * signed-in account could make the server call another workspace's provider
 * with that workspace's key and token budget (audit B13). Without access the
 * environment defaults apply; the foreign provider row is never even read.
 */
export async function resolveAiConfigForUser(
  userId: string,
  workspaceId?: string | null,
): Promise<AiRuntimeConfig | null> {
  if (workspaceId) {
    const access = await getWorkspaceAccess(userId, workspaceId);
    if (access) return resolveAiConfig(workspaceId);
  }
  return resolveAiConfig(null);
}

/** Run a chat completion against an OpenAI-compatible endpoint. */
export async function chatComplete(
  input: {
    system: string;
    user?: string;
    context?: string;
    temperature?: number;
    maxTokens?: number;
  },
  config: AiRuntimeConfig,
): Promise<ChatResult> {
  const messages: ChatMessage[] = [{ role: "system", content: input.system }];
  if (input.context) {
    messages.push({ role: "user", content: `Context:\n${input.context}` });
  }
  if (input.user) messages.push({ role: "user", content: input.user });

  // Cost control: refuse the call up-front when it would cross the workspace's
  // token ceiling. `checkBudget` is inclusive, so a request landing exactly on
  // the limit is still allowed. Enforcement is off unless AI_BUDGET_TOKENS is
  // set, so the default deployment is unaffected.
  const estimatedPromptTokens = promptTokens(input);
  const budget = loadBudget(config);
  if (budget) {
    const verdict = checkBudget(budget, {
      estimatedTokens: estimatedPromptTokens + (input.maxTokens ?? 0),
      model: config.model,
    });
    if (!verdict.allowed) {
      return { ok: false, status: 429, error: AI_BUDGET_EXCEEDED };
    }
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: input.temperature ?? 0.4,
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        status: 502,
        error: `AI provider error (${response.status}): ${text.slice(0, 200)}`,
      };
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";

    // Meter the call against the budget. Providers usually report token usage;
    // when one does not, fall back to the same `chars / 4` estimate the
    // pre-flight check used, so limits still hold under real traffic.
    if (budget) {
      const recorded = recordUsage(budget, {
        model: config.model,
        inputTokens: data.usage?.prompt_tokens ?? estimatedPromptTokens,
        outputTokens: data.usage?.completion_tokens ?? estimateTokens(text),
        surface: "chat",
        period: budgetPeriod(),
      });
      usageLedger.set(budgetKey(config), recorded);
    }

    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "AI request failed",
    };
  }
}

/** Streaming variant: yields text deltas as the provider produces them. */
export async function* chatCompleteStream(
  input: {
    system: string;
    user?: string;
    context?: string;
    temperature?: number;
    maxTokens?: number;
  },
  config: AiRuntimeConfig,
): AsyncGenerator<string, void, unknown> {
  const messages: ChatMessage[] = [{ role: "system", content: input.system }];
  if (input.context) messages.push({ role: "user", content: `Context:\n${input.context}` });
  if (input.user) messages.push({ role: "user", content: input.user });

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: input.temperature ?? 0.4,
      stream: true,
      ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI provider error (${response.status}): ${detail.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const event = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Ignore keep-alive comments and partial frames.
      }
    }
  }
}

/** Fetch the provider's live model list (falls back to the catalog upstream). */
export async function listProviderModels(
  config: { baseUrl: string; apiKey: string },
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { ok: false, error: `Could not list models (${response.status}).` };
    }
    const data = (await response.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => Boolean(id))
      .sort();
    if (models.length === 0) return { ok: false, error: "The provider returned no models." };
    return { ok: true, models };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach the provider.",
    };
  }
}

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

export const AI_NOT_CONFIGURED =
  "AI is not configured. Add a provider in workspace settings (AI) or set AI_API_KEY / AI_BASE_URL / AI_MODEL.";

export type AiRuntimeConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  source: "workspace" | "env";
};

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
        };
      }
    }
  }
  return envConfig();
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
    };
    return { ok: true, text: data.choices?.[0]?.message?.content ?? "" };
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

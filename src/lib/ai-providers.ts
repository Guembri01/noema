/**
 * AI provider catalog.
 *
 * Every provider is reached through its OpenAI-compatible surface, so one
 * client shape covers all of them:
 *   OpenAI   https://api.openai.com/v1
 *   DeepSeek https://api.deepseek.com
 *   Gemini   https://generativelanguage.googleapis.com/v1beta/openai
 *   Custom   anything OpenAI-compatible (Ollama, vLLM, LiteLLM, Azure proxy…)
 *
 * The listed models are a curated default; the settings UI can also fetch the
 * live list from `GET {baseUrl}/models`.
 */

export type ProviderId = "openai" | "deepseek" | "gemini" | "custom";

export type ProviderModel = { id: string; label: string };

export type ProviderDefinition = {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string;
  keyHint: string;
  docsUrl: string;
  models: ProviderModel[];
};

export const AI_PROVIDERS: ProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyHint: "sk-…",
    docsUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4o", label: "GPT-4o (balanced)" },
      { id: "gpt-4o-mini", label: "GPT-4o mini (fast, cheap)" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
      { id: "o3-mini", label: "o3-mini (reasoning)" },
      { id: "o1", label: "o1 (reasoning)" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    keyHint: "sk-…",
    docsUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat (V3)" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)" },
      { id: "deepseek-flash", label: "DeepSeek Flash" },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyHint: "AIza…",
    docsUrl: "https://aistudio.google.com/app/apikey",
    models: [
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    ],
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    defaultBaseUrl: "",
    keyHint: "any token the endpoint expects",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
    models: [],
  },
];

export function providerDefinition(id: string | null | undefined): ProviderDefinition | undefined {
  return AI_PROVIDERS.find((provider) => provider.id === id);
}

export function providerDefaultBaseUrl(id: string): string {
  return providerDefinition(id)?.defaultBaseUrl ?? "";
}

/** Normalise a user-typed base URL (no trailing slash, https by default). */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

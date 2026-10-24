/**
 * AI provider catalog.
 *
 * Every provider is reached through its OpenAI-compatible surface, so one
 * client shape covers all of them:
 *   OpenAI   https://api.openai.com/v1
 *   DeepSeek https://api.deepseek.com
 *   Gemini   https://generativelanguage.googleapis.com/v1beta/openai
 *   Go       https://opencode.ai/inference/go/openai/v1
 *   Custom   anything OpenAI-compatible (Ollama, vLLM, LiteLLM, Azure proxy…)
 *
 * The listed models are a curated default; the settings UI can also fetch the
 * live list from the provider's catalogue URL (`GET {baseUrl}/models` for most
 * providers, a path of its own for Go).
 */

export type ProviderId = "openai" | "deepseek" | "gemini" | "opencode-go" | "custom";

export type ProviderModel = { id: string; label: string };

export type ProviderDefinition = {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string;
  keyHint: string;
  docsUrl: string;
  models: ProviderModel[];
  /**
   * Where the provider publishes its model catalogue, when that is not
   * `<baseUrl>/models`. Go publishes it under `/inference/go/v1/models` while
   * its chat endpoint lives under `/inference/go/openai/v1` — two paths, one
   * provider.
   */
  modelsUrl?: string;
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
    id: "opencode-go",
    label: "OpenCode Go",
    defaultBaseUrl: "https://opencode.ai/inference/go/openai/v1",
    keyHint: "key from opencode.ai/console",
    docsUrl: "https://opencode.ai/console",
    // The catalogue does not live under the chat endpoint's path.
    modelsUrl: "https://opencode.ai/inference/go/v1/models",
    // Only the models behind Go's OpenAI-compatible surface
    // (`/inference/go/openai/v1/chat/completions`) can be called at all: the
    // Anthropic, Google and Responses models need a transport Noema does not
    // speak. The live list holds more of them — those are not offered here.
    models: [
      { id: "glm-5.3-flash", label: "GLM-5.3 Flash" },
      { id: "glm-5.3", label: "GLM-5.3" },
      { id: "glm-5.2", label: "GLM-5.2" },
      { id: "kimi-k3", label: "Kimi K3" },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
      { id: "longcat-2.0", label: "LongCat 2.0" },
      { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "mimo-v2.6-flash", label: "MiMo-V2.6 Flash" },
      { id: "mimo-v2.6-pro", label: "MiMo-V2.6 Pro" },
      { id: "mimo-v2.5", label: "MiMo-V2.5" },
      { id: "mimo-v2.5-pro", label: "MiMo-V2.5 Pro" },
      { id: "minimax-m3.1-flash-free", label: "MiniMax M3.1 Flash (free)" },
      { id: "longcat-2.5-preview-free", label: "LongCat 2.5 Preview (free)" },
      { id: "step-5-preview", label: "Step 5 Preview" },
      { id: "beam-free", label: "Beam (free)" },
      { id: "hy4-preview", label: "Hy4 (preview)" },
      { id: "hy3", label: "Hy3" },
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

/** The lower-case host of a URL, or `""` when it is not one. */
function urlHost(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The catalogue entry a base URL belongs to, or `null` for an unknown endpoint.
 *
 * A deployment can name a provider by its base URL alone — this repo's `.env` sets
 * `AI_BASE_URL` and `AI_MODEL` and nothing else, which resolves to `custom`. That
 * is right for transport (any OpenAI-compatible endpoint works), but it leaves the
 * model picker with an empty catalogue: it can show the model in use and nothing
 * to switch to. The host is enough to recognise the documented endpoints, so the
 * list comes back.
 */
export function providerForBaseUrl(baseUrl: string | null | undefined): ProviderId | null {
  const host = urlHost(baseUrl);
  if (!host) return null;
  for (const definition of AI_PROVIDERS) {
    const known = urlHost(definition.defaultBaseUrl);
    if (!known) continue;
    // The documented host, or a regional subdomain of it (`eu.api.openai.com`).
    if (host === known || host.endsWith(`.${known}`)) return definition.id;
    // An apex the deployment may have configured instead. The dot keeps a bare
    // public suffix ("com") from matching every provider at once.
    if (host.includes(".") && known.endsWith(`.${host}`)) return definition.id;
  }
  return null;
}

export function providerDefaultBaseUrl(id: string): string {
  return providerDefinition(id)?.defaultBaseUrl ?? "";
}

/**
 * True when the endpoint is an OpenCode Go endpoint.
 *
 * Go asks its clients for a user agent of their own and for a stable session
 * id in `x-opencode-session` (https://opencode.ai/v2/docs/console/go/). The
 * host is what tells the endpoint apart — the path does not, and a deployment
 * may reach Go through a proxy under another name.
 */
export function isOpenCodeGoEndpoint(baseUrl: string | null | undefined): boolean {
  const host = urlHost(baseUrl);
  if (!host) return false;
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

/**
 * The URL the provider's model catalogue is read from.
 *
 * Most providers publish it at `<baseUrl>/models`. Go does not: its catalogue
 * lives at `https://opencode.ai/inference/go/v1/models` while its chat
 * endpoint lives under `…/openai/v1` — asking the chat endpoint's path for
 * the catalogue answers 404.
 */
export function providerModelsUrl(
  providerId: string | null | undefined,
  baseUrl: string,
): string {
  const definition = providerDefinition(providerId);
  if (definition?.modelsUrl) return definition.modelsUrl;
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

/**
 * Normalise a user-typed base URL (no trailing slash, https by default).
 *
 * A value that already carries a scheme is returned untouched — including a
 * non-http one such as `file:` or `ftp:`. Silently rewriting those to `https:`
 * would hide an unsafe endpoint from validation; `classifyAiBaseUrl` is what
 * rejects them.
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Any other explicit scheme stays as typed so the validator can refuse it
  // instead of turning `file:///etc/passwd` into `https://file:///etc/passwd`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Hostnames that always mean "the operator's own machine". */
const LOCAL_AI_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal",
]);

/**
 * True when a hostname is loopback, a `.local` name, `host.docker.internal`
 * or an RFC1918 private address. These endpoints are allowed to use plain
 * `http:` and may be keyless: the traffic never leaves the operator's network.
 */
export function isLocalAiHost(hostname: string | null | undefined): boolean {
  const host = (hostname ?? "").trim().toLowerCase();
  if (!host) return false;
  if (LOCAL_AI_HOSTS.has(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.startsWith("169.254.")) return true;
  return false;
}

/** True when an absolute URL points at a loopback/private host. */
export function isLocalAiBaseUrl(value: string | null | undefined): boolean {
  const raw = (value ?? "").trim();
  if (!raw) return false;
  try {
    return isLocalAiHost(new URL(normalizeBaseUrl(raw)).hostname);
  } catch {
    return false;
  }
}

/** The verdict of {@link classifyAiBaseUrl}. */
export type AiBaseUrlCheck =
  | { ok: true; url: string; local: boolean }
  | { ok: false; error: string; url: string; local: boolean };

/** Query-parameter names that would smuggle a credential into a base URL. */
const CREDENTIAL_QUERY_PARAM =
  /^(api[_-]?key|key|token|access[_-]?token|auth|authorization|secret|password)$/i;

/**
 * Validate a provider base URL.
 *
 * The endpoint is user input, so it is checked before it is stored or called:
 *
 * - only absolute `http(s)` URLs are accepted (no `file:`, `ftp:`, `data:`…);
 * - a URL may not embed a credential in its user info
 *   (`https://user:secret@host/v1`) or in a query parameter (`?api_key=…`) —
 *   those would be stored and logged as part of the endpoint;
 * - plain `http:` is allowed only for loopback/private hosts; a remote
 *   provider must use TLS;
 * - a local (loopback/private) endpoint is reported as `local` so callers can
 *   allow it to be keyless.
 */
export function classifyAiBaseUrl(value: string | null | undefined): AiBaseUrlCheck {
  const raw = (value ?? "").trim();
  if (!raw) {
    return { ok: false, error: "A base URL is required.", url: "", local: false };
  }
  const url = normalizeBaseUrl(raw);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Base URL must be an absolute http(s) URL.", url, local: false };
  }

  const local = isLocalAiHost(parsed.hostname);
  const fail = (error: string): AiBaseUrlCheck => ({ ok: false, error, url, local });

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("Base URL must use the http or https scheme.");
  }
  if (!parsed.hostname) {
    return fail("Base URL must name a host.");
  }
  if (parsed.username || parsed.password) {
    return fail("Base URL must not embed a username or password.");
  }
  for (const [name] of parsed.searchParams) {
    if (CREDENTIAL_QUERY_PARAM.test(name)) {
      return fail("Base URL must not carry an API key or token in its query string.");
    }
  }
  if (parsed.protocol === "http:" && !local) {
    return fail("Plain http is only allowed for loopback or private endpoints.");
  }

  return { ok: true, url, local };
}

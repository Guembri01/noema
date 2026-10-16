/**
 * Local-model provider support engine — the pure, deterministic layer behind
 * §14 "Local model support" and the R25.8 keyless-provider story.
 *
 * Cloud and self-hosted models differ in three ways a UI must know about: the
 * endpoint shape (OpenAI-compatible `/chat/completions`, Ollama's native
 * `/api/chat`, Anthropic's `/messages`), whether an API key is mandatory, and
 * how large a request the context window admits. This module encodes all three
 * in one provider-free registry plus the small pure functions around it:
 *
 * - **`PROVIDERS`** — the supported runtimes (`ollama`, `lmstudio`,
 *   `llama.cpp`, `vllm`, `openai`, `anthropic`), each with its kind, base URL,
 *   default model, key requirement, streaming support and context window.
 * - **`parseProviderConfig` / `validateProviderConfig`** — normalize an
 *   untrusted stored/typed config, then check the URL scheme, the model and the
 *   key requirement without throwing.
 * - **`resolveChatEndpoint`** — turn a descriptor into `{url, headers,
 *   bodyShape}` for the OpenAI-compatible / Ollama / Anthropic shape.
 * - **`estimateContextFit`** — refuse a request whose prompt + completion
 *   budget would exceed the window.
 * - **`isLocal` / `describeProvider` / `pickProvider`** — classify a provider,
 *   render one line for settings, and choose one deterministically from an
 *   ordered preference list with a fallback.
 *
 * Design rules (same contract as the other `src/lib` helpers): pure and
 * immutable (nothing mutates its input), fail-safe (missing or malformed values
 * normalize to empty/0 instead of `NaN`), and deterministic (equal input always
 * yields identical output). No clock, no network, no DB, no `any`.
 */

/** The API flavor a provider speaks, which decides the endpoint and body. */
export type ProviderKind = "openai-compatible" | "ollama" | "llamacpp" | "anthropic";

/** The request-body envelope `resolveChatEndpoint` reports to the caller. */
export type ChatBodyShape = "openai" | "ollama" | "anthropic";

/** One model a provider advertises. */
export type ProviderModel = { id: string; label: string };

/** Everything the engine needs to route a call to one provider. */
export type ProviderDescriptor = {
  /** Stable registry id (e.g. `ollama`, `llama.cpp`). */
  id: string;
  /** Human-readable name for settings UI. */
  label: string;
  /** API flavor, which selects the endpoint path and body shape. */
  kind: ProviderKind;
  /** Default base URL; may be overridden by a user config. */
  baseUrl: string;
  /** Model used when a config names none. */
  defaultModel: string;
  /** Whether the provider refuses keyless requests. */
  requiresApiKey: boolean;
  /** Advertised models, at least the default one. */
  models: ProviderModel[];
  /** Whether the provider can stream token deltas. */
  supportsStreaming: boolean;
  /** Maximum prompt + completion tokens the provider accepts. */
  contextWindow: number;
};

/**
 * The supported providers in canonical (fallback) order: the four runtimes a
 * user can self-host first, then the two cloud APIs. `pickProvider` uses this
 * order as its deterministic fallback.
 */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "ollama",
    label: "Ollama",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    defaultModel: "llama3.1",
    requiresApiKey: false,
    models: [
      { id: "llama3.1", label: "Llama 3.1" },
      { id: "qwen2.5", label: "Qwen 2.5" },
      { id: "mistral", label: "Mistral" },
    ],
    supportsStreaming: true,
    contextWindow: 8_192,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    kind: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    requiresApiKey: false,
    models: [
      { id: "local-model", label: "Loaded model" },
      { id: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF", label: "Llama 3.1 8B (GGUF)" },
    ],
    supportsStreaming: true,
    contextWindow: 8_192,
  },
  {
    id: "llama.cpp",
    label: "llama.cpp",
    kind: "llamacpp",
    baseUrl: "http://localhost:8080/v1",
    defaultModel: "local-model",
    requiresApiKey: false,
    models: [
      { id: "local-model", label: "Served model" },
      { id: "ggml-org/gemma-3-4b-it-GGUF", label: "Gemma 3 4B (GGUF)" },
    ],
    supportsStreaming: true,
    contextWindow: 4_096,
  },
  {
    id: "vllm",
    label: "vLLM",
    kind: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    defaultModel: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    requiresApiKey: false,
    models: [
      { id: "meta-llama/Meta-Llama-3.1-8B-Instruct", label: "Llama 3.1 8B Instruct" },
      { id: "Qwen/Qwen2.5-7B-Instruct", label: "Qwen 2.5 7B Instruct" },
    ],
    supportsStreaming: true,
    contextWindow: 8_192,
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresApiKey: true,
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    ],
    supportsStreaming: true,
    contextWindow: 128_000,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-sonnet",
    requiresApiKey: true,
    models: [
      { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku", label: "Claude 3.5 Haiku" },
    ],
    supportsStreaming: true,
    contextWindow: 200_000,
  },
];

/** Registry ids in canonical order (derived, so it can never drift). */
export const PROVIDER_IDS: readonly string[] = PROVIDERS.map((provider) => provider.id);

/** Anthropic pins a dated API version on every request. */
const ANTHROPIC_VERSION = "2023-06-01";

/** Loopback/private hostnames that count as "local" and may use plain http. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** Type guard for a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an arbitrary value to a trimmed string (`""` when not a string). */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** First non-empty trimmed string among the candidates, else `""`. */
function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value);
    if (text !== "") return text;
  }
  return "";
}

/** Coerce an arbitrary value to a non-negative, finite, whole number. */
function nonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Parse an absolute URL, returning `null` instead of throwing. */
function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Group a non-negative integer with thousands separators (deterministic). */
function groupDigits(value: number): string {
  return Math.max(0, Math.trunc(value))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Whether a URL points at loopback, a `.local` name or an RFC1918 private
 * address — the hosts allowed to use plain `http:` and treated as "local".
 * An unparseable URL is not local.
 */
function isLocalHost(baseUrl: string): boolean {
  const parsed = safeUrl(str(baseUrl));
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "") return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (host === "host.docker.internal") return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/** Resolve a registry entry by id (trimmed); `undefined` for unknown/blank. */
export function findProvider(id: string | null | undefined): ProviderDescriptor | undefined {
  const wanted = str(id);
  if (wanted === "") return undefined;
  return PROVIDERS.find((provider) => provider.id === wanted);
}

/**
 * True when a provider runs on the operator's own infrastructure: an
 * Ollama/llama.cpp runtime (local by kind) or any descriptor whose base URL is
 * loopback/private. Cloud endpoints are `false`.
 */
export function isLocal(provider: ProviderDescriptor): boolean {
  if (!provider) return false;
  if (provider.kind === "ollama" || provider.kind === "llamacpp") return true;
  return isLocalHost(provider.baseUrl);
}

/** A normalized provider configuration, ready for `validateProviderConfig`. */
export type ProviderConfig = {
  /** Registry id of the provider. */
  providerId: string;
  /** Absolute base URL (normalized, no trailing slash). */
  baseUrl: string;
  /** Model id; parse backfills the provider default when omitted. */
  model: string;
  /** API key, or `""` when keyless/absent. Never returned to clients. */
  apiKey: string;
};

/**
 * Normalize an untrusted config (from the DB, a form field or JSON) into a
 * `ProviderConfig`, applying the documented aliases (`provider`/`providerId`,
 * `url`/`baseUrl`, `defaultModel`/`model`, `key`/`apiKey`) and backfilling the
 * provider's default model when none is given. Returns `null` when `raw` is not
 * an object, so callers can distinguish "absent" from "empty".
 */
export function parseProviderConfig(raw: unknown): ProviderConfig | null {
  if (!isRecord(raw)) return null;
  const providerId = firstString(raw.providerId, raw.provider, raw.id);
  const provider = findProvider(providerId);
  const baseUrl = normalizeBaseUrl(firstString(raw.baseUrl, raw.baseURL, raw.url));
  const model = firstString(raw.model, raw.defaultModel) || provider?.defaultModel || "";
  const apiKey = firstString(raw.apiKey, raw.key, raw.token);
  return { providerId, baseUrl, model, apiKey };
}

/** Trim a base URL, drop trailing slashes and default the scheme to https. */
function normalizeBaseUrl(value: string): string {
  const trimmed = str(value).replace(/\/+$/, "");
  if (trimmed === "") return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Why a provider config failed validation. */
export type ProviderValidationCode =
  | "unknown_provider"
  | "invalid_url"
  | "insecure_url"
  | "model_required"
  | "api_key_required";

/** One validation failure with a human-readable message. */
export type ProviderValidationError = { code: ProviderValidationCode; message: string };

/** The full verdict of `validateProviderConfig`. */
export type ProviderValidation = { ok: boolean; errors: ProviderValidationError[] };

/** Build one validation error. */
function validationError(
  code: ProviderValidationCode,
  message: string,
): ProviderValidationError {
  return { code, message };
}

/**
 * Validate a config against its registry entry without throwing. Rules:
 * the provider id must be known; the base URL must be an absolute `http(s)`
 * URL, where plain `http` is allowed only for loopback/private hosts; a model
 * must be named; and a provider that `requiresApiKey` must carry one. Every
 * failure is collected (not short-circuited) so a form can show them all.
 */
export function validateProviderConfig(
  cfg: Partial<ProviderConfig> | null | undefined,
): ProviderValidation {
  const errors: ProviderValidationError[] = [];
  const providerId = str(cfg?.providerId);
  const provider = findProvider(providerId);
  if (!provider) {
    errors.push(
      validationError("unknown_provider", `Unknown provider "${providerId || "(none)"}".`),
    );
  }

  const baseUrl = str(cfg?.baseUrl);
  const parsed = safeUrl(baseUrl);
  if (baseUrl === "" || !parsed) {
    errors.push(validationError("invalid_url", "Base URL must be an absolute http(s) URL."));
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(validationError("invalid_url", "Base URL must use the http or https scheme."));
  } else if (parsed.protocol === "http:" && !isLocalHost(baseUrl)) {
    errors.push(
      validationError(
        "insecure_url",
        "Plain http is only allowed for loopback or private endpoints.",
      ),
    );
  }

  if (str(cfg?.model) === "") {
    errors.push(validationError("model_required", "A model id is required."));
  }

  if (provider?.requiresApiKey && str(cfg?.apiKey) === "") {
    errors.push(
      validationError("api_key_required", `Provider "${provider.id}" requires an API key.`),
    );
  }

  return { ok: errors.length === 0, errors };
}

/** The request envelope `resolveChatEndpoint` hands back to a transport. */
export type ChatEndpoint = {
  /** Absolute URL to POST the chat request to. */
  url: string;
  /** Headers to send (content type plus provider-mandated auth). */
  headers: Record<string, string>;
  /** Which request-body shape the caller must build. */
  bodyShape: ChatBodyShape;
};

/** Join a base URL and a path with exactly one slash between them. */
function joinUrl(baseUrl: string, path: string): string {
  const base = str(baseUrl).replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Build the chat endpoint for a provider: `{url, headers, bodyShape}`. The
 * OpenAI-compatible and llama.cpp kinds share `/chat/completions` with an
 * optional `Authorization: Bearer` key; Ollama uses its native `/api/chat`
 * (also Bearer-capable); Anthropic uses `/messages` with `x-api-key` and its
 * pinned `anthropic-version`. The caller resolves the model separately — the
 * descriptor's `defaultModel` applies when `options.model` is omitted.
 */
export function resolveChatEndpoint(
  provider: ProviderDescriptor,
  options?: { model?: string | null; apiKey?: string | null } | null,
): ChatEndpoint {
  const kind = provider.kind;
  const apiKey = str(options?.apiKey);
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (kind === "anthropic") {
    if (apiKey !== "") headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    return { url: joinUrl(provider.baseUrl, "messages"), headers, bodyShape: "anthropic" };
  }

  if (apiKey !== "") headers.authorization = `Bearer ${apiKey}`;

  if (kind === "ollama") {
    return { url: joinUrl(provider.baseUrl, "api/chat"), headers, bodyShape: "ollama" };
  }

  return { url: joinUrl(provider.baseUrl, "chat/completions"), headers, bodyShape: "openai" };
}

/** Verdict of `estimateContextFit` for one prospective request. */
export type ContextFit = {
  /** Whether prompt + completion fit inside the context window. */
  fits: boolean;
  /** `"ok"` when it fits, `"over_context"` when it does not. */
  reason: "ok" | "over_context";
  /** `promptTokens + maxTokens` (coerced to non-negative whole numbers). */
  requested: number;
  /** The provider's context window for easy display. */
  contextWindow: number;
  /** Window headroom left after this request, clamped at 0. */
  remaining: number;
};

/**
 * Decide whether a request fits the provider's context window. `promptTokens`
 * and `maxTokens` are summed and compared against `contextWindow`
 * **inclusively** — a request that lands exactly on the window still fits.
 * Missing, negative or non-finite counts become `0`; `remaining` never goes
 * negative. Never throws.
 */
export function estimateContextFit(
  provider: ProviderDescriptor,
  request: { promptTokens?: number; maxTokens?: number } | null | undefined,
): ContextFit {
  const contextWindow = nonNegative(provider?.contextWindow);
  const requested = nonNegative(request?.promptTokens) + nonNegative(request?.maxTokens);
  const fits = requested <= contextWindow;
  return {
    fits,
    reason: fits ? "ok" : "over_context",
    requested,
    contextWindow,
    remaining: Math.max(0, contextWindow - requested),
  };
}

/**
 * One-line, human-readable provider summary for a settings row, e.g.
 * `Ollama (ollama) · local · keyless · 8,192 ctx · streaming · 3 models`.
 * Deterministic for a given descriptor; never throws.
 */
export function describeProvider(provider: ProviderDescriptor): string {
  const count = Array.isArray(provider?.models) ? provider.models.length : 0;
  return [
    `${provider.label} (${provider.id})`,
    isLocal(provider) ? "local" : "cloud",
    provider.requiresApiKey ? "API key required" : "keyless",
    `${groupDigits(nonNegative(provider.contextWindow))} ctx`,
    provider.supportsStreaming ? "streaming" : "no streaming",
    `${count} model${count === 1 ? "" : "s"}`,
  ].join(" · ");
}

/** Result of `pickProvider`: which id won and on which pass. */
export type ProviderPick = {
  /** The chosen provider id. */
  id: string;
  /** `"preference"` when it matched the caller's order, `"fallback"` otherwise. */
  source: "preference" | "fallback";
};

/** Deduplicate a list of ids, trimming and dropping blanks (order kept). */
function dedupeIds(ids: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids ?? []) {
    const id = str(raw);
    if (id !== "" && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Choose a provider deterministically. The first id in `preferences` that is
 * also in `available` wins (`source: "preference"`); otherwise the first id in
 * `options.fallback` — or, when none is given, the registry order — that is
 * available wins (`source: "fallback"`); as a last resort the lexicographically
 * first available id is used. Returns `null` only when nothing is available.
 * `available` defaults to the whole registry. Never throws.
 */
export function pickProvider(
  preferences: readonly string[] | null | undefined,
  options?: { available?: readonly string[] | null; fallback?: readonly string[] | null } | null,
): ProviderPick | null {
  const available = new Set<string>(dedupeIds(options?.available ?? PROVIDER_IDS));
  if (available.size === 0) return null;

  for (const id of dedupeIds(preferences)) {
    if (available.has(id)) return { id, source: "preference" };
  }

  const fallback = options?.fallback && options.fallback.length > 0 ? options.fallback : PROVIDER_IDS;
  for (const id of dedupeIds(fallback)) {
    if (available.has(id)) return { id, source: "fallback" };
  }

  const [first] = [...available].sort();
  return { id: first, source: "fallback" };
}

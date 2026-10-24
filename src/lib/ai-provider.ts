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
import {
  isLocalAiBaseUrl,
  isOpenCodeGoEndpoint,
  providerDefaultBaseUrl,
  normalizeBaseUrl,
} from "./ai-providers";
import { serverAppVersion } from "./app-version";
import { DEPLOYMENT_SESSION_ID, workspaceSessionId } from "./ai-session";
import { checkBudget, estimateTokens, recordUsage, type BudgetRecord } from "./ai-cost";
import { assertAiDataBoundary, logAiDiagnostic } from "./ai-boundary";
import { z } from "zod";
import { getWorkspaceAccess } from "./permissions";
import { redactSecrets } from "./error-reporting";

export const AI_NOT_CONFIGURED =
  "AI is not configured. Add a provider in workspace settings (AI) or set AI_API_KEY / AI_BASE_URL / AI_MODEL.";

export const AI_BUDGET_EXCEEDED =
  "The workspace AI token budget is exhausted for this period. Raise AI_BUDGET_TOKENS or wait for the next period.";

/* -------------------------------------------------------------------------- *
 * Provider failures
 *
 * A provider's error body is untrusted input. Several OpenAI-compatible
 * gateways (vLLM, LiteLLM, Ollama, Azure API Management) echo the API key back
 * in it — "Incorrect API key provided: sk-live-…" — so forwarding the body
 * hands out the workspace's provider key.
 *
 * A failure is therefore reduced to a class: the upstream status plus a stable
 * code. The body is parsed for that code, never forwarded, and the key we sent
 * — or a recognisable part of it — is treated as poison wherever it turns up.
 * The body itself does not reach the log either — only the status, the code
 * and the attribution of the call (the workspace, the provider, the model) do.
 * The attribution is checked against the key we sent before it is written: a
 * value that *is* the key — or a run of its characters — is left out, because
 * a scrubber knows credential shapes and not every key format.
 * -------------------------------------------------------------------------- */

/**
 * How much of a provider body is parsed (for its code).
 *
 * The body is read in full — it is never cut short on the way in — but a body
 * longer than this is not parsed at all: the provider's code is then unknown
 * and the failure falls back to the status class.
 */
const MAX_PROVIDER_BODY = 4096;

/** A provider code must look like an identifier before it may be shown. */
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Marker used when a value may neither be shown nor logged. */
const REDACTED_MARKER = "[redacted]";

/**
 * How many consecutive characters of the key count as a fingerprint of it.
 *
 * Eight is more than a coincidence between a provider's error code and a key,
 * and short enough to survive the forms in which a provider echoes the key
 * back: whole, masked ("a1b2c3d4…c5d6"), truncated or re-cased. A key
 * shorter than that is its own fingerprint.
 */
const KEY_FRAGMENT_LENGTH = 8;

/** A provider failure reduced to a class a client may see. */
export type ProviderFailure = {
  /** The status the provider answered with. */
  readonly status: number;
  /** A stable code: the provider's own when it is safe, else the status class. */
  readonly code: string;
  /** The message a client may see — never provider body text. */
  readonly message: string;
};

/**
 * What a provider failure can be attributed to — and what it is checked
 * against.
 *
 * The workspace, the provider and the model are the attribution: they say
 * whose call failed. The key is not part of it — the key is the *comparison
 * value*. A value that is the key itself, or a recognisable run of its
 * characters, is poison, and only a comparison against the key we sent can
 * tell: a scrubber knows credential *shapes*, not every key format. The key
 * therefore travels with the attribution, is read by the guard alone and is
 * never written to the log.
 */
export type ProviderAttribution = {
  /** The workspace the call was billed to; absent for the env defaults. */
  readonly workspaceId?: string;
  /** The provider's id — the workspace's provider, or `env` for the default. */
  readonly provider?: string;
  /** The model the call asked for. */
  readonly model?: string;
  /**
   * The key the call was made with — compared against, never written.
   *
   * Required on purpose: an attribution without it would let a value that
   * *is* the key into the log line, and a guard that can be left out by
   * accident is a guard that fails open.
   */
  readonly apiKey: string;
};

/** Scrub credential-shaped substrings out of a free-text value. */
function scrubText(value: string): string {
  const scrubbed = redactSecrets(value);
  return typeof scrubbed === "string" ? scrubbed : REDACTED_MARKER;
}

/**
 * True when `text` still carries the key we sent — or a recognisable part of
 * it. A provider that echoes the key back is the exact case this module has
 * to survive, so the check runs against the key itself — credential *shapes*
 * alone do not cover every provider key format.
 *
 * Every non-empty key counts, however short: a six-character key is a secret
 * too, and a length guard would switch the check off exactly where a key is
 * easiest to guess. An empty key is no secret, and `includes("")` would match
 * every text.
 *
 * The comparison is deliberately generous in both directions, because the
 * provider does not choose the spelling of its echo freely: a code that
 * *contains* the key is poison, and so is a code that *is* a piece of it. A
 * masked echo ("a1b2c3d4…c5d6"), a truncated one and a re-cased one all keep
 * a run of the key's characters — a legitimate code ("invalid_api_key") never
 * does. The comparison ignores the case: a provider that answers with the key
 * in capitals is no exot.
 *
 * The check fails closed: a legitimate code that happens to carry a fragment
 * of the key falls back to the status class.
 */
function echoesKey(text: string, apiKey: string): boolean {
  if (apiKey.length === 0) return false;
  const key = apiKey.toLowerCase();
  const needle = text.toLowerCase();

  // The whole key, in any spelling.
  if (needle.includes(key)) return true;

  // A fragment of the key: any run of consecutive key characters that is long
  // enough to be its fingerprint. For a key shorter than the fingerprint the
  // whole key is the fragment, so a short key is matched as strictly as a
  // long one.
  const fragment = Math.min(KEY_FRAGMENT_LENGTH, key.length);
  for (let start = 0; start + fragment <= key.length; start += 1) {
    if (needle.includes(key.slice(start, start + fragment))) return true;
  }
  return false;
}

/** The class a provider status belongs to, used when it sends no code. */
function statusClass(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return "invalid_request";
    case 401:
      return "authentication_failed";
    case 403:
      return "permission_denied";
    case 404:
      return "not_found";
    case 408:
    case 504:
      return "timeout";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      return "provider_error";
  }
}

/** The provider's own error code, when the body carries a safe one. */
function providerCode(body: string, apiKey: string): string | null {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_PROVIDER_BODY) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const detail =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : undefined;
  const candidates = [detail?.code, detail?.type, record.code, record.type];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (!PROVIDER_CODE_PATTERN.test(value)) continue;
    // A code that carries the key we sent — or a recognisable part of it —
    // is poison, whatever spelling the provider chose for the echo.
    if (echoesKey(value, apiKey)) continue;
    // A credential-shaped code is no code at all.
    if (scrubText(value) !== value) continue;
    return value;
  }
  return null;
}

/**
 * Reduce a provider failure to a class a client may see: the upstream status
 * plus a stable code. The body is never part of the result.
 */
export function providerFailure(
  status: number,
  body: string,
  apiKey = "",
): ProviderFailure {
  const code = providerCode(body, apiKey) ?? statusClass(status);
  return { status, code, message: `AI provider error (${status}): ${code}` };
}

/** Longest attribution value kept in the log — an id, a name, a model id. */
const MAX_LOG_CONTEXT_LENGTH = 64;

/**
 * A value that may be written to the log.
 *
 * The attribution comes from the workspace's own settings — and on two of the
 * AI routes from the request body — so it is untrusted like every other input:
 * a value that looks like a credential is dropped rather than scrubbed, a value
 * that carries the key we sent is dropped as well, and a long one is cut. A
 * missing value is left out — the log never guesses.
 *
 * The comparison against the key runs on the *whole* value, before it is cut:
 * a comparison against the shortened value would miss a fragment of the key
 * that sits behind the cut.
 */
function logContextValue(value: string | undefined, apiKey: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (scrubText(trimmed) !== trimmed) return undefined;
  // The key we sent — or a recognisable run of its characters — is poison
  // whatever shape it has: a scrubber knows credential *shapes*, not every key
  // format, so only the comparison against the key itself catches it.
  if (echoesKey(trimmed, apiKey)) return undefined;
  return trimmed.length > MAX_LOG_CONTEXT_LENGTH
    ? trimmed.slice(0, MAX_LOG_CONTEXT_LENGTH)
    : trimmed;
}

/**
 * The shape of an id this app hands out.
 *
 * `Workspace.id` is a Prisma `cuid()` (`prisma/schema.prisma`), and the ids
 * the app accepts from a client are checked the same way
 * (`z.string().cuid()` in `src/lib/validation.ts`).
 */
const WORKSPACE_ID = z.string().cuid();

/**
 * The workspace id the log may carry.
 *
 * Two of the AI routes take the workspace id from the request body, so the
 * value is chosen by the client. Only an id of the app's own shape may be
 * written: a client cannot put an arbitrary string into the operator's log,
 * and a value that is not an id is left out rather than guessed.
 */
function logWorkspaceId(value: string | undefined, apiKey: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!WORKSPACE_ID.safeParse(trimmed).success) return undefined;
  return logContextValue(trimmed, apiKey);
}

/** The attribution that is known — never a secret, never a guess. */
function logContext(context: ProviderAttribution | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  const apiKey = context?.apiKey ?? "";
  const workspaceId = logWorkspaceId(context?.workspaceId, apiKey);
  if (workspaceId) fields.workspaceId = workspaceId;
  const provider = logContextValue(context?.provider, apiKey);
  if (provider) fields.provider = provider;
  const model = logContextValue(context?.model, apiKey);
  if (model) fields.model = model;
  return fields;
}

/**
 * Record a provider failure for the operator: the status, the stable code and
 * the attribution of the call.
 *
 * The body is not logged — not even a redacted excerpt. A provider body is
 * untrusted input that may carry the workspace's key, a secret of the
 * provider's own, an internal URL or a user name; `redactSecrets` knows a
 * fixed set of credential *shapes*, so a scrubbed excerpt is "probably clean",
 * not "clean". The `code` is the stable grep anchor instead: it is either the
 * provider's own error code (`invalid_api_key`, `model_not_found`, …) or the
 * status class, and it is the very string the client is told — so one grep
 * finds both the log line and the client-visible failure.
 *
 * The attribution says *whose* call failed: the workspace, the provider and
 * the model. Without it a line is unattributable in an installation with
 * several workspaces. Neither the key nor the endpoint is ever part of it.
 */
export function logProviderFailure(
  failure: ProviderFailure,
  context?: ProviderAttribution,
): void {
  logAiDiagnostic("ai provider error", {
    status: failure.status,
    code: failure.code,
    ...logContext(context),
  });
}

/* -------------------------------------------------------------------------- *
 * Transport failures
 *
 * A transport error is untrusted text, and the runtime's own message can carry
 * the request header: an invalid header value is reported as
 * `Headers.append: "Bearer <key>" is an invalid header value.` — and that
 * header carries the workspace's key.
 *
 * Scrubbing is not enough here. `redactSecrets` knows a fixed set of
 * credential *shapes*, so a key in any other format survives it — and the tail
 * behind the invalid character is not a shape at all: `Bearer sk-live-abc\ndef`
 * keeps its `def` no matter which shapes the scrubber knows. A class carries no
 * key material whatever the key looks like, so a transport failure leaves the
 * server as a class and nothing else.
 * -------------------------------------------------------------------------- */

/** The class a transport failure leaves the server with. */
export const PROVIDER_UNREACHABLE = "Could not reach the provider.";

/** The stable code a transport failure is logged under. */
export const TRANSPORT_ERROR = "transport_error";

/**
 * A failure that is already reduced to a class a client may see.
 *
 * The provider client throws this for a provider failure (a non-2xx body):
 * its message is the class, never the provider's body. A caller that forwards
 * the message forwards a class.
 */
export class ProviderClassError extends Error {
  /**
   * Marks the error as classified. The marker — not `instanceof` — is what a
   * caller checks, so the check also holds when the module was loaded twice
   * (a re-imported route).
   */
  readonly providerClass = true;

  /** The stable code the client and the log see. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderClassError";
    this.code = code;
  }
}

/** True when the failure is already reduced to a class. */
function isProviderClassError(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { providerClass?: unknown }).providerClass === true &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/**
 * Reduce a transport failure to a class and record it for the operator.
 *
 * The log keeps the class — no message, no stack, no name: the message is
 * untrusted text that may hold the workspace's key. The code is the grep
 * anchor, the same way the provider failure's code is, and the attribution
 * says whose call failed, so a line is not ambiguous in an installation with
 * several workspaces.
 */
export function transportFailure(context?: ProviderAttribution): string {
  logAiDiagnostic("ai provider error", {
    code: TRANSPORT_ERROR,
    ...logContext(context),
  });
  return PROVIDER_UNREACHABLE;
}

/**
 * The class a failed AI call leaves the server with.
 *
 * A provider failure arrives already classified — the client sees the status
 * and the code. Everything else is a transport failure and is reduced here: a
 * class carries no key material whatever the key looks like.
 */
export function providerClass(
  error: unknown,
  context?: ProviderAttribution,
): string {
  if (isProviderClassError(error)) return error.message;
  return transportFailure(context);
}

/* -------------------------------------------------------------------------- *
 * Provider identity
 *
 * A provider should be able to tell *who* is calling it. Two headers carry
 * that, and OpenCode Go asks for both
 * (https://opencode.ai/v2/docs/console/go/):
 *
 * - `user-agent` — the product's own name and version, not the name of the
 *   HTTP library underneath. Without it the runtime fills the header in with
 *   its own name (`node`), which says nothing about the application.
 * - `x-opencode-session` — a session id that is *stable* for a conversation,
 *   so the provider can route and cache per conversation instead of per
 *   request.
 *
 * The session id is sent to Go only: it names an internal object (a
 * discussion, a workspace), and no other provider has any use for it. The ids
 * themselves live in `./ai-session` — a session names a conversation, and the
 * surface that has one knows it before the transport is reached.
 * -------------------------------------------------------------------------- */

/**
 * The user agent the provider sees: `noema/<version>`.
 *
 * The version is the one the health probe reports, so a provider log can be
 * matched against a deployment.
 */
export function providerUserAgent(): string {
  return `noema/${serverAppVersion()}`;
}

/**
 * The headers a provider request carries.
 *
 * `authorization` is the workspace's key, `user-agent` names the application,
 * and `x-opencode-session` names the conversation — the last one only to
 * OpenCode Go, which asks for it and is the only provider that reads it.
 */
export function providerRequestHeaders(
  config: { apiKey: string; baseUrl: string; sessionId?: string },
  options: { json?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": providerUserAgent(),
  };
  // A keyless local runtime (Ollama, vLLM, llama.cpp) must not receive an
  // empty `Authorization: Bearer ` header: some reject the malformed value,
  // and sending a credential-shaped header to a keyless endpoint is noise.
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  if (options.json) headers["content-type"] = "application/json";
  if (isOpenCodeGoEndpoint(config.baseUrl)) {
    headers["x-opencode-session"] = config.sessionId ?? DEPLOYMENT_SESSION_ID;
  }
  return headers;
}

export type AiRuntimeConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  source: "workspace" | "env";
  /** Workspace the call is billed to; absent for the env/global defaults. */
  workspaceId?: string;
  /**
   * The session the request belongs to, sent to OpenCode Go as
   * `x-opencode-session`. A conversation replaces it with its own id.
   */
  sessionId?: string;
};

/**
 * The attribution of a call: the workspace, the provider and the model — and
 * the key the call was made with, which is the value the guard compares
 * against.
 *
 * Only what the config knows — the endpoint is never part of it. A config
 * without a workspace (the env defaults, the admin's connection test) yields
 * an attribution without one: a missing value is left out, never guessed.
 */
export function providerAttribution(
  config: AiRuntimeConfig,
): ProviderAttribution {
  return {
    workspaceId: config.workspaceId,
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
  };
}

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
  // The model id is client-chosen (`effectiveChatModel`), so it must not be
  // part of the ceiling's identity: a caller could otherwise start a fresh
  // ledger with every model id. The provider is the workspace's configuration.
  return `${config.workspaceId ?? "env"}:${config.provider}`;
}

/** The current budget record for a config, or `null` when enforcement is off. */
function loadBudget(config: AiRuntimeConfig): BudgetRecord | null {
  const limitTokens = aiBudgetLimitTokens();
  if (limitTokens <= 0) return null;
  const key = budgetKey(config);
  const period = budgetPeriod();
  const existing = usageLedger.get(key);
  // A record from an earlier month is not this month's usage: roll it over
  // before the gate, so an exhausted October does not refuse November.
  if (existing && existing.limitTokens === limitTokens && existing.period === period) {
    return existing;
  }
  return {
    workspaceId: config.workspaceId ?? "env",
    period,
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
/** Whether a chat request may start under the current token ceiling. */
export function aiRequestBudgetAllows(
  config: AiRuntimeConfig,
  input: { system: string; user?: string; context?: string; maxTokens?: number },
): boolean {
  const budget = loadBudget(config);
  if (!budget) return true;
  return checkBudget(budget, {
    estimatedTokens: promptTokens(input) + (input.maxTokens ?? 0),
    model: config.model,
  }).allowed;
}

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
  const baseUrl = normalizeBaseUrl(
    process.env.AI_BASE_URL ?? "https://api.openai.com/v1",
  );
  const model = process.env.AI_MODEL ?? "gpt-4o-mini";
  // A remote provider needs a key. A loopback/private endpoint may be keyless
  // (Ollama, vLLM), so the env defaults support the same local story as the
  // workspace configuration.
  if (!apiKey && !isLocalAiBaseUrl(baseUrl)) return null;
  return {
    provider: "env",
    baseUrl,
    model,
    apiKey,
    source: "env",
    sessionId: DEPLOYMENT_SESSION_ID,
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
      // `decryptSecret` returns null for an absent envelope; the runtime config
      // uses an empty string for "keyless", which the header builder omits.
      const apiKey = decryptSecret(stored.apiKeyEncrypted) ?? "";
      const baseUrl = normalizeBaseUrl(stored.baseUrl ?? providerDefaultBaseUrl(stored.provider));
      // A keyless config is valid only when the endpoint is local: a remote
      // provider without a key would fail at the provider anyway, and falling
      // through to the env defaults keeps a broken workspace row from
      // shadowing a working deployment config.
      if (baseUrl && stored.model && (apiKey || isLocalAiBaseUrl(baseUrl))) {
        return {
          provider: stored.provider,
          baseUrl,
          model: stored.model,
          apiKey,
          source: "workspace",
          workspaceId,
          sessionId: workspaceSessionId(workspaceId),
        };
      }
    }
  }
  const fallback = envConfig();
  if (!fallback) return null;
  // The environment configuration is shared, but the *session* is not: a
  // workspace's requests still belong to that workspace.
  return workspaceId
    ? {
        ...fallback,
        workspaceId,
        sessionId: workspaceSessionId(workspaceId),
      }
    : fallback;
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
  // The training boundary is checked before any content is serialised: a
  // provider the operator declared as training is refused unless they also
  // opted in.
  try {
    assertAiDataBoundary(config.provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI data boundary refused the call.";
    return { ok: false, status: 403, error: message };
  }

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
      headers: providerRequestHeaders(config, { json: true }),
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
      const failure = providerFailure(response.status, text, config.apiKey);
      logProviderFailure(failure, providerAttribution(config));
      return { ok: false, status: 502, error: failure.message };
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
  } catch {
    // A transport failure: the runtime's message can carry the request header,
    // and the header carries the workspace's key. It is never forwarded — not
    // even scrubbed, since a scrubber only knows credential *shapes* and the
    // tail of a key with an interior newline is no shape at all. The class
    // goes to the client, the class goes to the log.
    return { ok: false, status: 502, error: transportFailure(providerAttribution(config)) };
  }
}

/**
 * Streaming variant: yields text deltas as the provider produces them.
 *
 * A provider failure is thrown as a class (`ProviderClassError`): the message
 * is the class, never the provider's body. A *transport* failure propagates as
 * the runtime's error — the caller must reduce it to a class before it reaches
 * a client (`providerClass`), because the runtime's message can carry the
 * request header, and the header carries the workspace's key.
 */
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
  try {
    assertAiDataBoundary(config.provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI data boundary refused the call.";
    throw new ProviderClassError("data_boundary", message);
  }

  const messages: ChatMessage[] = [{ role: "system", content: input.system }];
  if (input.context) messages.push({ role: "user", content: `Context:\n${input.context}` });
  if (input.user) messages.push({ role: "user", content: input.user });

  // The streaming transport is the ordinary chat path, so the ceiling has to
  // hold here too. The caller checks this before it opens the stream (to answer
  // 429); this is the transport's own fail-closed guard for other callers.
  const estimatedPromptTokens = promptTokens(input);
  const budget = loadBudget(config);
  if (
    budget &&
    !checkBudget(budget, {
      estimatedTokens: estimatedPromptTokens + (input.maxTokens ?? 0),
      model: config.model,
    }).allowed
  ) {
    throw new ProviderClassError("budget_exceeded", AI_BUDGET_EXCEEDED);
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: providerRequestHeaders(config, { json: true }),
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: input.temperature ?? 0.4,
      stream: true,
      ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const failure = providerFailure(response.status, detail, config.apiKey);
    logProviderFailure(failure, providerAttribution(config));
    // Thrown as a class: a caller may forward the message, and the message is
    // the class — never the provider's body.
    throw new ProviderClassError(failure.code, failure.message);
  }
  if (!response.body) {
    throw new Error("AI provider returned an empty response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputText = "";
  const record = () => {
    if (!budget) return;
    const recorded = recordUsage(budget, {
      model: config.model,
      inputTokens: estimatedPromptTokens,
      outputTokens: estimateTokens(outputText),
      surface: "chat",
      period: budgetPeriod(),
    });
    usageLedger.set(budgetKey(config), recorded);
  };
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
      if (payload === "[DONE]") {
        record();
        return;
      }
      try {
        const event = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          outputText += delta;
          yield delta;
        }
      } catch {
        // Ignore keep-alive comments and partial frames.
      }
    }
  }
  record();
}

/** Fetch the provider's live model list (falls back to the catalog upstream). */
export async function listProviderModels(
  config: { baseUrl: string; apiKey: string; modelsUrl?: string },
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(config.modelsUrl ?? `${normalizeBaseUrl(config.baseUrl)}/models`, {
      headers: providerRequestHeaders(config),
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
  } catch {
    // The transport error is untrusted text that can carry the key we sent —
    // the model list is the last AI path that still reported it verbatim. The
    // class goes to the client, the class goes to the log.
    return { ok: false, error: transportFailure() };
  }
}

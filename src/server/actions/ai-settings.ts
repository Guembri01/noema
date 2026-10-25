"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import {
  classifyAiBaseUrl,
  isLocalAiBaseUrl,
  providerDefaultBaseUrl,
  providerDefinition,
  providerForBaseUrl,
  providerModelsUrl,
} from "@/lib/ai-providers";
import { encryptSecret, maskSecret } from "@/lib/secrets";
import { chatComplete, listProviderModels, resolveAiConfig } from "@/lib/ai-provider";
import { evaluateBudget, type BudgetState } from "@/lib/ai-cost";
import {
  getWorkspaceUsageSummary,
  normalizeBudgetInput,
  resetWorkspaceUsage,
  type AiUsageSurface,
} from "@/lib/ai-metering";

export type AiProviderSummary = {
  provider: string;
  providerLabel: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyMask: string | null;
  enabled: boolean;
  /** Where the effective configuration comes from. */
  source: "workspace" | "env" | "none";
  envAvailable: boolean;
  /** True when the effective endpoint is loopback/private. */
  local: boolean;
  /** True when a working local configuration runs without a key. */
  keyless: boolean;
  /** Whether the effective endpoint requires an API key. */
  requiresKey: boolean;
  /** Where the effective request is processed (`local` never leaves the host). */
  processing: "local" | "remote" | "none";
  /** Why the stored endpoint cannot be used, when it cannot. */
  endpointError: string | null;
};

export type AiProviderResult = { ok: true } | { ok: false; error: string };

type AdminAuth =
  | { ok: false; error: string }
  | {
      ok: true;
      user: Awaited<ReturnType<typeof requireUser>>;
      access: NonNullable<Awaited<ReturnType<typeof getWorkspaceAccess>>>;
    };

async function authorizeAdmin(workspaceId: string): Promise<AdminAuth> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) {
    return { ok: false, error: "Only workspace admins can change AI settings." };
  }
  return { ok: true, user, access };
}

/**
 * Read the current AI configuration for the settings screen.
 *
 * The provider, its base URL and the model are workspace management data:
 * the settings screen only shows them to an admin, so the read asks the same
 * question — a `GUEST` (an external collaborator) never receives them.
 */
export async function getAiProviderSummary(
  workspaceId: string,
): Promise<AiProviderSummary | null> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) return null;

  const stored = await prisma.aiProviderConfig.findUnique({
    where: { workspaceId },
    select: {
      provider: true,
      baseUrl: true,
      model: true,
      apiKeyEncrypted: true,
      enabled: true,
    },
  });
  const env = await resolveAiConfig(null);
  const definition = providerDefinition(stored?.provider);

  if (!stored) {
    const envScope = env ? classifyAiBaseUrl(env.baseUrl) : null;
    const envLocal = Boolean(envScope?.ok && envScope.local);
    return {
      provider: "openai",
      providerLabel: providerDefinition("openai")?.label ?? "OpenAI",
      baseUrl: providerDefaultBaseUrl("openai"),
      model: env?.model ?? "",
      hasKey: false,
      keyMask: null,
      enabled: false,
      source: env ? "env" : "none",
      envAvailable: Boolean(env),
      local: false,
      keyless: false,
      requiresKey: true,
      processing: env ? (envLocal ? "local" : "remote") : "none",
      endpointError: null,
    };
  }

  const decrypted = stored.apiKeyEncrypted ? maskSecret("stored") : null;
  const baseUrl = stored.baseUrl ?? providerDefaultBaseUrl(stored.provider);
  const endpoint = classifyAiBaseUrl(baseUrl);
  const local = endpoint.ok && endpoint.local;
  const hasKey = Boolean(stored.apiKeyEncrypted);
  // Local endpoints are the one safe keyless case: the request never leaves
  // the operator's network. A remote endpoint still needs its key.
  const workspaceReady =
    stored.enabled && endpoint.ok && Boolean(stored.model) && (hasKey || local);
  const effectiveBaseUrl = workspaceReady ? baseUrl : env?.baseUrl;
  const effectiveScope = effectiveBaseUrl ? classifyAiBaseUrl(effectiveBaseUrl) : null;
  return {
    provider: stored.provider,
    providerLabel: definition?.label ?? stored.provider,
    baseUrl,
    model: stored.model ?? "",
    hasKey,
    keyMask: decrypted,
    enabled: stored.enabled,
    source: workspaceReady ? "workspace" : env ? "env" : "none",
    envAvailable: Boolean(env),
    local,
    keyless: workspaceReady && local && !hasKey,
    requiresKey: !local,
    processing: workspaceReady
      ? local
        ? "local"
        : "remote"
      : env
        ? effectiveScope?.ok && effectiveScope.local
          ? "local"
          : "remote"
        : "none",
    endpointError: endpoint.ok ? null : endpoint.error,
  };
}

/** Save (or clear) the workspace AI provider. */
export async function saveAiProviderAction(input: {
  workspaceId: string;
  provider: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
  clearKey?: boolean;
}): Promise<AiProviderResult> {
  const auth = await authorizeAdmin(input.workspaceId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const definition = providerDefinition(input.provider);
  if (!definition) return { ok: false, error: "Unknown provider." };

  // The endpoint is validated for every provider, not only `custom`: a named
  // provider may be overridden with a local URL, and a stored endpoint must
  // never be a `file:` URL or carry a credential in its user info/query.
  const rawBaseUrl = (input.baseUrl ?? "").trim() || definition.defaultBaseUrl;
  const endpoint = classifyAiBaseUrl(rawBaseUrl);
  if (!endpoint.ok) return { ok: false, error: endpoint.error };
  const baseUrl = endpoint.url;
  const local = endpoint.local;
  const model = (input.model ?? "").trim().slice(0, 120);

  const existing = await prisma.aiProviderConfig.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { provider: true, baseUrl: true, apiKeyEncrypted: true },
  });
  const existingLocal = isLocalAiBaseUrl(
    existing?.baseUrl ?? providerDefaultBaseUrl(existing?.provider ?? ""),
  );
  // Preserve a stored key only for the same provider on the same side of the
  // local/remote boundary. Carrying a remote key to a local endpoint (or a
  // local token to a remote one) would send a credential where it does not
  // belong; switching provider invalidates the old key anyway.
  const canPreserveKey =
    Boolean(existing) && existing?.provider === input.provider && existingLocal === local;
  const incomingKey = (input.apiKey ?? "").trim();
  const apiKeyEncrypted = input.clearKey
    ? null
    : incomingKey
      ? encryptSecret(incomingKey)
      : canPreserveKey
        ? existing?.apiKeyEncrypted ?? null
        : null;

  const enabled = input.enabled ?? true;
  // A key is required only for a remote endpoint. A loopback/private provider
  // (Ollama, vLLM, llama.cpp, LM Studio) is keyless by design.
  if (enabled && !local && !apiKeyEncrypted) {
    return {
      ok: false,
      error: "Add an API key before enabling a remote provider.",
    };
  }
  if (enabled && !model) {
    return { ok: false, error: "Choose a model before enabling this provider." };
  }

  await prisma.aiProviderConfig.upsert({
    where: { workspaceId: input.workspaceId },
    create: {
      workspaceId: input.workspaceId,
      provider: input.provider,
      baseUrl,
      model: model || null,
      apiKeyEncrypted,
      enabled,
      updatedById: auth.user.id,
    },
    update: {
      provider: input.provider,
      baseUrl,
      model: model || null,
      apiKeyEncrypted,
      enabled,
      updatedById: auth.user.id,
    },
  });

  revalidatePath("/w", "layout");
  return { ok: true };
}

/** Disconnect the workspace provider (the env defaults take over again). */
export async function clearAiProviderAction(workspaceId: string): Promise<AiProviderResult> {
  const auth = await authorizeAdmin(workspaceId);
  if (!auth.ok) return { ok: false, error: auth.error };
  await prisma.aiProviderConfig.deleteMany({ where: { workspaceId } });
  revalidatePath("/w", "layout");
  return { ok: true };
}

export type AiModelsResult =
  | { ok: true; models: string[]; source: "live" | "catalog" }
  | { ok: false; error: string };

/** Live model list from the provider, falling back to the curated catalog. */
export async function listAiModelsAction(input: {
  workspaceId: string;
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<AiModelsResult> {
  const auth = await authorizeAdmin(input.workspaceId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const definition = providerDefinition(input.provider);
  const catalog = definition?.models.map((model) => model.id) ?? [];
  const rawBaseUrl = (input.baseUrl ?? "").trim() || definition?.defaultBaseUrl || "";
  const endpoint = classifyAiBaseUrl(rawBaseUrl);
  if (!endpoint.ok) return { ok: false, error: endpoint.error };
  const baseUrl = endpoint.url;

  // A "custom" endpoint that is really a documented provider keeps that
  // provider's catalogue — and its catalogue URL. Go publishes its model list
  // under `/inference/go/v1/models` while its chat endpoint lives under
  // `…/openai/v1`; asking the chat endpoint's path answers 404.
  const effective =
    input.provider === "custom" ? (providerForBaseUrl(baseUrl) ?? "custom") : input.provider;
  const modelsUrl = providerModelsUrl(effective, baseUrl);

  let apiKey = (input.apiKey ?? "").trim();
  if (!apiKey) {
    const stored = await prisma.aiProviderConfig.findUnique({
      where: { workspaceId: input.workspaceId },
      select: { apiKeyEncrypted: true },
    });
    const { decryptSecret } = await import("@/lib/secrets");
    apiKey = decryptSecret(stored?.apiKeyEncrypted) ?? "";
  }
  // A local endpoint can list its models keylessly (`GET /v1/models` is open
  // on Ollama/vLLM). A remote one still needs the key.
  if (!apiKey && !endpoint.local) {
    return catalog.length > 0
      ? { ok: true, models: catalog, source: "catalog" }
      : { ok: false, error: "Add an API key to list models for this provider." };
  }

  const live = await listProviderModels({ baseUrl, apiKey, modelsUrl });
  if (live.ok) {
    // Keep the curated labels for models we know, append anything new.
    const known = new Set(catalog);
    return {
      ok: true,
      models: [...catalog, ...live.models.filter((id) => !known.has(id))],
      source: "live",
    };
  }
  if (catalog.length > 0) return { ok: true, models: catalog, source: "catalog" };
  return { ok: false, error: live.error };
}

export type AiTestResult =
  | { ok: true; model: string; provider: string; ms: number; sample: string }
  | { ok: false; error: string };

/** Send a one-token prompt to verify the configuration end to end. */
export async function testAiProviderAction(input: {
  workspaceId: string;
  provider: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<AiTestResult> {
  const auth = await authorizeAdmin(input.workspaceId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const definition = providerDefinition(input.provider);
  if (!definition) return { ok: false, error: "Unknown provider." };

  const endpoint = classifyAiBaseUrl(
    (input.baseUrl ?? "").trim() || definition.defaultBaseUrl,
  );
  if (!endpoint.ok) return { ok: false, error: endpoint.error };
  const baseUrl = endpoint.url;
  const model = (input.model ?? "").trim();
  if (!model) return { ok: false, error: "Choose a model to test." };

  let apiKey = (input.apiKey ?? "").trim();
  if (!apiKey) {
    const stored = await prisma.aiProviderConfig.findUnique({
      where: { workspaceId: input.workspaceId },
      select: { apiKeyEncrypted: true },
    });
    const { decryptSecret } = await import("@/lib/secrets");
    apiKey = decryptSecret(stored?.apiKeyEncrypted) ?? "";
  }
  // Keyless is allowed only for a local endpoint. A remote provider without a
  // key is a configuration error, and the test says so instead of issuing an
  // unauthenticated request that can only fail.
  if (!apiKey && !endpoint.local) return { ok: false, error: "Add an API key first." };

  const started = Date.now();
  const result = await chatComplete(
    {
      system: "Reply with exactly: OK",
      user: "ping",
      temperature: 0,
      maxTokens: 8,
    },
    { provider: input.provider, baseUrl, model, apiKey, source: "workspace", workspaceId: input.workspaceId },
    // The admin's connection test stays available when the budget is spent
    // (O25.3); it is still metered under `test`.
    { surface: "test", userId: auth.user.id, bypassBudget: true },
  );
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    provider: definition.label,
    model,
    ms: Date.now() - started,
    sample: result.text.trim().slice(0, 40),
  };
}

/* -------------------------------------------------------------------------- *
 * AI usage & budget (R25.12–R25.14)
 * -------------------------------------------------------------------------- */

export type AiBudgetSummary = {
  /** UTC calendar month (`YYYY-MM`) the numbers belong to. */
  period: string;
  /** False when the workspace has never saved a budget row. */
  configured: boolean;
  monthlyTokenLimit: number;
  warnPercent: number;
  hardStop: boolean;
  tokensIn: number;
  tokensOut: number;
  usedTokens: number;
  requests: number;
  failures: number;
  remainingTokens: number;
  /** Whole-number share of the limit already used (0 when unlimited). */
  percent: number;
  state: BudgetState | "unset";
  bySurface: AiUsageSurface[];
};

/**
 * Read the settings dashboard for one workspace.
 *
 * Gated exactly like the provider settings: a non-manager (including a GUEST,
 * or a member of a different workspace) receives `null`, so the read never
 * leaks another workspace's spend. Authorization is checked before the usage
 * query runs, and every query is scoped to `workspaceId`.
 */
export async function getAiBudgetSummary(
  workspaceId: string,
): Promise<AiBudgetSummary | null> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canManageMembers(access.role)) return null;

  const usage = await getWorkspaceUsageSummary(workspaceId);
  const verdict = evaluateBudget({
    usedTokens: usage.usedTokens,
    limitTokens: usage.budget.monthlyTokenLimit,
    warnPercent: usage.budget.warnPercent,
    hardStop: usage.budget.hardStop,
  });

  return {
    period: usage.period,
    configured: usage.budget.configured,
    monthlyTokenLimit: usage.budget.monthlyTokenLimit,
    warnPercent: usage.budget.warnPercent,
    hardStop: usage.budget.hardStop,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    usedTokens: usage.usedTokens,
    requests: usage.requests,
    failures: usage.failures,
    remainingTokens: verdict.remainingTokens,
    percent: verdict.percent,
    state:
      usage.budget.monthlyTokenLimit > 0 ? verdict.state : "unset",
    bySurface: usage.bySurface,
  };
}

/**
 * Save the workspace budget. Manager-only; the ceiling, warning threshold and
 * hard-stop switch are validated before anything is written. `0` disables the
 * ceiling, which is the safe way to "soft-disable" enforcement without losing
 * the usage history.
 */
export async function saveAiBudgetAction(input: {
  workspaceId: string;
  monthlyTokenLimit: number;
  warnPercent?: number;
  hardStop?: boolean;
}): Promise<AiProviderResult> {
  const auth = await authorizeAdmin(input.workspaceId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const parsed = normalizeBudgetInput({
    monthlyTokenLimit: input.monthlyTokenLimit,
    warnPercent: input.warnPercent,
    hardStop: input.hardStop,
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  await prisma.aiBudget.upsert({
    where: { workspaceId: input.workspaceId },
    create: {
      workspaceId: input.workspaceId,
      monthlyTokenLimit: parsed.value.monthlyTokenLimit,
      warnPercent: parsed.value.warnPercent,
      hardStop: parsed.value.hardStop,
      updatedById: auth.user.id,
    },
    update: {
      monthlyTokenLimit: parsed.value.monthlyTokenLimit,
      warnPercent: parsed.value.warnPercent,
      hardStop: parsed.value.hardStop,
      updatedById: auth.user.id,
    },
  });

  revalidatePath("/w", "layout");
  return { ok: true };
}

export type AiBudgetResetResult =
  | { ok: true; removed: number }
  | { ok: false; error: string };

/**
 * Clear the current month's usage counters so an admin can start the period
 * over (for example after a runaway loop was fixed). Manager-only; the next
 * calendar month rolls over automatically because every counter is period-keyed.
 */
export async function resetAiUsageAction(
  workspaceId: string,
): Promise<AiBudgetResetResult> {
  const auth = await authorizeAdmin(workspaceId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const removed = await resetWorkspaceUsage(workspaceId);
  revalidatePath("/w", "layout");
  return { ok: true, removed };
}


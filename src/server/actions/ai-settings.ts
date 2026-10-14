"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { AI_PROVIDERS, normalizeBaseUrl, providerDefaultBaseUrl, providerDefinition } from "@/lib/ai-providers";
import { encryptSecret, maskSecret } from "@/lib/secrets";
import { chatComplete, listProviderModels, resolveAiConfig } from "@/lib/ai-provider";

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

/** Read the current AI configuration for the settings screen. */
export async function getAiProviderSummary(
  workspaceId: string,
): Promise<AiProviderSummary | null> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return null;

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
    };
  }

  const decrypted = stored.apiKeyEncrypted ? maskSecret("stored") : null;
  const workspaceReady = stored.enabled && Boolean(stored.apiKeyEncrypted) && Boolean(stored.model);
  return {
    provider: stored.provider,
    providerLabel: definition?.label ?? stored.provider,
    baseUrl: stored.baseUrl ?? providerDefaultBaseUrl(stored.provider),
    model: stored.model ?? "",
    hasKey: Boolean(stored.apiKeyEncrypted),
    keyMask: decrypted,
    enabled: stored.enabled,
    source: workspaceReady ? "workspace" : env ? "env" : "none",
    envAvailable: Boolean(env),
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

  const baseUrl = normalizeBaseUrl(input.baseUrl ?? "") || definition.defaultBaseUrl;
  if (input.provider === "custom" && !baseUrl) {
    return { ok: false, error: "A custom provider needs a base URL." };
  }
  const model = (input.model ?? "").trim().slice(0, 120);

  const existing = await prisma.aiProviderConfig.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { apiKeyEncrypted: true },
  });
  const apiKeyEncrypted = input.clearKey
    ? null
    : input.apiKey && input.apiKey.trim()
      ? encryptSecret(input.apiKey.trim())
      : existing?.apiKeyEncrypted ?? null;

  const enabled = input.enabled ?? true;
  if (enabled && !apiKeyEncrypted) {
    return { ok: false, error: "Add an API key before enabling this provider." };
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
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? "") || definition?.defaultBaseUrl || "";

  let apiKey = (input.apiKey ?? "").trim();
  if (!apiKey) {
    const stored = await prisma.aiProviderConfig.findUnique({
      where: { workspaceId: input.workspaceId },
      select: { apiKeyEncrypted: true },
    });
    const { decryptSecret } = await import("@/lib/secrets");
    apiKey = decryptSecret(stored?.apiKeyEncrypted) ?? "";
  }
  if (!apiKey) {
    return catalog.length > 0
      ? { ok: true, models: catalog, source: "catalog" }
      : { ok: false, error: "Add an API key to list models for this provider." };
  }

  const live = await listProviderModels({ baseUrl, apiKey });
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

  const baseUrl = normalizeBaseUrl(input.baseUrl ?? "") || definition.defaultBaseUrl;
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
  if (!apiKey) return { ok: false, error: "Add an API key first." };

  const started = Date.now();
  const result = await chatComplete(
    {
      system: "Reply with exactly: OK",
      user: "ping",
      temperature: 0,
      maxTokens: 8,
    },
    { provider: input.provider, baseUrl, model, apiKey, source: "workspace" },
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


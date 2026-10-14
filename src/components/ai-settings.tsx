"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Plug, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  clearAiProviderAction,
  listAiModelsAction,
  saveAiProviderAction,
  testAiProviderAction,
  type AiProviderSummary,
} from "@/server/actions/ai-settings";
import { AI_PROVIDERS, providerDefaultBaseUrl, type ProviderDefinition } from "@/lib/ai-providers";
import {safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";


/**
 * Workspace AI provider settings: pick OpenAI / DeepSeek / Gemini / a custom
 * OpenAI-compatible endpoint, fetch the live model list, store the key
 * encrypted, and test the connection before saving.
 */
export function AiSettings({
  workspaceId,
  summary,
  locale,
}: {
  workspaceId: string;
  summary: AiProviderSummary;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [provider, setProvider] = useState(summary.provider);
  const [baseUrl, setBaseUrl] = useState(summary.baseUrl);
  const [model, setModel] = useState(summary.model);
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(summary.enabled);
  const [models, setModels] = useState<string[]>(
    AI_PROVIDERS.find((entry) => entry.id === summary.provider)?.models.map((m) => m.id) ?? [],
  );
  const [status, setStatus] = useState<string | null>(null);

  const definition: ProviderDefinition | undefined = AI_PROVIDERS.find(
    (entry) => entry.id === provider,
  );

  // Reset the form when the provider changes.
  useEffect(() => {
    const next = AI_PROVIDERS.find((entry) => entry.id === provider);
    setModels(next?.models.map((m) => m.id) ?? []);
    if (next) {
      setBaseUrl(providerDefaultBaseUrl(provider));
      if (next.models.length > 0 && !next.models.some((m) => m.id === model)) {
        setModel(next.models[0].id);
      }
    }
    setStatus(null);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (label: string, task: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const outcome = await safeAction(task);
      const value = outcome.ok ? outcome.value : { ok: false, message: outcome.error };
      setStatus(value.message);
      if (value.ok) toast.success(label);
      else toast.error(value.message);
    });

  const fetchModels = () =>
    run(t(locale, "modelListRefreshed"), async () => {
      const result = await listAiModelsAction({ workspaceId, provider, baseUrl, apiKey });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      setModels(result.models);
      if (!result.models.includes(model) && result.models[0]) setModel(result.models[0]);
      return { ok: true, message: `${result.models.length} ${t(locale, "modelsCount")} (${result.source})` };
    });

  const test = () =>
    run(t(locale, "connectionOk"), async () => {
      const result = await testAiProviderAction({ workspaceId, provider, baseUrl, model, apiKey });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      return { ok: true, message: `${result.provider} · ${result.model} · ${result.ms} ms · "${result.sample}"` };
    });

  const save = () =>
    run(t(locale, "aiProviderSaved"), async () => {
      const result = await saveAiProviderAction({
        workspaceId,
        provider,
        baseUrl,
        model,
        apiKey: apiKey || undefined,
        enabled,
      });
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      setApiKey("");
      router.refresh();
      return { ok: true, message: t(locale, "savedWord") };
    });

  const clear = () =>
    run(t(locale, "providerRemoved"), async () => {
      const result = await clearAiProviderAction(workspaceId);
      if ("error" in result) return { ok: false, message: result.error };
      if (!result.ok) return { ok: false, message: t(locale, "somethingWentWrong") };
      setEnabled(false);
      setApiKey("");
      router.refresh();
      return { ok: true, message: t(locale, "providerRemovedMsg") };
    });

  return (
    <section className="mt-10">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <Plug className="h-4 w-4" /> {t(locale, "aiProvider")}
      </h2>
      <p className="mb-4 text-sm text-muted">
        {t(locale, "aiSettingsIntro")}
      </p>

      <p className="mb-4 text-xs text-muted">
        {t(locale, "activeSource")}{" "}
        <strong className="text-fg">
          {summary.source === "workspace"
            ? `${t(locale, "sourceWorkspace")} · ${summary.providerLabel}`
            : summary.source === "env"
              ? t(locale, "sourceEnv")
              : t(locale, "notConfigured")}
        </strong>
        {summary.hasKey && summary.keyMask ? ` · ${t(locale, "keyStored")}` : ""}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "providerLabel")}
          <select
            value={provider}
            aria-label={t(locale, "aiProvider")}
            onChange={(event) => setProvider(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
          >
            {AI_PROVIDERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "modelLabel")}
          <span className="mt-1 flex gap-1">
            <select
              value={model}
              aria-label={t(locale, "aiModel")}
              onChange={(event) => setModel(event.target.value)}
              className="h-9 w-full rounded border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
            >
              {models.length === 0 && <option value="">{t(locale, "typeModelBelow")}</option>}
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </span>
          <input
            value={model}
            aria-label={t(locale, "modelIdLabel")}
            placeholder={t(locale, "modelIdPlaceholder")}
            onChange={(event) => setModel(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>

        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "baseUrlLabel")}
          <input
            value={baseUrl}
            aria-label={t(locale, "aiBaseUrl")}
            placeholder={definition?.defaultBaseUrl ?? "https://…/v1"}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>

        <label className="text-xs font-medium uppercase tracking-wide text-muted">
          {t(locale, "apiKeyLabel")}
          <input
            type="password"
            value={apiKey}
            aria-label={t(locale, "aiApiKey")}
            placeholder={summary.hasKey ? t(locale, "savedKeyHint") : definition?.keyHint ?? t(locale, "apiKeyLabel")}
            onChange={(event) => setApiKey(event.target.value)}
            className="mt-1 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          aria-label={t(locale, "enableProviderAria")}
          onChange={(event) => setEnabled(event.target.checked)}
          className="accent-[var(--accent)]"
        />
        {t(locale, "useProviderForWorkspace")}
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={fetchModels}
          className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" /> {t(locale, "fetchModels")}
        </button>
        <button
          type="button"
          disabled={pending || !model}
          onClick={test}
          className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          {t(locale, "testConnection")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="h-9 rounded bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          {t(locale, "save")}
        </button>
        {summary.hasKey && (
          <button
            type="button"
            disabled={pending}
            onClick={clear}
            className="flex h-9 items-center gap-1 rounded border border-border px-3 text-sm text-muted hover:text-red-500 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> {t(locale, "remove")}
          </button>
        )}
      </div>

      {status && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <CheckCircle2 className="h-3.5 w-3.5" /> {status}
        </p>
      )}
      {!summary.envAvailable && !summary.hasKey && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <TriangleAlert className="h-3.5 w-3.5" /> {t(locale, "aiNoProviderHint")}
        </p>
      )}
    </section>
  );
}
